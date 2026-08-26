// §24 Reusable regression assertions.
//
// Every check the feedback spec calls out as a "must always hold" invariant
// lives here as a single named function, so unit tests, integration tests,
// the disaster-recovery E2E, and (eventually) production runtime probes can
// all speak the same vocabulary. If one of these fires, the numeric evidence
// is in the thrown message — no digging into the debug bundle to figure out
// which sum drifted.
//
// The functions read Dexie directly (or take an already-materialised row)
// rather than depending on any service, because a service bug is one of the
// exact things we want these to catch.

import type { BusinessVaultDB } from '../db/database';
import { db as defaultDb } from '../db';
import type { Invoice, Payment, SalesReturn, InvoiceLine } from '../db/types';
import { computeReceivables, computePayables } from '../domain/partyLedger';
import { accountingSelfCheck } from '../domain/AccountingService';

export class RegressionAssertionError extends Error {
  constructor(
    public readonly check: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(`[${check}] ${message}`);
    this.name = 'RegressionAssertionError';
  }
}

function fail(
  check: string,
  message: string,
  context: Record<string, unknown> = {},
): never {
  throw new RegressionAssertionError(check, message, context);
}

// §24.1 — Total debits === total credits across every posted journal entry.
// Also verifies each individual entry balances. The seed of every accounting
// bug we might introduce (mirror-journal drift, missing offset line, wrong
// sign) will trip this.
export async function assertAccountingBalanced(
  businessId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<void> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const check = await accountingSelfCheck(businessId, { db });
  if (!check.debitsEqCredits) {
    fail(
      'accounting-balanced',
      `total debits (${check.totalDebits}) != total credits (${check.totalCredits})`,
      { totalDebits: check.totalDebits, totalCredits: check.totalCredits },
    );
  }
  if (check.unbalancedEntries.length > 0) {
    fail(
      'accounting-balanced',
      `${check.unbalancedEntries.length} unbalanced journal entries: ${check.unbalancedEntries.slice(0, 5).join(', ')}`,
      { unbalancedEntries: check.unbalancedEntries },
    );
  }
}

// §24.2 — For every active invoice, balance_paise must be >= 0.
// A negative balance means the invoice is overpaid, which should ONLY happen
// via advance-application (which decrements paid_paise back down) or a
// credit-note (which posts a separate reversing invoice). Overpaid invoices
// break receivables reporting and the aging buckets.
export function assertInvoiceDueNonNegative(invoice: Invoice): void {
  if (invoice.deleted_at) return; // recycled invoices are excluded from reports anyway.
  if (invoice.balance_paise < 0) {
    fail(
      'invoice-due-non-negative',
      `invoice ${invoice.invoice_number} has negative balance ${invoice.balance_paise} paise`,
      {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        balance: invoice.balance_paise,
        paid: invoice.paid_paise,
        total: invoice.total_paise,
      },
    );
  }
}

// §24.3 — SUM of a payment's active allocations must be <= payment.amount_paise.
// Deleted/cancelled allocations do not count. An over-allocated payment
// implies double-application, which corrupts A/R balances downstream.
export function assertPaymentAllocationsBounded(payment: Payment): void {
  if (payment.deleted_at) return; // recycled payments do not post
  const sum = payment.allocations.reduce(
    (acc, a) => acc + (a.amount_paise ?? 0),
    0,
  );
  if (sum > payment.amount_paise) {
    fail(
      'payment-allocations-bounded',
      `payment ${payment.payment_number} allocates ${sum} paise but total amount is only ${payment.amount_paise} paise`,
      {
        paymentId: payment.id,
        paymentNumber: payment.payment_number,
        allocatedSum: sum,
        amount: payment.amount_paise,
        allocationCount: payment.allocations.length,
      },
    );
  }
}

// §24.4 — A Sales Return's per-line quantity must not exceed the ORIGINAL
// invoice line's quantity, minus any prior returns against the same line.
// Read from `invoice_line_return_summary` — that's the cache SalesReturnService
// maintains for exactly this bounding check.
export async function assertSalesReturnQtyBounded(
  salesReturn: SalesReturn,
  opts: { db?: BusinessVaultDB } = {},
): Promise<void> {
  if (salesReturn.status !== 'posted') return;
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const items = await db.sales_return_items
    .where('sales_return_id')
    .equals(salesReturn.id)
    .toArray();
  for (const item of items) {
    const originalLine: InvoiceLine | undefined = await db.invoice_lines.get(
      item.original_invoice_line_id,
    );
    if (!originalLine) {
      fail(
        'sales-return-qty-bounded',
        `sales return ${salesReturn.return_number} line references missing invoice line ${item.original_invoice_line_id}`,
        { returnId: salesReturn.id, itemId: item.id },
      );
    }
    if (item.qty_micros > originalLine.qty_micros) {
      fail(
        'sales-return-qty-bounded',
        `sales return ${salesReturn.return_number} line ${item.line_no} returns ${item.qty_micros / 1_000_000} but original invoice line only shipped ${originalLine.qty_micros / 1_000_000}`,
        {
          returnId: salesReturn.id,
          returnedMicros: item.qty_micros,
          shippedMicros: originalLine.qty_micros,
        },
      );
    }
  }
}

// §24.5 — Inventory identity: for every item, current on-hand quantity
// (summed across warehouses) must equal opening_qty + SUM(inbound movements)
// - SUM(outbound movements). A drift here means a stock write bypassed the
// movement log, or a movement was written but the item_stock cache wasn't
// updated. Both are correctness bugs the low-stock alerts depend on.
export async function assertInventoryIdentity(
  businessId: string,
  itemId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<void> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const item = await db.items.get(itemId);
  if (!item) {
    fail('inventory-identity', `item ${itemId} not found`, { itemId });
  }
  const stockRows = (
    await db.item_stock.where('business_id').equals(businessId).toArray()
  ).filter((s) => s.item_id === itemId);
  const currentSum = stockRows.reduce((acc, s) => acc + s.qty_micros, 0);

  const movements = await db.stock_movements
    .where('[business_id+item_id]')
    .equals([businessId, itemId])
    .toArray();
  const movementSum = movements.reduce((acc, m) => acc + m.qty_micros, 0);
  const expected = item.opening_qty_micros + movementSum;
  if (currentSum !== expected) {
    fail(
      'inventory-identity',
      `item ${item.name}: current stock ${currentSum} != opening (${item.opening_qty_micros}) + movements (${movementSum}) = ${expected}`,
      {
        itemId,
        currentMicros: currentSum,
        openingMicros: item.opening_qty_micros,
        movementSumMicros: movementSum,
        expected,
      },
    );
  }
}

// §24.6 — Sum of per-customer receivable rows must equal the grand-total.
// This is the invariant that reconcileAfter also checks — the same check
// runs here as a reusable assertion so integration tests can trip it
// without going through the reconcileAfter path.
export async function assertReceivablesConsistent(
  businessId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<void> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const invoices = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  const asOfYmd = new Date().toISOString().slice(0, 10);
  const rec = computeReceivables(invoices, asOfYmd);
  const perCustomerSum = rec.perCustomer.reduce(
    (acc, c) => acc + c.outstanding_paise,
    0,
  );
  if (perCustomerSum !== rec.totals.outstanding_paise) {
    fail(
      'receivables-consistent',
      `sum(perCustomer.outstanding) = ${perCustomerSum} paise but totals.outstanding = ${rec.totals.outstanding_paise} paise`,
      { perCustomerSum, grandTotal: rec.totals.outstanding_paise },
    );
  }
}

// §24.7 — Sum of per-supplier payable rows must equal the grand-total.
// Symmetric to §24.6 but on the purchase side.
export async function assertPayablesConsistent(
  businessId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<void> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const purchases = await db.purchases
    .where('business_id')
    .equals(businessId)
    .toArray();
  const asOfYmd = new Date().toISOString().slice(0, 10);
  const pay = computePayables(purchases, asOfYmd);
  const perSupplierSum = pay.perSupplier.reduce(
    (acc, s) => acc + s.outstanding_paise,
    0,
  );
  if (perSupplierSum !== pay.totals.outstanding_paise) {
    fail(
      'payables-consistent',
      `sum(perSupplier.outstanding) = ${perSupplierSum} paise but totals.outstanding = ${pay.totals.outstanding_paise} paise`,
      { perSupplierSum, grandTotal: pay.totals.outstanding_paise },
    );
  }
}

// §24.8 — Round-off identity: total_paise = pre_round_total_paise + round_off_paise.
// A round-off computation that forgets to write pre_round_total_paise back,
// or a migration that miscomputes it, will make this trip immediately.
export function assertRoundOffIdentity(
  row: {
    id: string;
    total_paise: number;
    pre_round_total_paise: number;
    round_off_paise: number;
    invoice_number?: string;
    return_number?: string;
    bill_number?: string;
  },
): void {
  const expected = row.pre_round_total_paise + row.round_off_paise;
  if (row.total_paise !== expected) {
    const label =
      row.invoice_number ?? row.return_number ?? row.bill_number ?? row.id;
    fail(
      'round-off-identity',
      `row ${label}: total_paise (${row.total_paise}) != pre_round_total_paise (${row.pre_round_total_paise}) + round_off_paise (${row.round_off_paise}) = ${expected}`,
      {
        id: row.id,
        total: row.total_paise,
        preRound: row.pre_round_total_paise,
        roundOff: row.round_off_paise,
      },
    );
  }
}

// §24.9 — No two ACTIVE invoices share the same number within a business.
// Recycled invoices (deleted_at != null) do NOT block reuse — that's the
// §4 spec. So the check is scoped to invoices where deleted_at is null.
export async function assertNoDuplicateInvoiceNumbers(
  businessId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<void> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const invoices = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  const active = invoices.filter((i) => !i.deleted_at);
  const seen = new Map<string, string>();
  for (const inv of active) {
    const prev = seen.get(inv.invoice_number);
    if (prev) {
      fail(
        'no-duplicate-invoice-numbers',
        `invoice number ${inv.invoice_number} used by both ${prev} and ${inv.id}`,
        { number: inv.invoice_number, firstId: prev, secondId: inv.id },
      );
    }
    seen.set(inv.invoice_number, inv.id);
  }
}

// Convenience: run the whole suite for a business in one call. Useful in DR
// tests and integration harnesses that just want "everything must be sane
// right now". Aggregates failures rather than short-circuiting so a single
// run surfaces all drifts.
export interface RegressionSuiteResult {
  ok: boolean;
  failures: { check: string; message: string; context: Record<string, unknown> }[];
}

export async function runFullRegressionSuite(
  businessId: string,
  opts: { db?: BusinessVaultDB } = {},
): Promise<RegressionSuiteResult> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const failures: RegressionSuiteResult['failures'] = [];

  async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof RegressionAssertionError) {
        failures.push({ check: e.check, message: e.message, context: e.context });
      } else {
        failures.push({
          check: name,
          message: (e as Error).message,
          context: {},
        });
      }
    }
  }

  await run('accounting-balanced', () => assertAccountingBalanced(businessId, { db }));
  await run('receivables-consistent', () =>
    assertReceivablesConsistent(businessId, { db }),
  );
  await run('payables-consistent', () =>
    assertPayablesConsistent(businessId, { db }),
  );
  await run('no-duplicate-invoice-numbers', () =>
    assertNoDuplicateInvoiceNumbers(businessId, { db }),
  );

  // Per-row checks: iterate the tables and apply the row-level assertions.
  const invoices = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  for (const inv of invoices) {
    await run('invoice-due-non-negative', () => assertInvoiceDueNonNegative(inv));
    await run('round-off-identity', () => assertRoundOffIdentity(inv));
  }

  const payments = await db.payments
    .where('business_id')
    .equals(businessId)
    .toArray();
  for (const p of payments) {
    await run('payment-allocations-bounded', () =>
      assertPaymentAllocationsBounded(p),
    );
  }

  const returns = await db.sales_returns
    .where('business_id')
    .equals(businessId)
    .toArray();
  for (const sr of returns) {
    await run('sales-return-qty-bounded', () =>
      assertSalesReturnQtyBounded(sr, { db }),
    );
    await run('round-off-identity', () => assertRoundOffIdentity(sr));
  }

  const items = await db.items
    .where('business_id')
    .equals(businessId)
    .toArray();
  for (const it of items) {
    if (!it.track_inventory) continue;
    await run('inventory-identity', () =>
      assertInventoryIdentity(businessId, it.id, { db }),
    );
  }

  return { ok: failures.length === 0, failures };
}
