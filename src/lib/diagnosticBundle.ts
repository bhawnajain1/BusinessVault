// §16 Diagnostic Report bundle.
//
// A single JSON file the user can download from Settings → Support / Diagnostics
// and mail to the developer when reporting a bug. Includes the last ~24 h of
// diagnostic logs plus enough environmental context to reproduce or triage
// without needing to ask follow-up questions:
//
//   - App version + build mode (production / dev)
//   - Dexie schema version + business.schema_version
//   - Browser / platform user-agent
//   - Business metadata (id, name, drive_connected_email; NO signature blob)
//   - Recent audit_log rows (last 100) — for the operation causing the bug
//   - Recent Drive backup / restore log rows (grepped from debug_logs)
//   - Reconciliation snapshot (Trial-Balance debits/credits, receivable sums)
//     — kept as a shallow numeric summary; no PII.
//   - The full debug_log ring
//
// Sensitive fields are already stripped by log.ts' redaction pass; this
// module never touches OAuth tokens, refresh tokens, signature attachments,
// or bank credentials directly — see §15 "Never log" list.

import { db } from '../db';
import { log } from './log';
import { computeReceivables } from '../domain/partyLedger';
import { accountingSelfCheck } from '../domain/AccountingService';
import type { AuditLogEntry, Business, DebugLogEntry } from '../db/types';

// Vite injects `__APP_VERSION__` at build time via `define:` in vite.config.ts;
// see the declare at the bottom of this file. In test/Node runners the define
// is absent, so fall back to '0.0.0'.
declare const __APP_VERSION__: string;
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

export interface DiagnosticReport {
  generated_at: string;
  app: {
    version: string;
    build_mode: 'production' | 'development';
    user_agent: string;
    platform: string;
    language: string;
  };
  schema: {
    dexie_verno: number;
    business_schema_version: number | null;
  };
  business: {
    id: string;
    name: string;
    state_code: string;
    financial_year_start_month: number;
    drive_connected: boolean;
    drive_connected_email: string | null;
  } | null;
  reconciliation: {
    trial_balance_debits_paise: number;
    trial_balance_credits_paise: number;
    trial_balance_balanced: boolean;
    receivables_total_paise: number;
    receivables_by_customer_count: number;
    errors: string[];
  } | null;
  drive: {
    recent_backup_events: DebugLogEntry[];
    recent_restore_events: DebugLogEntry[];
  };
  audit_log_recent: AuditLogEntry[];
  debug_log: DebugLogEntry[];
}

export interface BuildDiagnosticReportOpts {
  logWindowMs?: number;
  auditLogLimit?: number;
}

export async function buildDiagnosticReport(
  opts: BuildDiagnosticReportOpts = {},
): Promise<DiagnosticReport> {
  const logWindowMs = opts.logWindowMs ?? 24 * 60 * 60 * 1000;
  const auditLimit = opts.auditLogLimit ?? 100;

  await log.flush();

  const generated_at = new Date().toISOString();
  const build_mode: 'production' | 'development' =
    typeof import.meta !== 'undefined' && import.meta.env?.DEV ? 'development' : 'production';

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  const platform =
    typeof navigator !== 'undefined' ? (navigator as { platform?: string }).platform ?? 'unknown' : 'unknown';
  const language = typeof navigator !== 'undefined' ? navigator.language : 'unknown';

  const businessRow: Business | undefined = await db.businesses
    .toCollection()
    .first();

  const businessBlock = businessRow
    ? {
        id: businessRow.id,
        name: businessRow.name,
        state_code: businessRow.state_code,
        financial_year_start_month: businessRow.financial_year_start_month,
        drive_connected: businessRow.drive_folder_id != null,
        drive_connected_email: businessRow.drive_connected_email ?? null,
      }
    : null;

  let reconciliation: DiagnosticReport['reconciliation'] = null;
  if (businessRow) {
    try {
      const check = await accountingSelfCheck(businessRow.id, { db });
      const invoices = await db.invoices
        .where('business_id')
        .equals(businessRow.id)
        .toArray();
      const asOfYmd = new Date().toISOString().slice(0, 10);
      const receivables = computeReceivables(invoices, asOfYmd);
      reconciliation = {
        trial_balance_debits_paise: check.totalDebits,
        trial_balance_credits_paise: check.totalCredits,
        trial_balance_balanced: check.debitsEqCredits,
        receivables_total_paise: receivables.totals.outstanding_paise,
        receivables_by_customer_count: receivables.perCustomer.length,
        errors: check.unbalancedEntries,
      };
    } catch (e) {
      log.warn('diagnostic', 'reconciliation snapshot failed', { error: e });
      reconciliation = {
        trial_balance_debits_paise: 0,
        trial_balance_credits_paise: 0,
        trial_balance_balanced: false,
        receivables_total_paise: 0,
        receivables_by_customer_count: 0,
        errors: [String(e)],
      };
    }
  }

  const cutoff = new Date(Date.now() - logWindowMs).toISOString();
  const allRecent = await db.debug_logs.where('ts').above(cutoff).toArray();
  // Bucket by source OR msg — callers use either shape:
  //   log.info('drive.backup', 'started', {...})            source == 'drive.backup'
  //   log.info('drive.provider', 'writeSnapshot begin', {}) msg contains 'snapshot'
  const isBackup = (r: DebugLogEntry): boolean =>
    r.source.startsWith('drive.backup') ||
    r.msg.startsWith('drive.backup') ||
    (r.source === 'drive.provider' && /snapshot|backup/i.test(r.msg));
  const isRestore = (r: DebugLogEntry): boolean =>
    r.source.startsWith('drive.restore') ||
    r.msg.startsWith('drive.restore') ||
    (r.source === 'drive.provider' && /restore/i.test(r.msg));
  const recent_backup_events = allRecent.filter(isBackup);
  const recent_restore_events = allRecent.filter(isRestore);

  const audit_log_recent = businessRow
    ? await db.audit_log
        .where('[business_id+at]')
        .between([businessRow.id, ''], [businessRow.id, '￿'])
        .reverse()
        .limit(auditLimit)
        .toArray()
    : [];

  return {
    generated_at,
    app: {
      version: APP_VERSION,
      build_mode,
      user_agent: ua,
      platform,
      language,
    },
    schema: {
      dexie_verno: db.verno,
      business_schema_version: businessRow?.schema_version ?? null,
    },
    business: businessBlock,
    reconciliation,
    drive: {
      recent_backup_events,
      recent_restore_events,
    },
    audit_log_recent,
    debug_log: allRecent,
  };
}

export async function downloadDiagnosticReport(
  opts?: BuildDiagnosticReportOpts,
): Promise<void> {
  try {
    log.info('diagnostic', 'user requested diagnostic bundle', {});
    const report = await buildDiagnosticReport(opts);
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `businessvault-diagnostic-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    log.error('diagnostic', 'diagnostic bundle failed', { error: e });
    throw e;
  }
}

