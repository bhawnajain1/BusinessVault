// §17 Reconciliation after high-risk operations.
//
// After an invoice edit / recycle / restore, a sales return / cancel, a
// purchase reversal, or a payment refund, we run a consistency check on the
// authoritative journal + party ledger, and — if it fails — record a
// durable `reconciliation.failed` row in `audit_log` and a structured
// `log.warn` in `debug_logs`. The feedback spec is explicit that failures
// must NOT be silently hidden.
//
// This helper is deliberately non-fatal: an unbalanced state is reported,
// not thrown, so the calling op can complete and the user isn't blocked
// from continuing to work. The audit_log entry and debug bundle carry the
// evidence forward for support triage.

import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import { db as defaultDb } from '../db';
import { accountingSelfCheck } from './AccountingService';
import { computeReceivables } from './partyLedger';
import { log } from '../lib/log';
import type { AuditLogEntry, Invoice } from '../db/types';

// The 9 §17 operations, plus a generic "drive.restore" for parity with the
// existing rebuildFromDrive call site. Names are stable — they land in
// audit_log.action and in log source strings.
export type ReconcileOp =
  | 'invoice.edit'
  | 'invoice.recycle'
  | 'invoice.restore'
  | 'payment.refund'
  | 'payment.recycle'
  | 'payment.restore'
  | 'sales_return.create'
  | 'sales_return.cancel'
  | 'purchase.recycle'
  | 'purchase.restore'
  | 'drive.restore';

export interface ReconcileOpts {
  db?: BusinessVaultDB;
  operationId?: string;
  // Optional device id — falls back to 'unknown' if not passed. Callers
  // that have already resolved a device (e.g. from the current session)
  // should pass it so the audit trail is complete.
  deviceId?: string;
}

export interface ReconcileResult {
  ok: boolean;
  accounting: {
    balanced: boolean;
    totalDebits: number;
    totalCredits: number;
    unbalancedEntryCount: number;
  };
  receivables: {
    total_paise: number;
    customer_count: number;
  };
  failures: string[];
}

/**
 * Run the standard §17 consistency checks for `businessId` after `op`.
 *
 * On failure:
 *   - writes a `reconciliation.failed` row into `audit_log`
 *   - emits a structured `log.warn('reconciliation', ...)` entry
 * On success:
 *   - emits a `log.info` breadcrumb (helps trace which ops were verified
 *     during a support-bundle timeline).
 *
 * Never throws — callers are on their happy path and MUST not roll back
 * the domain op just because a post-hoc invariant check tripped. The
 * durable audit_log + debug_log entries are how failures are surfaced.
 */
export async function reconcileAfter(
  businessId: string,
  op: ReconcileOp,
  opts: ReconcileOpts = {},
): Promise<ReconcileResult> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const operationId = opts.operationId;
  const deviceId = opts.deviceId ?? 'unknown';

  log.debug('reconciliation.start', op, { businessId, operationId });

  const failures: string[] = [];

  const acct = await accountingSelfCheck(businessId, { db });
  const accountingBalanced =
    acct.debitsEqCredits && acct.unbalancedEntries.length === 0;
  if (!accountingBalanced) {
    failures.push(
      `accounting: debits (${acct.totalDebits}) != credits (${acct.totalCredits}); ${acct.unbalancedEntries.length} unbalanced entries`,
    );
  }

  // Receivables sanity — computeReceivables is a pure fn over invoices + the
  // paid_paise cache. If the cache drifted (e.g. an edit path forgot to
  // recompute), the sum won't line up with the outstanding invoices. This
  // is a soft check: computeReceivables always returns a number, but if
  // per-customer breakdown is inconsistent with totals we surface it.
  const invoices: Invoice[] = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  const asOfYmd = new Date().toISOString().slice(0, 10);
  const salesReturns = await db.sales_returns
    .where('business_id')
    .equals(businessId)
    .toArray();
  const receivables = computeReceivables(
    invoices,
    asOfYmd,
    [],
    [],
    salesReturns,
  );
  const perCustomerSum = receivables.perCustomer.reduce(
    (s, c) => s + c.outstanding_paise,
    0,
  );
  if (perCustomerSum !== receivables.totals.outstanding_paise) {
    failures.push(
      `receivables: sum-per-customer (${perCustomerSum}) != totals.outstanding (${receivables.totals.outstanding_paise})`,
    );
  }

  const result: ReconcileResult = {
    ok: failures.length === 0,
    accounting: {
      balanced: accountingBalanced,
      totalDebits: acct.totalDebits,
      totalCredits: acct.totalCredits,
      unbalancedEntryCount: acct.unbalancedEntries.length,
    },
    receivables: {
      total_paise: receivables.totals.outstanding_paise,
      customer_count: receivables.perCustomer.length,
    },
    failures,
  };

  if (result.ok) {
    log.info('reconciliation.ok', op, {
      businessId,
      operationId,
      totalDebits: result.accounting.totalDebits,
      totalCredits: result.accounting.totalCredits,
    });
    return result;
  }

  // Failure path: log AND persist.
  log.warn('reconciliation.failed', op, {
    businessId,
    operationId,
    failures,
    accounting: result.accounting,
    receivables: result.receivables,
  });

  try {
    const entry: AuditLogEntry = {
      id: ulid(),
      business_id: businessId,
      device_id: deviceId,
      actor: 'system',
      action: 'reconciliation.failed',
      entity_type: 'business',
      entity_id: businessId,
      before: null,
      after: {
        op,
        operationId: operationId ?? null,
        failures,
        accounting: result.accounting,
        receivables: result.receivables,
      },
      at: new Date().toISOString(),
    };
    await db.audit_log.add(entry);
  } catch (e) {
    // Even the audit write failing shouldn't blow up the domain op. Log
    // and move on.
    log.error('reconciliation.audit_write_failed', op, {
      businessId,
      operationId,
      error: e,
    });
  }

  return result;
}
