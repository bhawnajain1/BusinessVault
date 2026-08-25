import { describe, expect, it } from 'vitest';
import { computePayables, computeReceivables } from './partyLedger';
import type { Advance, Customer, Invoice, Purchase, Supplier } from '../db/types';

function mkCust(o: { id: string; opening_balance_paise?: number }): Customer {
  return {
    id: o.id,
    business_id: 'B',
    name: `Cust ${o.id}`,
    phone: '',
    email: '',
    gstin: null,
    billing_address: '',
    shipping_address: '',
    state: '',
    state_code: '',
    opening_balance_paise: o.opening_balance_paise ?? 0,
    credit_limit_paise: 0,
    notes: '',
    active: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    entity_version: 1,
  };
}

function mkSup(o: { id: string; opening_balance_paise?: number }): Supplier {
  return {
    id: o.id,
    business_id: 'B',
    name: `Sup ${o.id}`,
    phone: '',
    email: '',
    gstin: null,
    address: '',
    state: '',
    state_code: '',
    opening_balance_paise: o.opening_balance_paise ?? 0,
    notes: '',
    active: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    entity_version: 1,
  };
}

function mkAdv(o: Partial<Advance> & Pick<Advance, 'id' | 'party_type' | 'remaining_paise'>): Advance {
  return {
    id: o.id,
    business_id: 'B',
    advance_number: `ADV-${o.id}`,
    advance_date: '2026-01-01',
    party_type: o.party_type,
    party_id: o.party_id ?? 'C1',
    method: 'cash',
    account_id: 'acc-cash',
    amount_paise: o.amount_paise ?? o.remaining_paise,
    remaining_paise: o.remaining_paise,
    reference: '',
    notes: '',
    applications: o.applications ?? [],
    journal_entry_id: 'je-adv',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    entity_version: 1,
  };
}

// Minimal invoice fixture — only fields the pure functions read.
function mkInv(o: Partial<Invoice> & Pick<Invoice, 'id' | 'total_paise'>): Invoice {
  return {
    id: o.id,
    business_id: 'B',
    invoice_number: o.invoice_number ?? `INV-${o.id}`,
    invoice_date: o.invoice_date ?? '2026-01-01',
    due_date: o.due_date ?? null,
    customer_id: o.customer_id ?? 'C1',
    customer_state_code: '',
    place_of_supply: '',
    is_interstate: 0,
    financial_year: '',
    subtotal_paise: 0,
    discount_paise: 0,
    taxable_paise: 0,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    total_paise: o.total_paise,
    paid_paise: o.paid_paise ?? 0,
    balance_paise: o.total_paise - (o.paid_paise ?? 0),
    status: o.status ?? 'issued',
    reversed_by_invoice_id: o.reversed_by_invoice_id ?? null,
    reverses_invoice_id: o.reverses_invoice_id ?? null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    entity_version: 1,
  };
}

function mkPur(
  o: Partial<Purchase> & Pick<Purchase, 'id' | 'total_paise'>,
): Purchase {
  return {
    id: o.id,
    business_id: 'B',
    bill_number: o.bill_number ?? `BILL-${o.id}`,
    supplier_bill_number: '',
    bill_date: o.bill_date ?? '2026-01-01',
    due_date: o.due_date ?? null,
    supplier_id: o.supplier_id ?? 'S1',
    supplier_state_code: '',
    is_interstate: 0,
    financial_year: '',
    subtotal_paise: 0,
    discount_paise: 0,
    taxable_paise: 0,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    total_paise: o.total_paise,
    paid_paise: o.paid_paise ?? 0,
    balance_paise: o.total_paise - (o.paid_paise ?? 0),
    status: o.status ?? 'received',
    reversed_by_purchase_id: o.reversed_by_purchase_id ?? null,
    reverses_purchase_id: o.reverses_purchase_id ?? null,
    notes: '',
    attachment_id: null,
    journal_entry_id: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    entity_version: 1,
  };
}

describe('computeReceivables', () => {
  it('reduces outstanding by paid amount', () => {
    const invs = [mkInv({ id: 'I1', total_paise: 100_00, paid_paise: 30_00 })];
    const ar = computeReceivables(invs, '2026-02-01');
    expect(ar.totals.outstanding_paise).toBe(70_00);
    expect(ar.perCustomer[0].outstanding_paise).toBe(70_00);
  });

  it('reduces outstanding by credit note (linked via reverses_invoice_id)', () => {
    const invs = [
      mkInv({ id: 'I1', total_paise: 100_00 }),
      mkInv({ id: 'CN-I1', total_paise: -40_00, reverses_invoice_id: 'I1' }),
    ];
    const ar = computeReceivables(invs, '2026-02-01');
    expect(ar.totals.outstanding_paise).toBe(60_00);
    expect(ar.perCustomer[0].total_credit_note_paise).toBe(40_00);
  });

  it('treats overpayment (paid + credits > total) as advance, not negative outstanding', () => {
    const invs = [
      mkInv({ id: 'I1', total_paise: 50_00, paid_paise: 60_00 }),
    ];
    const ar = computeReceivables(invs, '2026-02-01');
    expect(ar.totals.outstanding_paise).toBe(0);
    expect(ar.totals.advance_paise).toBe(10_00);
  });

  it('skips cancelled and draft invoices', () => {
    const invs = [
      mkInv({ id: 'I1', total_paise: 100_00, status: 'cancelled' }),
      mkInv({ id: 'I2', total_paise: 100_00, status: 'draft' }),
    ];
    const ar = computeReceivables(invs, '2026-02-01');
    expect(ar.totals.outstanding_paise).toBe(0);
    expect(ar.perCustomer).toHaveLength(0);
  });

  it('classifies aging by due_date, not invoice_date', () => {
    const invs = [
      mkInv({
        id: 'I1',
        total_paise: 100_00,
        invoice_date: '2025-12-01',
        due_date: '2026-01-01',
      }), // asOf 2026-02-01 → 31 days overdue → 31-60 bucket
      mkInv({
        id: 'I2',
        total_paise: 200_00,
        invoice_date: '2025-11-01',
        due_date: '2026-03-01',
        customer_id: 'C1',
      }), // not due yet → current
    ];
    const ar = computeReceivables(invs, '2026-02-01');
    expect(ar.totals.aging.d31_60_paise).toBe(100_00);
    expect(ar.totals.aging.current_paise).toBe(200_00);
    expect(ar.totals.overdue_count).toBe(1);
  });

  it('folds unapplied customer advances into per-customer advance_paise', () => {
    const invs = [mkInv({ id: 'I1', total_paise: 100_00, paid_paise: 30_00 })];
    const advs = [
      mkAdv({ id: 'A1', party_type: 'customer', party_id: 'C1', remaining_paise: 20_00 }),
      mkAdv({
        id: 'A2',
        party_type: 'customer',
        party_id: 'C1',
        amount_paise: 50_00,
        remaining_paise: 0,
      }), // fully applied — should NOT count
    ];
    const ar = computeReceivables(invs, '2026-02-01', advs);
    expect(ar.totals.outstanding_paise).toBe(70_00);
    expect(ar.totals.advance_paise).toBe(20_00);
    expect(ar.perCustomer[0].advance_paise).toBe(20_00);
  });

  it('advance for a customer with no invoices still creates a bucket row', () => {
    const advs = [
      mkAdv({ id: 'A1', party_type: 'customer', party_id: 'Cnew', remaining_paise: 15_00 }),
    ];
    const ar = computeReceivables([], '2026-02-01', advs);
    expect(ar.totals.advance_paise).toBe(15_00);
    expect(ar.perCustomer).toHaveLength(1);
    expect(ar.perCustomer[0].customer_id).toBe('Cnew');
  });

  it('treats missing due_date as current', () => {
    const invs = [
      mkInv({ id: 'I1', total_paise: 100_00, due_date: null }),
    ];
    const ar = computeReceivables(invs, '2030-01-01');
    expect(ar.totals.aging.current_paise).toBe(100_00);
    expect(ar.totals.overdue_count).toBe(0);
  });

  it('positive customer opening balance adds to outstanding and current bucket', () => {
    const invs = [mkInv({ id: 'I1', total_paise: 100_00, customer_id: 'C1' })];
    const customers = [mkCust({ id: 'C1', opening_balance_paise: 25_00 })];
    const ar = computeReceivables(invs, '2026-02-01', [], customers);
    expect(ar.totals.outstanding_paise).toBe(125_00);
    expect(ar.totals.opening_balance_paise).toBe(25_00);
    expect(ar.totals.aging.current_paise).toBe(125_00);
    expect(ar.perCustomer[0].outstanding_paise).toBe(125_00);
  });

  it('negative customer opening balance becomes advance', () => {
    const customers = [mkCust({ id: 'Cnew', opening_balance_paise: -40_00 })];
    const ar = computeReceivables([], '2026-02-01', [], customers);
    expect(ar.totals.outstanding_paise).toBe(0);
    expect(ar.totals.advance_paise).toBe(40_00);
    expect(ar.totals.opening_balance_paise).toBe(-40_00);
  });

  it('customer with only opening balance still gets a bucket row', () => {
    const customers = [mkCust({ id: 'Cnew', opening_balance_paise: 50_00 })];
    const ar = computeReceivables([], '2026-02-01', [], customers);
    expect(ar.perCustomer).toHaveLength(1);
    expect(ar.perCustomer[0].customer_id).toBe('Cnew');
    expect(ar.perCustomer[0].outstanding_paise).toBe(50_00);
  });
});

describe('computePayables', () => {
  it('sums outstanding across supplier bills', () => {
    const bills = [
      mkPur({ id: 'B1', total_paise: 100_00, paid_paise: 20_00 }),
      mkPur({ id: 'B2', total_paise: 50_00, paid_paise: 0 }),
    ];
    const ap = computePayables(bills, '2026-02-01');
    expect(ap.totals.outstanding_paise).toBe(130_00);
  });

  it('applies supplier-level debit-note pool FIFO to bills (legacy pre-FK debit notes)', () => {
    const bills = [
      mkPur({ id: 'B1', total_paise: 100_00, bill_date: '2026-01-01' }),
      mkPur({ id: 'B2', total_paise: 100_00, bill_date: '2026-01-05' }),
      mkPur({ id: 'DN1', total_paise: -30_00 }), // legacy debit note, no FK
    ];
    const ap = computePayables(bills, '2026-02-01');
    // Total gross owed = 200, debit pool = 30 → 170 outstanding, oldest bill absorbs it first.
    expect(ap.totals.outstanding_paise).toBe(170_00);
    const b1 = ap.perPurchase.find((p) => p.purchase_id === 'B1')!;
    expect(b1.outstanding_paise).toBe(70_00);
    expect(b1.debit_note_paise).toBe(30_00);
  });

  it('attaches debit note directly to its bill via reverses_purchase_id', () => {
    // Modern path (post-PR 3): the debit note carries a pointer to the original,
    // so it reduces THAT bill regardless of bill_date. B2 is the newer bill;
    // legacy pool would have applied the debit to B1 (oldest first). Directly-
    // attached should go to B2.
    const bills = [
      mkPur({ id: 'B1', total_paise: 100_00, bill_date: '2026-01-01' }),
      mkPur({ id: 'B2', total_paise: 100_00, bill_date: '2026-01-05' }),
      mkPur({
        id: 'DN1',
        total_paise: -30_00,
        reverses_purchase_id: 'B2',
      }),
    ];
    const ap = computePayables(bills, '2026-02-01');
    expect(ap.totals.outstanding_paise).toBe(170_00);
    const b1 = ap.perPurchase.find((p) => p.purchase_id === 'B1')!;
    const b2 = ap.perPurchase.find((p) => p.purchase_id === 'B2')!;
    expect(b1.outstanding_paise).toBe(100_00);
    expect(b1.debit_note_paise).toBe(0);
    expect(b2.outstanding_paise).toBe(70_00);
    expect(b2.debit_note_paise).toBe(30_00);
  });

  it('directly-attached debit note exceeding its bill flips into advance', () => {
    // Overshooting an attached debit note (return more than the bill's remaining
    // balance) yields advance_paise, not negative outstanding.
    const bills = [
      mkPur({ id: 'B1', total_paise: 50_00 }),
      mkPur({
        id: 'DN1',
        total_paise: -80_00,
        reverses_purchase_id: 'B1',
      }),
    ];
    const ap = computePayables(bills, '2026-02-01');
    const b1 = ap.perPurchase.find((p) => p.purchase_id === 'B1')!;
    expect(b1.outstanding_paise).toBe(0);
    expect(b1.advance_paise).toBe(30_00);
  });

  it('leftover debit-note pool becomes supplier advance', () => {
    const bills = [
      mkPur({ id: 'B1', total_paise: 50_00 }),
      mkPur({ id: 'DN1', total_paise: -80_00 }), // more debit than owed
    ];
    const ap = computePayables(bills, '2026-02-01');
    expect(ap.totals.outstanding_paise).toBe(0);
    expect(ap.totals.advance_paise).toBe(30_00);
  });

  it('positive supplier opening balance adds to outstanding and current bucket', () => {
    const bills = [mkPur({ id: 'B1', total_paise: 100_00, supplier_id: 'S1' })];
    const suppliers = [mkSup({ id: 'S1', opening_balance_paise: 20_00 })];
    const ap = computePayables(bills, '2026-02-01', [], suppliers);
    expect(ap.totals.outstanding_paise).toBe(120_00);
    expect(ap.totals.opening_balance_paise).toBe(20_00);
    expect(ap.totals.aging.current_paise).toBe(120_00);
  });

  it('negative supplier opening balance becomes advance', () => {
    const suppliers = [mkSup({ id: 'Snew', opening_balance_paise: -35_00 })];
    const ap = computePayables([], '2026-02-01', [], suppliers);
    expect(ap.totals.outstanding_paise).toBe(0);
    expect(ap.totals.advance_paise).toBe(35_00);
    expect(ap.totals.opening_balance_paise).toBe(-35_00);
  });
});
