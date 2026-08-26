// §24 Regression-assertion unit tests. Each assertion must (a) pass on a
// clean, well-formed row, and (b) throw a RegressionAssertionError with the
// right `check` slug when the invariant is violated. If someone renames a
// check or silently softens it, one of these tests should trip.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../db/database';
import type {
  Business,
  Customer,
  Invoice,
  InvoiceLine,
  Item,
  ItemStock,
  JournalEntry,
  JournalLine,
  Payment,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
  Warehouse,
} from '../db/types';
import {
  RegressionAssertionError,
  assertAccountingBalanced,
  assertInvoiceDueNonNegative,
  assertPaymentAllocationsBounded,
  assertSalesReturnQtyBounded,
  assertInventoryIdentity,
  assertReceivablesConsistent,
  assertRoundOffIdentity,
  assertNoDuplicateInvoiceNumbers,
  runFullRegressionSuite,
} from './regressionAssertions';

let db: BusinessVaultDB;
const businessId = 'biz_ra';
const customerId = 'cust_ra';
const warehouseId = 'wh_ra';
const itemId = 'item_ra';

async function seedMinimal(): Promise<void> {
  const now = new Date().toISOString();
  const business: Business = {
    id: businessId,
    name: 'RA Traders',
    legal_name: 'RA Traders',
    gstin: null,
    pan: null,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    state_code: '',
    pincode: '',
    country: 'IN',
    phone: '',
    email: '',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  } as Business;
  await db.businesses.add(business);

  const customer: Customer = {
    id: customerId,
    business_id: businessId,
    name: 'Test Customer',
    phone: '',
    email: '',
    gstin: null,
    billing_address: '',
    shipping_address: '',
    state: '',
    state_code: '',
    opening_balance_paise: 0,
    credit_limit_paise: 0,
    notes: '',
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.customers.add(customer);

  const warehouse: Warehouse = {
    id: warehouseId,
    business_id: businessId,
    name: 'Main',
    address: '',
    is_default: 1,
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.warehouses.add(warehouse);

  const item: Item = {
    id: itemId,
    business_id: businessId,
    sku: 'SKU-1',
    name: 'Widget',
    description: '',
    hsn: '8471',
    category_id: null,
    unit_id: 'PCS',
    sale_price_paise: 10000,
    purchase_price_paise: 8000,
    tax_rate_bps: 1800,
    cess_rate_bps: 0,
    is_service: 0,
    track_inventory: 1,
    opening_qty_micros: 100_000_000, // 100 units
    opening_value_paise: 800_000,
    reorder_level_micros: 0,
    barcode: null,
    image_ref: null,
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.items.add(item);
}

function makeInvoiceRow(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? ulid(),
    business_id: businessId,
    invoice_number: 'INV-000001',
    invoice_date: '2026-08-26',
    due_date: null,
    customer_id: customerId,
    customer_state_code: '',
    place_of_supply: '',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: 10000,
    discount_paise: 0,
    taxable_paise: 10000,
    cgst_paise: 900,
    sgst_paise: 900,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: 11800,
    total_paise: 11800,
    paid_paise: 0,
    balance_paise: 11800,
    status: 'posted',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: 'je1',
    deleted_at: null,
    deleted_reason: null,
    deletion_reversal_journal_id: null,
    signature_attachment_id: null,
    created_at: now,
    updated_at: now,
    entity_version: 1,
    ...overrides,
  } as Invoice;
}

async function seedBalancedJournal(): Promise<void> {
  const entryId = ulid();
  const now = new Date().toISOString();
  const entry: JournalEntry = {
    id: entryId,
    business_id: businessId,
    entry_number: 'JE-1',
    entry_date: '2026-08-26',
    narration: '',
    ref_type: 'invoice',
    ref_id: null,
    reversed_by_id: null,
    reverses_id: null,
    total_debit_paise: 10000,
    total_credit_paise: 10000,
    posted: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  const lines: JournalLine[] = [
    {
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: 1,
      account_id: 'A/R',
      debit_paise: 10000,
      credit_paise: 0,
      party_type: null,
      party_id: null,
      description: '',
    },
    {
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: 2,
      account_id: 'Sales',
      debit_paise: 0,
      credit_paise: 10000,
      party_type: null,
      party_id: null,
      description: '',
    },
  ];
  await db.journal_entries.add(entry);
  await db.journal_lines.bulkAdd(lines);
}

beforeEach(async () => {
  db = new BusinessVaultDB(`bv_ra_${ulid()}`);
  await db.open();
  await seedMinimal();
});

describe('§24 assertAccountingBalanced', () => {
  it('passes on a balanced journal', async () => {
    await seedBalancedJournal();
    await expect(assertAccountingBalanced(businessId, { db })).resolves.toBeUndefined();
  });

  it('throws RegressionAssertionError when debits != credits', async () => {
    const entryId = ulid();
    const now = new Date().toISOString();
    await db.journal_entries.add({
      id: entryId,
      business_id: businessId,
      entry_number: 'BAD',
      entry_date: '2026-08-26',
      narration: '',
      ref_type: 'invoice',
      ref_id: null,
      reversed_by_id: null,
      reverses_id: null,
      total_debit_paise: 5000,
      total_credit_paise: 5000,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    });
    await db.journal_lines.add({
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: 1,
      account_id: 'A/R',
      debit_paise: 5000,
      credit_paise: 0,
      party_type: null,
      party_id: null,
      description: '',
    });
    // credit line deliberately missing
    await expect(
      assertAccountingBalanced(businessId, { db }),
    ).rejects.toThrow(RegressionAssertionError);
  });
});

describe('§24 assertInvoiceDueNonNegative', () => {
  it('passes when balance is zero or positive', () => {
    assertInvoiceDueNonNegative(makeInvoiceRow({ balance_paise: 0 }));
    assertInvoiceDueNonNegative(makeInvoiceRow({ balance_paise: 5000 }));
  });

  it('throws when balance is negative on an active invoice', () => {
    expect(() =>
      assertInvoiceDueNonNegative(makeInvoiceRow({ balance_paise: -100 })),
    ).toThrow(/negative balance/);
  });

  it('ignores recycled invoices even if their balance is negative', () => {
    // deleted_at is set → skipped, no throw.
    assertInvoiceDueNonNegative(
      makeInvoiceRow({ balance_paise: -100, deleted_at: '2026-08-26T00:00:00Z' }),
    );
  });
});

describe('§24 assertPaymentAllocationsBounded', () => {
  const now = new Date().toISOString();
  const base: Payment = {
    id: 'pay1',
    business_id: businessId,
    payment_number: 'PAY-1',
    payment_date: '2026-08-26',
    direction: 'in',
    party_type: 'customer',
    party_id: customerId,
    method: 'cash',
    account_id: 'CASH',
    amount_paise: 5000,
    reference: '',
    notes: '',
    allocations: [],
    journal_entry_id: 'je1',
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };

  it('passes when allocation sum equals amount', () => {
    assertPaymentAllocationsBounded({
      ...base,
      allocations: [{ invoice_id: 'i1', amount_paise: 3000 }, { invoice_id: 'i2', amount_paise: 2000 }],
    });
  });

  it('passes when allocation sum is less (unallocated remainder)', () => {
    assertPaymentAllocationsBounded({
      ...base,
      allocations: [{ invoice_id: 'i1', amount_paise: 3000 }],
    });
  });

  it('throws when allocation sum exceeds amount', () => {
    expect(() =>
      assertPaymentAllocationsBounded({
        ...base,
        allocations: [
          { invoice_id: 'i1', amount_paise: 3000 },
          { invoice_id: 'i2', amount_paise: 2500 },
        ],
      }),
    ).toThrow(/allocates 5500 paise but total amount is only 5000/);
  });
});

describe('§24 assertRoundOffIdentity', () => {
  it('passes when total = pre-round + round-off', () => {
    assertRoundOffIdentity(makeInvoiceRow({ pre_round_total_paise: 11760, round_off_paise: 40, total_paise: 11800 }));
  });

  it('throws when the identity is violated', () => {
    expect(() =>
      assertRoundOffIdentity(makeInvoiceRow({ pre_round_total_paise: 11760, round_off_paise: 40, total_paise: 11801 })),
    ).toThrow(/total_paise \(11801\)/);
  });
});

describe('§24 assertNoDuplicateInvoiceNumbers', () => {
  it('passes when all active invoices have distinct numbers', async () => {
    await db.invoices.add(makeInvoiceRow({ id: 'i1', invoice_number: 'INV-1', journal_entry_id: 'je1' }));
    await db.invoices.add(makeInvoiceRow({ id: 'i2', invoice_number: 'INV-2', journal_entry_id: 'je2' }));
    await expect(
      assertNoDuplicateInvoiceNumbers(businessId, { db }),
    ).resolves.toBeUndefined();
  });

  it('allows recycled invoices to share a number with an active one (§4 reuse)', async () => {
    await db.invoices.add(makeInvoiceRow({ id: 'i1', invoice_number: 'INV-1', deleted_at: '2026-08-26T00:00:00Z' }));
    await db.invoices.add(makeInvoiceRow({ id: 'i2', invoice_number: 'INV-1' }));
    await expect(
      assertNoDuplicateInvoiceNumbers(businessId, { db }),
    ).resolves.toBeUndefined();
  });

  it('throws when two ACTIVE invoices share a number', async () => {
    await db.invoices.add(makeInvoiceRow({ id: 'i1', invoice_number: 'INV-1' }));
    await db.invoices.add(makeInvoiceRow({ id: 'i2', invoice_number: 'INV-1' }));
    await expect(
      assertNoDuplicateInvoiceNumbers(businessId, { db }),
    ).rejects.toThrow(/used by both/);
  });
});

describe('§24 assertInventoryIdentity', () => {
  it('passes when current stock = opening + inbound - outbound', async () => {
    // Opening = 100 (see seed). Add a stock row of 100 across one warehouse
    // and NO movements — the identity should hold (100 = 100 + 0).
    await db.item_stock.add({
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      qty_micros: 100_000_000,
      avg_cost_paise: 8000,
      updated_at: new Date().toISOString(),
    });
    await expect(
      assertInventoryIdentity(businessId, itemId, { db }),
    ).resolves.toBeUndefined();
  });

  it('passes with a sale movement (outbound -2 units)', async () => {
    // 100 opening + (-2) sale = 98 current.
    await db.item_stock.add({
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      qty_micros: 98_000_000,
      avg_cost_paise: 8000,
      updated_at: new Date().toISOString(),
    });
    const mv: StockMovement = {
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      movement_type: 'sale',
      qty_micros: -2_000_000,
      unit_cost_paise: 8000,
      ref_type: 'invoice',
      ref_id: 'inv1',
      occurred_at: new Date().toISOString(),
      notes: '',
    };
    await db.stock_movements.add(mv);
    await expect(
      assertInventoryIdentity(businessId, itemId, { db }),
    ).resolves.toBeUndefined();
  });

  it('throws when current stock drifts from movement-log expectation', async () => {
    // 100 opening + no movements should yield 100. If item_stock says 95,
    // the cache drifted — assertion must fire.
    await db.item_stock.add({
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      qty_micros: 95_000_000, // wrong on purpose
      avg_cost_paise: 8000,
      updated_at: new Date().toISOString(),
    });
    await expect(
      assertInventoryIdentity(businessId, itemId, { db }),
    ).rejects.toThrow(/current stock 95000000 != opening \(100000000\)/);
  });
});

describe('§24 assertReceivablesConsistent', () => {
  it('passes on an empty business', async () => {
    await expect(
      assertReceivablesConsistent(businessId, { db }),
    ).resolves.toBeUndefined();
  });

  it('passes when totals match per-customer breakdown', async () => {
    await db.invoices.add(
      makeInvoiceRow({
        id: 'i1',
        customer_id: customerId,
        total_paise: 5000,
        balance_paise: 5000,
      }),
    );
    await expect(
      assertReceivablesConsistent(businessId, { db }),
    ).resolves.toBeUndefined();
  });
});

describe('§24 assertSalesReturnQtyBounded', () => {
  it('passes when returned qty <= original invoice line qty', async () => {
    const now = new Date().toISOString();
    const invId = 'inv-sr-1';
    const lineId = 'line-sr-1';
    await db.invoices.add(makeInvoiceRow({ id: invId, invoice_number: 'INV-SR-1' }));
    const line: InvoiceLine = {
      id: lineId,
      business_id: businessId,
      invoice_id: invId,
      line_no: 1,
      item_id: itemId,
      description: '',
      hsn: '8471',
      warehouse_id: warehouseId,
      qty_micros: 5_000_000, // 5 units shipped
      unit_price_paise: 10000,
      discount_pct_bps: 0,
      discount_paise: 0,
      taxable_paise: 50000,
      tax_rate_bps: 1800,
      cgst_paise: 4500,
      sgst_paise: 4500,
      igst_paise: 0,
      cess_paise: 0,
      line_total_paise: 59000,
    };
    await db.invoice_lines.add(line);

    const srId = 'sr-1';
    const sr: SalesReturn = {
      id: srId,
      business_id: businessId,
      return_number: 'SR-1',
      return_date: '2026-08-26',
      original_invoice_id: invId,
      customer_id: customerId,
      subtotal_paise: 20000,
      discount_paise: 0,
      taxable_paise: 20000,
      cgst_paise: 1800,
      sgst_paise: 1800,
      igst_paise: 0,
      cess_paise: 0,
      round_off_paise: 0,
      round_off_mode: 'none',
      pre_round_total_paise: 23600,
      total_paise: 23600,
      apply_to_balance_paise: 23600,
      customer_credit_paise: 0,
      status: 'posted',
      reason: '',
      notes: '',
      journal_entry_id: 'jesr1',
      reversed_credit_note_invoice_id: null,
      legacy_migration_classification: null,
      device_id: 'dev1',
      deleted_at: null,
      deleted_reason: null,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    await db.sales_returns.add(sr);
    const sri: SalesReturnItem = {
      id: ulid(),
      business_id: businessId,
      sales_return_id: srId,
      original_invoice_id: invId,
      original_invoice_line_id: lineId,
      item_id: itemId,
      description: '',
      hsn: '8471',
      warehouse_id: warehouseId,
      line_no: 1,
      qty_micros: 2_000_000, // 2 units returned, of 5 shipped — OK
      unit_price_paise: 10000,
      discount_pct_bps: 0,
      discount_paise: 0,
      taxable_paise: 20000,
      tax_rate_bps: 1800,
      cgst_paise: 1800,
      sgst_paise: 1800,
      igst_paise: 0,
      cess_paise: 0,
      line_total_paise: 23600,
    };
    await db.sales_return_items.add(sri);

    await expect(
      assertSalesReturnQtyBounded(sr, { db }),
    ).resolves.toBeUndefined();
  });
});

describe('§24 runFullRegressionSuite', () => {
  it('returns ok=true on a clean minimal business', async () => {
    // Seed a live invoice, its journal, and the matching cash-in payment so
    // the balance-check has real data to chew on.
    await seedBalancedJournal();
    await db.invoices.add(
      makeInvoiceRow({
        id: 'inv-x',
        invoice_number: 'INV-CLEAN-1',
        journal_entry_id: 'je1',
      }),
    );
    await db.item_stock.add({
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      qty_micros: 100_000_000,
      avg_cost_paise: 8000,
      updated_at: new Date().toISOString(),
    });
    const result = await runFullRegressionSuite(businessId, { db });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('aggregates multiple simultaneous failures without short-circuiting', async () => {
    // Two independent invariant breaks: round-off identity and duplicate
    // invoice numbers. Both should surface, not just the first.
    await db.invoices.add(
      makeInvoiceRow({
        id: 'a',
        invoice_number: 'DUP',
        pre_round_total_paise: 100,
        round_off_paise: 0,
        total_paise: 999, // round-off identity broken
      }),
    );
    await db.invoices.add(
      makeInvoiceRow({
        id: 'b',
        invoice_number: 'DUP',
      }),
    );
    // Wrong stock cache for the item so inventory identity trips too.
    await db.item_stock.add({
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      qty_micros: 50_000_000,
      avg_cost_paise: 8000,
      updated_at: new Date().toISOString(),
    });
    const result = await runFullRegressionSuite(businessId, { db });
    expect(result.ok).toBe(false);
    const slugs = result.failures.map((f) => f.check);
    expect(slugs).toContain('round-off-identity');
    expect(slugs).toContain('no-duplicate-invoice-numbers');
    expect(slugs).toContain('inventory-identity');
  });
});
