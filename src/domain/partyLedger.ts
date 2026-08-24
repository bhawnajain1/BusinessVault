import type { Advance, Customer, Invoice, Purchase, Supplier } from '../db/types';

// Party ledger — derived outstanding per the spec (payablesRec.md).
//
// Source of truth is the transaction set (invoices, purchases, credit notes,
// debit notes). Cached fields like invoice.balance_paise / paid_paise are NOT
// trusted here — they are correct for direct payment allocations but a credit
// note leaves the original's cached balance untouched. This module recomputes
// outstanding from scratch.
//
// Formula (per section 4 of the spec):
//   invoice_outstanding = grand_total - allocated_payments - credit_adjustments + debit_adjustments
//
// In this app's schema:
//   - "allocated_payments" is already reflected in invoice.paid_paise
//     (PaymentService.applyAllocationsToTargets bumps it on each allocation).
//   - "credit_adjustments" = sum of credit-note invoices where reverses_invoice_id === this invoice.id.
//     Each credit note has total_paise = -original.total_paise (negative).
//     So we ADD the credit note total_paise to reduce outstanding.
//   - "debit_adjustments" for a sale is rare and not currently modeled.

export interface InvoiceOutstanding {
  invoice_id: string;
  customer_id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  grand_total_paise: number;
  paid_paise: number;
  credit_note_paise: number; // absolute (positive); already accounted for as reduction
  outstanding_paise: number; // grand_total - paid - credit_note (never negative — overpayment becomes advance)
  advance_paise: number; // grand_total - paid - credit_note if negative, flipped sign
  overdue: boolean;
  days_overdue: number; // 0 if not overdue
}

export interface PurchaseOutstanding {
  purchase_id: string;
  supplier_id: string;
  bill_number: string;
  bill_date: string;
  due_date: string | null;
  grand_total_paise: number;
  paid_paise: number;
  debit_note_paise: number; // absolute
  outstanding_paise: number;
  advance_paise: number;
  overdue: boolean;
  days_overdue: number;
}

export interface AgingBuckets {
  current_paise: number; // not yet due, or no due_date
  d1_30_paise: number;
  d31_60_paise: number;
  d61_90_paise: number;
  d90plus_paise: number;
  total_paise: number;
}

export interface CustomerReceivable {
  customer_id: string;
  invoice_count: number; // count of outstanding invoices
  total_billed_paise: number;
  total_paid_paise: number;
  total_credit_note_paise: number;
  opening_balance_paise: number; // signed carry-in; positive = customer owed us at go-live
  outstanding_paise: number; // includes opening_balance_paise contribution
  advance_paise: number;
  overdue_count: number;
  aging: AgingBuckets;
}

export interface SupplierPayable {
  supplier_id: string;
  bill_count: number;
  total_billed_paise: number;
  total_paid_paise: number;
  total_debit_note_paise: number;
  opening_balance_paise: number; // signed carry-in; positive = we owed supplier at go-live
  outstanding_paise: number; // includes opening_balance_paise contribution
  advance_paise: number;
  overdue_count: number;
  aging: AgingBuckets;
}

// --- Pure helpers ---

// Whole-day difference between two YYYY-MM-DD dates. Positive = second is later.
function daysBetween(fromYmd: string, toYmd: string): number {
  const from = new Date(fromYmd + 'T00:00:00');
  const to = new Date(toYmd + 'T00:00:00');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function bucketize(outstanding: number, daysOverdue: number, into: AgingBuckets): void {
  into.total_paise += outstanding;
  if (daysOverdue <= 0) {
    into.current_paise += outstanding;
  } else if (daysOverdue <= 30) {
    into.d1_30_paise += outstanding;
  } else if (daysOverdue <= 60) {
    into.d31_60_paise += outstanding;
  } else if (daysOverdue <= 90) {
    into.d61_90_paise += outstanding;
  } else {
    into.d90plus_paise += outstanding;
  }
}

function emptyAging(): AgingBuckets {
  return {
    current_paise: 0,
    d1_30_paise: 0,
    d31_60_paise: 0,
    d61_90_paise: 0,
    d90plus_paise: 0,
    total_paise: 0,
  };
}

// --- Invoice-level derivation ---

// One invoice's derived outstanding, given the credit notes that reverse it.
// asOfYmd is used only for the overdue flag.
function computeInvoiceRow(
  inv: Invoice,
  creditNotesForThisInvoice: Invoice[],
  asOfYmd: string,
): InvoiceOutstanding {
  // Credit note total_paise is negative; take absolute for the "reduction" figure.
  const creditReductionPaise = creditNotesForThisInvoice.reduce(
    (acc, cn) => acc + Math.abs(cn.total_paise),
    0,
  );
  const grossOutstanding = inv.total_paise - inv.paid_paise - creditReductionPaise;
  const outstanding = Math.max(0, grossOutstanding);
  const advance = grossOutstanding < 0 ? -grossOutstanding : 0;

  const dueYmd = inv.due_date ?? null;
  const daysOverdue = dueYmd ? Math.max(0, daysBetween(dueYmd, asOfYmd)) : 0;
  const overdue = outstanding > 0 && daysOverdue > 0;

  return {
    invoice_id: inv.id,
    customer_id: inv.customer_id,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    due_date: dueYmd,
    grand_total_paise: inv.total_paise,
    paid_paise: inv.paid_paise,
    credit_note_paise: creditReductionPaise,
    outstanding_paise: outstanding,
    advance_paise: advance,
    overdue,
    days_overdue: daysOverdue,
  };
}

function computePurchaseRow(
  p: Purchase,
  debitNotesForThisPurchase: Purchase[],
  asOfYmd: string,
): PurchaseOutstanding {
  const debitReductionPaise = debitNotesForThisPurchase.reduce(
    (acc, dn) => acc + Math.abs(dn.total_paise),
    0,
  );
  const grossOutstanding = p.total_paise - p.paid_paise - debitReductionPaise;
  const outstanding = Math.max(0, grossOutstanding);
  const advance = grossOutstanding < 0 ? -grossOutstanding : 0;

  const dueYmd = p.due_date ?? null;
  const daysOverdue = dueYmd ? Math.max(0, daysBetween(dueYmd, asOfYmd)) : 0;
  const overdue = outstanding > 0 && daysOverdue > 0;

  return {
    purchase_id: p.id,
    supplier_id: p.supplier_id,
    bill_number: p.bill_number,
    bill_date: p.bill_date,
    due_date: dueYmd,
    grand_total_paise: p.total_paise,
    paid_paise: p.paid_paise,
    debit_note_paise: debitReductionPaise,
    outstanding_paise: outstanding,
    advance_paise: advance,
    overdue,
    days_overdue: daysOverdue,
  };
}

// --- Aggregation ---

export interface DerivedReceivables {
  perInvoice: InvoiceOutstanding[]; // one row per non-cancelled, non-credit-note sale invoice
  perCustomer: CustomerReceivable[]; // rolled up
  totals: CustomerReceivable; // grand total across customers (customer_id = '')
}

export function computeReceivables(
  invoices: Invoice[],
  asOfYmd: string,
  advances: Advance[] = [],
  customers: Customer[] = [],
): DerivedReceivables {
  // Partition: originals (positive-total sales), credit notes (reversing).
  // Cancelled and draft never contribute either way.
  const usable = invoices.filter((i) => i.status !== 'cancelled' && i.status !== 'draft');
  const originals = usable.filter((i) => i.reverses_invoice_id === null);
  const creditNotes = usable.filter((i) => i.reverses_invoice_id !== null);
  const creditsByOriginalId = new Map<string, Invoice[]>();
  for (const cn of creditNotes) {
    if (!cn.reverses_invoice_id) continue;
    const arr = creditsByOriginalId.get(cn.reverses_invoice_id) ?? [];
    arr.push(cn);
    creditsByOriginalId.set(cn.reverses_invoice_id, arr);
  }

  const perInvoice: InvoiceOutstanding[] = originals.map((inv) =>
    computeInvoiceRow(inv, creditsByOriginalId.get(inv.id) ?? [], asOfYmd),
  );

  const bucket = new Map<string, CustomerReceivable>();
  const grand: CustomerReceivable = {
    customer_id: '',
    invoice_count: 0,
    total_billed_paise: 0,
    total_paid_paise: 0,
    total_credit_note_paise: 0,
    opening_balance_paise: 0,
    outstanding_paise: 0,
    advance_paise: 0,
    overdue_count: 0,
    aging: emptyAging(),
  };

  function ensureCustomer(customerId: string): CustomerReceivable {
    let cust = bucket.get(customerId);
    if (!cust) {
      cust = {
        customer_id: customerId,
        invoice_count: 0,
        total_billed_paise: 0,
        total_paid_paise: 0,
        total_credit_note_paise: 0,
        opening_balance_paise: 0,
        outstanding_paise: 0,
        advance_paise: 0,
        overdue_count: 0,
        aging: emptyAging(),
      };
      bucket.set(customerId, cust);
    }
    return cust;
  }

  for (const row of perInvoice) {
    const cust = ensureCustomer(row.customer_id);
    cust.total_billed_paise += row.grand_total_paise;
    cust.total_paid_paise += row.paid_paise;
    cust.total_credit_note_paise += row.credit_note_paise;
    cust.advance_paise += row.advance_paise;
    grand.total_billed_paise += row.grand_total_paise;
    grand.total_paid_paise += row.paid_paise;
    grand.total_credit_note_paise += row.credit_note_paise;
    grand.advance_paise += row.advance_paise;

    if (row.outstanding_paise > 0) {
      cust.invoice_count += 1;
      cust.outstanding_paise += row.outstanding_paise;
      grand.outstanding_paise += row.outstanding_paise;
      if (row.overdue) {
        cust.overdue_count += 1;
        grand.overdue_count += 1;
      }
      bucketize(row.outstanding_paise, row.days_overdue, cust.aging);
      bucketize(row.outstanding_paise, row.days_overdue, grand.aging);
    }
  }

  // Fold in advance remaining balances. Note: the invoice's own paid_paise
  // already reflects any advance that has been APPLIED (AdvanceService.applyAdvance
  // bumps paid_paise). What we add here is the UNAPPLIED remainder — money
  // held on account that hasn't been consumed by an invoice yet.
  for (const adv of advances) {
    if (adv.party_type !== 'customer') continue;
    if (adv.remaining_paise <= 0) continue;
    const cust = ensureCustomer(adv.party_id);
    cust.advance_paise += adv.remaining_paise;
    grand.advance_paise += adv.remaining_paise;
  }

  // Fold in opening balances. Positive opening = customer owed us on go-live,
  // treated as an additional outstanding contribution bucketed as "current"
  // (no due date to age against). Negative opening = customer had credit on
  // account; that lives in advance_paise instead.
  for (const c of customers) {
    const opening = c.opening_balance_paise;
    if (opening === 0) continue;
    const cust = ensureCustomer(c.id);
    cust.opening_balance_paise += opening;
    grand.opening_balance_paise += opening;
    if (opening > 0) {
      cust.outstanding_paise += opening;
      grand.outstanding_paise += opening;
      bucketize(opening, 0, cust.aging);
      bucketize(opening, 0, grand.aging);
    } else {
      cust.advance_paise += -opening;
      grand.advance_paise += -opening;
    }
  }

  const perCustomer = [...bucket.values()].sort(
    (a, b) => b.outstanding_paise - a.outstanding_paise,
  );
  return { perInvoice, perCustomer, totals: grand };
}

export interface DerivedPayables {
  perPurchase: PurchaseOutstanding[];
  perSupplier: SupplierPayable[];
  totals: SupplierPayable;
}

// Purchase-return / debit note detection: this app's schema does NOT record
// `reverses_purchase_id` on Purchase, but ReturnService writes debit notes as
// negative-total purchase rows with supplier_bill_number prefixed 'RET-' and
// notes starting 'Debit note for bill '. Detect via total_paise < 0.
export function computePayables(
  purchases: Purchase[],
  asOfYmd: string,
  advances: Advance[] = [],
  suppliers: Supplier[] = [],
): DerivedPayables {
  const usable = purchases.filter((p) => p.status !== 'cancelled');
  const originals = usable.filter((p) => p.total_paise > 0);
  const debitNotes = usable.filter((p) => p.total_paise < 0);

  // Debit notes here don't carry a pointer to their original bill; we can only
  // aggregate them at the supplier level, not the bill level. Reflect this
  // limitation by treating debit-note reductions as supplier-level credits
  // applied to the earliest outstanding bill (Grug: keep simple, degrade
  // gracefully). If the schema gains reverses_purchase_id later, refactor.
  const debitPoolBySupplier = new Map<string, number>();
  for (const dn of debitNotes) {
    debitPoolBySupplier.set(
      dn.supplier_id,
      (debitPoolBySupplier.get(dn.supplier_id) ?? 0) + Math.abs(dn.total_paise),
    );
  }

  // Sort each supplier's bills oldest-first so the debit-note pool consumes
  // in FIFO order.
  const originalsSorted = [...originals].sort((a, b) =>
    a.bill_date < b.bill_date ? -1 : a.bill_date > b.bill_date ? 1 : 0,
  );

  const perPurchase: PurchaseOutstanding[] = [];
  for (const p of originalsSorted) {
    // Pull whatever's left from this supplier's debit-note pool onto this bill.
    const pool = debitPoolBySupplier.get(p.supplier_id) ?? 0;
    const grossBeforeDebit = p.total_paise - p.paid_paise;
    const applyDebit = Math.min(Math.max(grossBeforeDebit, 0), pool);
    debitPoolBySupplier.set(p.supplier_id, pool - applyDebit);
    const row = computePurchaseRow(
      p,
      // Fake a single Purchase carrying just the applied debit amount.
      applyDebit > 0
        ? [
            {
              ...p,
              total_paise: -applyDebit,
              id: `${p.id}-DN-virtual`,
            },
          ]
        : [],
      asOfYmd,
    );
    perPurchase.push(row);
  }

  // Leftover debit-note pool becomes a supplier advance (money owed BACK to us).
  const leftoverAdvanceBySupplier = new Map<string, number>();
  for (const [supplierId, remaining] of debitPoolBySupplier.entries()) {
    if (remaining > 0) leftoverAdvanceBySupplier.set(supplierId, remaining);
  }

  const bucket = new Map<string, SupplierPayable>();
  const grand: SupplierPayable = {
    supplier_id: '',
    bill_count: 0,
    total_billed_paise: 0,
    total_paid_paise: 0,
    total_debit_note_paise: 0,
    opening_balance_paise: 0,
    outstanding_paise: 0,
    advance_paise: 0,
    overdue_count: 0,
    aging: emptyAging(),
  };

  function ensureSupplier(supplierId: string): SupplierPayable {
    let sup = bucket.get(supplierId);
    if (!sup) {
      sup = {
        supplier_id: supplierId,
        bill_count: 0,
        total_billed_paise: 0,
        total_paid_paise: 0,
        total_debit_note_paise: 0,
        opening_balance_paise: 0,
        outstanding_paise: 0,
        advance_paise: 0,
        overdue_count: 0,
        aging: emptyAging(),
      };
      bucket.set(supplierId, sup);
    }
    return sup;
  }

  for (const row of perPurchase) {
    const sup = ensureSupplier(row.supplier_id);
    sup.total_billed_paise += row.grand_total_paise;
    sup.total_paid_paise += row.paid_paise;
    sup.total_debit_note_paise += row.debit_note_paise;
    grand.total_billed_paise += row.grand_total_paise;
    grand.total_paid_paise += row.paid_paise;
    grand.total_debit_note_paise += row.debit_note_paise;

    if (row.outstanding_paise > 0) {
      sup.bill_count += 1;
      sup.outstanding_paise += row.outstanding_paise;
      grand.outstanding_paise += row.outstanding_paise;
      if (row.overdue) {
        sup.overdue_count += 1;
        grand.overdue_count += 1;
      }
      bucketize(row.outstanding_paise, row.days_overdue, sup.aging);
      bucketize(row.outstanding_paise, row.days_overdue, grand.aging);
    }
  }

  for (const [supplierId, adv] of leftoverAdvanceBySupplier.entries()) {
    const sup = ensureSupplier(supplierId);
    sup.advance_paise += adv;
    grand.advance_paise += adv;
  }

  // Supplier advances: money paid but not yet consumed by a bill = asset owed
  // back to us. Adds to `advance_paise` (which for suppliers already carries
  // debit-note leftovers, semantically "credit balance held by supplier").
  for (const adv of advances) {
    if (adv.party_type !== 'supplier') continue;
    if (adv.remaining_paise <= 0) continue;
    const sup = ensureSupplier(adv.party_id);
    sup.advance_paise += adv.remaining_paise;
    grand.advance_paise += adv.remaining_paise;
  }

  // Fold in opening balances. Positive opening = we owed supplier on go-live,
  // treated as outstanding bucketed as "current". Negative opening = supplier
  // held credit for us; lives in advance_paise.
  for (const s of suppliers) {
    const opening = s.opening_balance_paise;
    if (opening === 0) continue;
    const sup = ensureSupplier(s.id);
    sup.opening_balance_paise += opening;
    grand.opening_balance_paise += opening;
    if (opening > 0) {
      sup.outstanding_paise += opening;
      grand.outstanding_paise += opening;
      bucketize(opening, 0, sup.aging);
      bucketize(opening, 0, grand.aging);
    } else {
      sup.advance_paise += -opening;
      grand.advance_paise += -opening;
    }
  }

  const perSupplier = [...bucket.values()].sort(
    (a, b) => b.outstanding_paise - a.outstanding_paise,
  );
  return { perPurchase, perSupplier, totals: grand };
}
