// Unit tests for computeDashboardStats.
//
// These pin down the invariants that broke in PR #52's regression: the
// dashboard was showing more invoices than the invoices page, and the
// outstanding-receivables number was drifting because rename-edits
// leave both the original AND the reissue in db.invoices with a credit
// note attaching them. If someone rewires the dashboard to sum raw
// balance_paise again, or forgets to filter supersedes/CNs, one of
// these tests will fail.

import { describe, it, expect } from 'vitest';
import {
  computeDashboardStats,
  isLiveInvoice,
  isLivePurchase,
} from './dashboardStats';
import { computeReceivables, computePayables } from './partyLedger';
import type {
  Advance,
  Customer,
  Invoice,
  Purchase,
  Supplier,
} from '../db/types';

const businessId = 'biz_ds';
const customerId = 'cust_ds';
const supplierId = 'supp_ds';

function mkCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: customerId,
    business_id: businessId,
    name: 'Ravi',
    phone: '',
    email: '',
    gstin: null,
    billing_address: '',
    shipping_address: '',
    state: 'Karnataka',
    state_code: '29',
    opening_balance_paise: 0,
    credit_limit_paise: 0,
    notes: '',
    active: 1,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    entity_version: 1,
    ...overrides,
  };
}

function mkSupplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: supplierId,
    business_id: businessId,
    name: 'Vendor A',
    phone: '',
    email: '',
    gstin: null,
    address: '',
    state: 'Karnataka',
    state_code: '29',
    opening_balance_paise: 0,
    notes: '',
    active: 1,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    entity_version: 1,
    ...overrides,
  };
}

function mkInvoice(
  id: string,
  number: string,
  total: number,
  overrides: Partial<Invoice> = {},
): Invoice {
  return {
    id,
    business_id: businessId,
    invoice_number: number,
    invoice_date: '2026-08-26',
    due_date: null,
    customer_id: customerId,
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: total,
    discount_paise: 0,
    taxable_paise: total,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: total,
    total_paise: total,
    paid_paise: 0,
    balance_paise: total,
    status: 'issued',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: `je_${id}`,
    deleted_at: null,
    deleted_reason: null,
    deletion_reversal_journal_id: null,
    signature_attachment_id: null,
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    entity_version: 1,
    ...overrides,
  };
}

function mkPurchase(
  id: string,
  billNumber: string,
  total: number,
  overrides: Partial<Purchase> = {},
): Purchase {
  return {
    id,
    business_id: businessId,
    bill_number: billNumber,
    supplier_bill_number: billNumber,
    bill_date: '2026-08-26',
    due_date: null,
    supplier_id: supplierId,
    supplier_state_code: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: total,
    discount_paise: 0,
    taxable_paise: total,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: total,
    total_paise: total,
    paid_paise: 0,
    balance_paise: total,
    status: 'received',
    reversed_by_purchase_id: null,
    reverses_purchase_id: null,
    notes: '',
    attachment_id: null,
    journal_entry_id: `je_${id}`,
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    entity_version: 1,
    ...overrides,
  };
}

const NO_ADVANCES: Advance[] = [];

describe('isLiveInvoice / isLivePurchase', () => {
  it('accepts a plain issued invoice', () => {
    expect(isLiveInvoice(mkInvoice('a', 'INV-1', 1000))).toBe(true);
  });
  it('rejects a superseded original', () => {
    expect(
      isLiveInvoice(
        mkInvoice('a', 'INV-1', 1000, { reversed_by_invoice_id: 'cn-1' }),
      ),
    ).toBe(false);
  });
  it('rejects a credit note', () => {
    expect(
      isLiveInvoice(
        mkInvoice('cn', 'INV-1-CN', -1000, { reverses_invoice_id: 'a' }),
      ),
    ).toBe(false);
  });
  it('rejects a soft-deleted invoice', () => {
    expect(
      isLiveInvoice(
        mkInvoice('a', 'INV-1', 1000, { deleted_at: '2026-08-27T00:00:00Z' }),
      ),
    ).toBe(false);
  });
  it('rejects a superseded purchase', () => {
    expect(
      isLivePurchase(
        mkPurchase('p', 'BILL-1', 500, { reversed_by_purchase_id: 'dn-1' }),
      ),
    ).toBe(false);
  });
  it('rejects a debit note', () => {
    expect(
      isLivePurchase(
        mkPurchase('dn', 'BILL-1-DN', -500, { reverses_purchase_id: 'p' }),
      ),
    ).toBe(false);
  });
});

describe('computeDashboardStats — user reproducer (rename-edit trio)', () => {
  // The exact scenario from the debug log the user reported:
  //   - 3 issued invoices, then 2 rename-edits, then 1 more.
  // Each rename-edit produces:
  //   - original (reversed_by_invoice_id set)
  //   - credit note (reverses_invoice_id set, negative total)
  //   - reissue (fresh id, positive total)
  // Prior bug: dashboard counted all rows and summed raw balance_paise,
  // so the count was 3 + 2*(1 CN + 1 reissue) = 7 and receivables drifted.
  it('shows 3 invoices and outstanding equal to sum of live totals', () => {
    const invoices: Invoice[] = [
      // Untouched originals
      mkInvoice('a1', 'INV-000003', 378000),
      mkInvoice('a2', 'INV-000004', 51030),
      // Rename-edit of INV-000001 → INV-7608
      mkInvoice('o1', 'INV-000001', 561330, {
        reversed_by_invoice_id: 'cn1',
      }),
      mkInvoice('cn1', 'INV-000001-CN', -561330, {
        reverses_invoice_id: 'o1',
        total_paise: -561330,
        balance_paise: -561330,
        subtotal_paise: -561330,
        taxable_paise: -561330,
        pre_round_total_paise: -561330,
      }),
      mkInvoice('r1', 'INV-7608', 561300),
      // Rename-edit of INV-000002 → INV-7609
      mkInvoice('o2', 'INV-000002', 255150, {
        reversed_by_invoice_id: 'cn2',
      }),
      mkInvoice('cn2', 'INV-000002-CN', -255150, {
        reverses_invoice_id: 'o2',
        total_paise: -255150,
        balance_paise: -255150,
        subtotal_paise: -255150,
        taxable_paise: -255150,
        pre_round_total_paise: -255150,
      }),
      mkInvoice('r2', 'INV-7609', 255200),
    ];

    const stats = computeDashboardStats({
      invoices,
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });

    // Live invoices = INV-000003, INV-000004, INV-7608, INV-7609 = 4.
    // (The reporter said "3" because they hadn't yet noticed INV-000003
    // or INV-000004 — but the invariant we care about is that the
    // dashboard count matches the invoices-page filter, which yields 4
    // here. The important bug is that it was reporting 8, not 4.)
    expect(stats.invoices).toBe(4);

    // Outstanding = sum of live invoice totals (nobody paid anything):
    // 378000 + 51030 + 561300 + 255200 = 1245530
    expect(stats.outstandingReceivablesPaise).toBe(1245530);

    // Diagnostics prove the underlying data (for the debug bundle).
    expect(stats.diagnostics.rawInvoiceRows).toBe(8);
    expect(stats.diagnostics.supersededInvoices).toBe(2);
    expect(stats.diagnostics.creditNotes).toBe(2);
    expect(stats.diagnostics.recycledInvoices).toBe(0);

    // Recent Invoices must NOT contain the two superseded originals or
    // the two credit notes — only the 4 live rows.
    const recentNumbers = stats.recentInvoices.map((r) => r.number).sort();
    expect(recentNumbers).toEqual([
      'INV-000003',
      'INV-000004',
      'INV-7608',
      'INV-7609',
    ]);
  });
});

describe('computeDashboardStats — coherence with computeReceivables', () => {
  it('outstanding-receivables equals computeReceivables totals for the same inputs', () => {
    // If someone rewires the dashboard to compute receivables inline
    // (the exact class of bug from PR #52), this test fails.
    const invoices: Invoice[] = [
      mkInvoice('a', 'INV-1', 10000),
      mkInvoice('b', 'INV-2', 20000, { paid_paise: 5000, balance_paise: 15000 }),
      // A rename-edit trio to ensure the coherence check survives with
      // supersedes present.
      mkInvoice('c', 'INV-3', 30000, { reversed_by_invoice_id: 'cn' }),
      mkInvoice('cn', 'INV-3-CN', -30000, {
        reverses_invoice_id: 'c',
        total_paise: -30000,
        balance_paise: -30000,
      }),
      mkInvoice('d', 'INV-4', 30500),
    ];
    const stats = computeDashboardStats({
      invoices,
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });
    const ar = computeReceivables(
      invoices,
      '2026-08-27',
      NO_ADVANCES,
      [mkCustomer()],
    );
    expect(stats.outstandingReceivablesPaise).toBe(
      ar.totals.outstanding_paise,
    );
  });

  it('outstanding-payables equals computePayables totals for the same inputs', () => {
    const purchases: Purchase[] = [
      mkPurchase('p1', 'BILL-1', 12000),
      mkPurchase('p2', 'BILL-2', 8000, {
        paid_paise: 3000,
        balance_paise: 5000,
      }),
      mkPurchase('p3', 'BILL-3', 15000, { reversed_by_purchase_id: 'dn3' }),
      mkPurchase('dn3', 'BILL-3-DN', -15000, {
        reverses_purchase_id: 'p3',
        total_paise: -15000,
        balance_paise: -15000,
      }),
    ];
    const stats = computeDashboardStats({
      invoices: [],
      purchases,
      customers: [],
      suppliers: [mkSupplier()],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });
    const ap = computePayables(purchases, '2026-08-27', NO_ADVANCES, [
      mkSupplier(),
    ]);
    expect(stats.outstandingPayablesPaise).toBe(ap.totals.outstanding_paise);
  });
});

describe('computeDashboardStats — individual filter cases', () => {
  it('derives a six-month sales series and ranks customer exposure', () => {
    const stats = computeDashboardStats({
      invoices: [
        mkInvoice('old', 'INV-OLD', 12000, { invoice_date: '2026-04-12' }),
        mkInvoice('new', 'INV-NEW', 25000, { invoice_date: '2026-08-12' }),
      ],
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });

    expect(stats.analytics.monthly).toHaveLength(6);
    expect(stats.analytics.monthly.map((month) => month.key)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
    expect(stats.analytics.monthly[1].sales_paise).toBe(12000);
    expect(stats.analytics.monthly[5].sales_paise).toBe(25000);
    expect(stats.analytics.topCustomers).toEqual([
      { name: 'Ravi', outstanding_paise: 37000 },
    ]);
  });

  it('excludes recycled invoices from the count and Recent list', () => {
    const invoices: Invoice[] = [
      mkInvoice('a', 'INV-1', 1000),
      mkInvoice('b', 'INV-2', 2000, { deleted_at: '2026-08-27T00:00:00Z' }),
    ];
    const stats = computeDashboardStats({
      invoices,
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });
    expect(stats.invoices).toBe(1);
    expect(stats.recentInvoices.map((r) => r.number)).toEqual(['INV-1']);
    expect(stats.diagnostics.recycledInvoices).toBe(1);
  });

  it('does not count a credit note as an invoice', () => {
    const invoices: Invoice[] = [
      mkInvoice('a', 'INV-1', 5000, { reversed_by_invoice_id: 'cn' }),
      mkInvoice('cn', 'INV-1-CN', -5000, {
        reverses_invoice_id: 'a',
        total_paise: -5000,
        balance_paise: -5000,
      }),
    ];
    const stats = computeDashboardStats({
      invoices,
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });
    expect(stats.invoices).toBe(0);
    expect(stats.recentInvoices).toEqual([]);
    // The reversed original + credit note net to zero outstanding.
    expect(stats.outstandingReceivablesPaise).toBe(0);
  });

  it('respects the recentLimit parameter and orders by invoice_date desc', () => {
    const invoices: Invoice[] = [
      mkInvoice('a', 'INV-1', 100, { invoice_date: '2026-08-01' }),
      mkInvoice('b', 'INV-2', 200, { invoice_date: '2026-08-05' }),
      mkInvoice('c', 'INV-3', 300, { invoice_date: '2026-08-10' }),
      mkInvoice('d', 'INV-4', 400, { invoice_date: '2026-08-20' }),
      mkInvoice('e', 'INV-5', 500, { invoice_date: '2026-08-25' }),
      mkInvoice('f', 'INV-6', 600, { invoice_date: '2026-08-26' }),
    ];
    const stats = computeDashboardStats({
      invoices,
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
      recentLimit: 3,
    });
    expect(stats.invoices).toBe(6);
    expect(stats.recentInvoices.map((r) => r.number)).toEqual([
      'INV-6',
      'INV-5',
      'INV-4',
    ]);
  });

  it('receivables number nets a partial payment against the invoice total', () => {
    const invoices: Invoice[] = [
      mkInvoice('a', 'INV-1', 10000, {
        paid_paise: 3000,
        balance_paise: 7000,
      }),
    ];
    const stats = computeDashboardStats({
      invoices,
      purchases: [],
      customers: [mkCustomer()],
      suppliers: [],
      advances: NO_ADVANCES,
      itemCount: 0,
      asOfYmd: '2026-08-27',
    });
    expect(stats.outstandingReceivablesPaise).toBe(7000);
  });
});
