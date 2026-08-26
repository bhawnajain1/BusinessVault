import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../db/database';
import type { Account, Business, Customer, Item, ItemStock, Warehouse } from '../db/types';
import { InvoiceService, InvoiceNumberConflictError } from './InvoiceService';
import { trialBalance, profitAndLoss, balanceSheet } from './AccountingService';
import { gstSummary } from './gst';
import { computeReceivables } from './partyLedger';
import {
  allocateInvoiceNumber,
  getNextAvailableInvoiceNumber,
  isInvoiceNumberAvailable,
  validateInvoiceNumber,
} from './invoiceNumbering';

let db: BusinessVaultDB;
let service: InvoiceService;

const businessId = '01BUSINESS';
const deviceId = '01DEVICE';
const customerId = '01CUSTOMER';
const warehouseId = '01WAREHOUSE';
const itemId = '01ITEM';

async function seed(): Promise<void> {
  const now = new Date().toISOString();

  const business: Business = {
    id: businessId,
    name: 'Sharma Electronics',
    legal_name: 'Sharma Electronics Pvt Ltd',
    gstin: '29AABCS1234A1Z5',
    pan: 'AABCS1234A',
    address_line1: '1 MG Road',
    address_line2: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    state_code: '29',
    pincode: '560001',
    country: 'IN',
    phone: '9999999999',
    email: 'owner@sharma.example',
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
  };
  await db.businesses.add(business);

  const customer: Customer = {
    id: customerId,
    business_id: businessId,
    name: 'Ravi Kumar',
    phone: '9000000001',
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
    opening_qty_micros: 100_000_000,
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

  const stock: ItemStock = {
    id: ulid(),
    business_id: businessId,
    item_id: itemId,
    warehouse_id: warehouseId,
    qty_micros: 100_000_000, // 100 units
    avg_cost_paise: 8000,
    updated_at: now,
  };
  await db.item_stock.add(stock);

  const accounts: Account[] = [
    accRow('1200', 'Accounts Receivable', 'asset'),
    accRow('1400', 'Inventory', 'asset'),
    accRow('4000', 'Sales Revenue', 'income'),
    accRow('2210', 'Output CGST', 'liability'),
    accRow('2220', 'Output SGST', 'liability'),
    accRow('2230', 'Output IGST', 'liability'),
    accRow('2240', 'Output Cess', 'liability'),
    accRow('4900', 'Round Off', 'income'),
    accRow('5020', 'Cost of Goods Sold', 'expense'),
  ];
  for (const a of accounts) await db.accounts.add(a);
}

function accRow(code: string, name: string, type: Account['type']): Account {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    business_id: businessId,
    code,
    name,
    type,
    subtype: '',
    parent_id: null,
    opening_balance_paise: 0,
    is_system: 1,
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
}

function intrastateLine(): {
  item_id: string;
  hsn: string;
  warehouse_id: string;
  qty_micros: number;
  unit_price_paise: number;
  taxable_paise: number;
  tax_rate_bps: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  line_total_paise: number;
} {
  // 2 units @ ₹100 = ₹200 net, 18% GST => CGST 9% ₹18, SGST 9% ₹18, total ₹236
  return {
    item_id: itemId,
    hsn: '8471',
    warehouse_id: warehouseId,
    qty_micros: 2_000_000,
    unit_price_paise: 10000,
    taxable_paise: 20000,
    tax_rate_bps: 1800,
    cgst_paise: 1800,
    sgst_paise: 1800,
    igst_paise: 0,
    line_total_paise: 23600,
  };
}

beforeEach(async () => {
  const uniqueName = `bv_test_${Math.random().toString(36).slice(2)}`;
  db = new BusinessVaultDB(uniqueName);
  await db.open();
  await seed();
  service = new InvoiceService(db);
});

describe('InvoiceService.createInvoice', () => {
  it('runs all 6 steps atomically', async () => {
    const invoice = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    expect(invoice.id).toBeTruthy();
    expect(invoice.total_paise).toBe(23600);

    // 1. invoice row
    const row = await db.invoices.get(invoice.id);
    expect(row).toBeDefined();

    // 2. invoice lines
    const lines = await db.invoice_lines.where('invoice_id').equals(invoice.id).toArray();
    expect(lines).toHaveLength(1);

    // 3. stock reduced + movement written
    const stock = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stock?.qty_micros).toBe(100_000_000 - 2_000_000);
    const moves = await db.stock_movements
      .where('[business_id+ref_type+ref_id]')
      .equals([businessId, 'invoice', invoice.id])
      .toArray();
    expect(moves).toHaveLength(1);
    expect(moves[0].qty_micros).toBe(-2_000_000);
    expect(moves[0].movement_type).toBe('sale');

    // 5. journal entry + balanced lines
    const je = await db.journal_entries.get(invoice.journal_entry_id);
    expect(je).toBeDefined();
    const jLines = await db.journal_lines
      .where('entry_id')
      .equals(invoice.journal_entry_id)
      .toArray();
    const debits = jLines.reduce((a, l) => a + l.debit_paise, 0);
    const credits = jLines.reduce((a, l) => a + l.credit_paise, 0);
    expect(debits).toBe(credits);
    // 23600 = AR/Sales/GST + 16000 = Dr COGS / Cr Inv (2 units × ₹80 avg cost).
    expect(debits).toBe(23600 + 16000);

    // 6. sync_event emitted
    const events = await db.sync_events
      .where('[business_id+entity_type+entity_id]')
      .equals([businessId, 'invoice', invoice.id])
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('created');
    expect(events[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rolls back all 6 steps if any step throws', async () => {
    // Force failure by deleting the required Sales Revenue account.
    const salesAcc = await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '4000'])
      .first();
    if (salesAcc) await db.accounts.delete(salesAcc.id);

    await expect(
      service.createInvoice({
        business_id: businessId,
        device_id: deviceId,
        invoice_number: 'INV-ROLLBACK',
        invoice_date: '2026-08-19',
        customer_id: customerId,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: '2026-27',
        lines: [intrastateLine()],
      }),
    ).rejects.toThrow();

    // Nothing must have been persisted.
    const invoices = await db.invoices.where('business_id').equals(businessId).count();
    expect(invoices).toBe(0);
    const lines = await db.invoice_lines.where('business_id').equals(businessId).count();
    expect(lines).toBe(0);
    const moves = await db.stock_movements.where('business_id').equals(businessId).count();
    expect(moves).toBe(0);
    const je = await db.journal_entries.where('business_id').equals(businessId).count();
    expect(je).toBe(0);
    const jl = await db.journal_lines.where('business_id').equals(businessId).count();
    expect(jl).toBe(0);
    const evts = await db.sync_events.where('business_id').equals(businessId).count();
    expect(evts).toBe(0);
    // Stock unchanged.
    const stock = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stock?.qty_micros).toBe(100_000_000);
  });

  it('interstate invoice books IGST only', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-IGST',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '27', // Maharashtra
      place_of_supply: '27',
      is_interstate: true,
      financial_year: '2026-27',
      lines: [
        {
          item_id: itemId,
          hsn: '8471',
          warehouse_id: warehouseId,
          qty_micros: 1_000_000,
          unit_price_paise: 10000,
          taxable_paise: 10000,
          tax_rate_bps: 1800,
          cgst_paise: 0,
          sgst_paise: 0,
          igst_paise: 1800,
          line_total_paise: 11800,
        },
      ],
    });
    expect(inv.igst_paise).toBe(1800);
    expect(inv.cgst_paise).toBe(0);
    expect(inv.sgst_paise).toBe(0);

    const jLines = await db.journal_lines.where('entry_id').equals(inv.journal_entry_id).toArray();
    const debits = jLines.reduce((a, l) => a + l.debit_paise, 0);
    const credits = jLines.reduce((a, l) => a + l.credit_paise, 0);
    expect(debits).toBe(credits);
    // 11800 = AR/Sales/GST side + 8000 = Dr COGS / Cr Inventory pair.
    expect(debits).toBe(11800 + 8000);
  });

  it('rejects mixed GST (interstate + CGST)', async () => {
    await expect(
      service.createInvoice({
        business_id: businessId,
        device_id: deviceId,
        invoice_number: 'INV-BAD',
        invoice_date: '2026-08-19',
        customer_id: customerId,
        customer_state_code: '27',
        place_of_supply: '27',
        is_interstate: true,
        financial_year: '2026-27',
        lines: [{ ...intrastateLine() }], // intrastate line on interstate invoice
      }),
    ).rejects.toThrow(/Interstate/);
  });

  it('idempotency: same key returns existing invoice, no double effect', async () => {
    const input = {
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-IDEMP',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      idempotencyKey: 'client-req-abc123',
    };
    const first = await service.createInvoice(input);
    const second = await service.createInvoice(input);
    expect(second.id).toBe(first.id);

    // Only one invoice, one journal, one stock movement.
    expect(await db.invoices.where('business_id').equals(businessId).count()).toBe(1);
    expect(await db.journal_entries.where('business_id').equals(businessId).count()).toBe(1);
    expect(await db.stock_movements.where('business_id').equals(businessId).count()).toBe(1);

    // Stock decremented exactly once.
    const stock = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stock?.qty_micros).toBe(100_000_000 - 2_000_000);
  });

  it('rejects a duplicate invoice_number for the same business', async () => {
    const base = {
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-DUP-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    };
    await service.createInvoice(base);
    await expect(service.createInvoice(base)).rejects.toThrow(/already exists/i);
    // Only the first invoice persisted; no leaked lines / movements.
    expect(await db.invoices.where('business_id').equals(businessId).count()).toBe(1);
    expect(await db.invoice_lines.where('business_id').equals(businessId).count()).toBe(1);
    expect(await db.stock_movements.where('business_id').equals(businessId).count()).toBe(1);
  });
});

describe('InvoiceService — subtotal_paise is integer (regression)', () => {
  it('produces an integer subtotal_paise even when qty*price/1_000_000 is fractional', async () => {
    // 3 units of qty at 333333 micros = 999999 micros = 0.999999 units
    // unit_price = 100 paise. gross = 100 * 999999 / 1_000_000 = 99.9999.
    // Prior: subtotal_paise was 99.9999 (float). Now: bankersRound => 100.
    const line = {
      item_id: itemId,
      hsn: '8471',
      warehouse_id: warehouseId,
      qty_micros: 999_999,
      unit_price_paise: 100,
      taxable_paise: 100,
      tax_rate_bps: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      line_total_paise: 100,
    };
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-INT-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [line],
    });
    expect(Number.isInteger(inv.subtotal_paise)).toBe(true);
  });
});

describe('InvoiceService — cess and round-off posting (regression)', () => {
  it('posts a Cess credit line to account code 2240 when line cess > 0', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-CESS-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [
        {
          ...intrastateLine(),
          // Add ₹5 cess and roll it into line_total
          cess_paise: 500,
          line_total_paise: 24100,
        },
      ],
    });
    const cessAcc = await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '2240'])
      .first();
    expect(cessAcc).toBeDefined();
    const jLines = await db.journal_lines
      .where('entry_id')
      .equals(inv.journal_entry_id)
      .toArray();
    const cessLine = jLines.find((l) => l.account_id === cessAcc!.id);
    expect(cessLine).toBeDefined();
    expect(cessLine!.credit_paise).toBe(500);
    expect(cessLine!.debit_paise).toBe(0);

    // debits still balance credits
    const d = jLines.reduce((a, l) => a + l.debit_paise, 0);
    const c = jLines.reduce((a, l) => a + l.credit_paise, 0);
    expect(d).toBe(c);
    // 24100 = AR/Sales/GST/Cess + 16000 = Dr COGS(8000) / Cr Inv(8000) × 2 units.
    expect(d).toBe(24100 + 16000);

    // total_paise reflects cess
    expect(inv.total_paise).toBe(24100);
    expect(inv.cess_paise).toBe(500);
  });

  it('posts round-off to dedicated 4900 account (not Sales Revenue)', async () => {
    // Craft a line whose taxable+gst != line_total to force a round-off diff.
    // Use round_off_paise on the invoice header directly.
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-ROFF-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      round_off_paise: 40, // ₹0.40 round up
    });
    const roundAcc = await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '4900'])
      .first();
    const salesAcc = await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '4000'])
      .first();
    expect(roundAcc).toBeDefined();
    const jLines = await db.journal_lines
      .where('entry_id')
      .equals(inv.journal_entry_id)
      .toArray();
    const roundLine = jLines.find(
      (l) => l.account_id === roundAcc!.id && l.description === 'Round off',
    );
    expect(roundLine).toBeDefined();
    expect(roundLine!.credit_paise).toBe(40);
    // Sales revenue line must be exactly the taxable — not polluted with round-off.
    const salesLines = jLines.filter((l) => l.account_id === salesAcc!.id);
    expect(salesLines).toHaveLength(1);
    expect(salesLines[0].credit_paise).toBe(20000);
  });
});

describe('InvoiceService.updateInvoice', () => {
  it('reverses the original and reissues under the same invoice_number', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-EDIT-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    const reissued = await service.updateInvoice(inv.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    expect(reissued.id).not.toBe(inv.id);
    expect(reissued.invoice_number).toBe('INV-EDIT-1');
    const original = await db.invoices.get(inv.id);
    expect(original?.reversed_by_invoice_id).not.toBeNull();
  });

  it('refuses to edit an already-superseded invoice', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-EDIT-2',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    // First edit reverses the original and creates a reissue. The original's
    // reversed_by_invoice_id is now set — a second edit against the original
    // id must be refused (caller should target the reissued id instead).
    await service.updateInvoice(inv.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await expect(
      service.updateInvoice(inv.id, {
        business_id: businessId,
        device_id: deviceId,
        invoice_date: '2026-08-19',
        customer_id: customerId,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: '2026-27',
        lines: [intrastateLine()],
      }),
    ).rejects.toThrow(/already-superseded/);
  });
});

describe('InvoiceService.deleteInvoice / restoreInvoice', () => {
  it('soft-deletes an invoice and restores it (idempotent both ways)', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-DEL-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    await service.deleteInvoice(inv.id, 'wrong entry');
    let row = await db.invoices.get(inv.id);
    expect(row?.deleted_at).toBeTruthy();
    expect(row?.deleted_reason).toBe('wrong entry');

    // Idempotent — a second delete is a no-op (no throw, no double-stamp change).
    const firstDeletedAt = row!.deleted_at;
    await service.deleteInvoice(inv.id, 'again');
    row = await db.invoices.get(inv.id);
    expect(row?.deleted_at).toBe(firstDeletedAt);
    expect(row?.deleted_reason).toBe('wrong entry');

    // Journal entry + lines are NOT removed — audit chain intact.
    const je = await db.journal_entries.get(inv.journal_entry_id);
    expect(je).toBeDefined();
    const jLines = await db.journal_lines
      .where('entry_id')
      .equals(inv.journal_entry_id)
      .toArray();
    expect(jLines.length).toBeGreaterThan(0);

    // Restore clears the flag.
    await service.restoreInvoice(inv.id);
    row = await db.invoices.get(inv.id);
    expect(row?.deleted_at).toBeNull();
    expect(row?.deleted_reason).toBeNull();

    // Restoring an already-live invoice is a no-op.
    await service.restoreInvoice(inv.id);
    row = await db.invoices.get(inv.id);
    expect(row?.deleted_at).toBeNull();
  });

  it('writes a "deleted" sync event so the change is journaled', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-DEL-EVT',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await service.deleteInvoice(inv.id, 'test');

    const events = await db.sync_events
      .where('[business_id+entity_type+entity_id]')
      .equals([businessId, 'invoice', inv.id])
      .toArray();
    expect(events.some((e) => e.operation === 'deleted')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recycle Bin accounting (feedback_1_to_7.md §9)
// ---------------------------------------------------------------------------
// Core invariant: ACTIVE invoice → +X effect on all financial reports;
// RECYCLED invoice → 0 effect; RESTORED → +X again. Journals stay in the
// database forever — the effect is neutralised by mirror-journal reversal,
// not by mutation. The tests below verify each surface: journal reversal,
// TB balance, P&L, Balance Sheet, GST summary, and receivables ledger.
// ---------------------------------------------------------------------------

describe('InvoiceService — Recycle Bin accounting (feedback §9)', () => {
  it('deleteInvoice posts a mirror journal so TB / P&L / BS drop the invoice', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-REC-1',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    // Baseline: TB records the invoice postings.
    const tbBefore = await trialBalance(businessId, new Date('2026-08-31'), { db });
    const receivablesBefore = tbBefore.find((r) => r.code === '1200');
    const revenueBefore = tbBefore.find((r) => r.code === '4000');
    expect(receivablesBefore?.balance_paise).toBe(inv.total_paise);
    expect(revenueBefore?.balance_paise).toBe(inv.taxable_paise);

    // Recycle.
    await service.deleteInvoice(inv.id, 'wrong entry');
    const row = await db.invoices.get(inv.id);
    expect(row?.deleted_at).toBeTruthy();
    expect(row?.deletion_reversal_journal_id).toBeTruthy();

    // Original journal + all its lines still exist (audit intact).
    const original = await db.journal_entries.get(inv.journal_entry_id);
    expect(original).toBeDefined();
    const originalLineCount = await db.journal_lines
      .where('entry_id')
      .equals(inv.journal_entry_id)
      .count();
    expect(originalLineCount).toBeGreaterThan(0);

    // Mirror journal exists with reverses_id pointing back at the original.
    const mirror = await db.journal_entries.get(row!.deletion_reversal_journal_id!);
    expect(mirror).toBeDefined();
    expect(mirror?.reverses_id).toBe(inv.journal_entry_id);
    expect(mirror?.ref_type).toBe('reversal');
    expect(mirror?.ref_id).toBe(inv.id);
    expect(mirror?.total_debit_paise).toBe(original!.total_credit_paise);
    expect(mirror?.total_credit_paise).toBe(original!.total_debit_paise);

    // Trial balance now nets to zero for the affected accounts.
    const tbAfter = await trialBalance(businessId, new Date('2026-08-31'), { db });
    const receivablesAfter = tbAfter.find((r) => r.code === '1200');
    const revenueAfter = tbAfter.find((r) => r.code === '4000');
    expect(receivablesAfter?.balance_paise).toBe(0);
    expect(revenueAfter?.balance_paise).toBe(0);

    // TB always balances (fundamental invariant).
    const sumDr = tbAfter.reduce((s, r) => s + r.debits_paise, 0);
    const sumCr = tbAfter.reduce((s, r) => s + r.credits_paise, 0);
    expect(sumDr).toBe(sumCr);

    // P&L: revenue is back to zero.
    const pl = await profitAndLoss(
      businessId,
      new Date('2026-04-01'),
      new Date('2026-08-31'),
      { db },
    );
    expect(pl.revenue_paise).toBe(0);

    // Balance Sheet still balances.
    const bs = await balanceSheet(businessId, new Date('2026-08-31'), {
      db,
      financialYearStart: new Date('2026-04-01'),
    });
    expect(bs.balanced).toBe(true);
    expect(bs.difference_paise).toBe(0);
  });

  it('deleted invoice drops from GST summary and receivables ledger', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-REC-GST',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    // Baseline: GST summary sees it.
    const gstBefore = await gstSummary(
      businessId,
      new Date('2026-08-01'),
      new Date('2026-08-31'),
      { db },
    );
    const slab18Before = gstBefore.find((r) => r.slab === 18);
    expect(slab18Before?.taxable_paise).toBeGreaterThan(0);

    // Baseline: receivables ledger has this customer's outstanding.
    const invsBefore = await db.invoices.where('business_id').equals(businessId).toArray();
    const custsBefore = await db.customers.where('business_id').equals(businessId).toArray();
    const rBefore = computeReceivables(invsBefore, '2026-08-31', [], custsBefore);
    expect(rBefore.totals.outstanding_paise).toBe(inv.total_paise);

    // Recycle.
    await service.deleteInvoice(inv.id, 'wrong customer');

    // GST summary drops the taxable + tax contribution.
    const gstAfter = await gstSummary(
      businessId,
      new Date('2026-08-01'),
      new Date('2026-08-31'),
      { db },
    );
    const slab18After = gstAfter.find((r) => r.slab === 18);
    expect(slab18After?.taxable_paise).toBe(0);
    expect(slab18After?.cgst_paise).toBe(0);
    expect(slab18After?.sgst_paise).toBe(0);

    // Receivables ledger drops the customer's outstanding.
    const invsAfter = await db.invoices.where('business_id').equals(businessId).toArray();
    const rAfter = computeReceivables(invsAfter, '2026-08-31', [], custsBefore);
    expect(rAfter.totals.outstanding_paise).toBe(0);
    expect(rAfter.perInvoice.filter((row) => row.invoice_id === inv.id)).toHaveLength(0);
  });

  it('restoreInvoice re-activates the original effect exactly once', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-REC-RESTORE',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    await service.deleteInvoice(inv.id, 'oops');
    await service.restoreInvoice(inv.id);

    const row = await db.invoices.get(inv.id);
    expect(row?.deleted_at).toBeNull();
    expect(row?.deletion_reversal_journal_id).toBeNull();

    // TB: receivables + revenue back to their original amounts (net of
    // deletion-mirror + restore-mirror = zero delta from the original).
    const tb = await trialBalance(businessId, new Date('2026-08-31'), { db });
    const receivables = tb.find((r) => r.code === '1200');
    const revenue = tb.find((r) => r.code === '4000');
    expect(receivables?.balance_paise).toBe(inv.total_paise);
    expect(revenue?.balance_paise).toBe(inv.taxable_paise);

    // Three journals exist for this invoice: original + deletion-mirror + restore-mirror.
    const relatedEntries = await db.journal_entries
      .where('business_id')
      .equals(businessId)
      .toArray();
    const forThisInvoice = relatedEntries.filter(
      (e) =>
        e.id === inv.journal_entry_id ||
        (e.ref_type === 'reversal' && e.ref_id === inv.id),
    );
    expect(forThisInvoice).toHaveLength(3);
  });

  it('survives repeated delete/restore cycles with balanced TB throughout', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-REC-CYCLE',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    for (let i = 0; i < 3; i++) {
      await service.deleteInvoice(inv.id, `cycle-${i}-delete`);
      let tb = await trialBalance(businessId, new Date('2026-08-31'), { db });
      let sumDr = tb.reduce((s, r) => s + r.debits_paise, 0);
      let sumCr = tb.reduce((s, r) => s + r.credits_paise, 0);
      expect(sumDr).toBe(sumCr);
      expect(tb.find((r) => r.code === '1200')?.balance_paise).toBe(0);

      await service.restoreInvoice(inv.id);
      tb = await trialBalance(businessId, new Date('2026-08-31'), { db });
      sumDr = tb.reduce((s, r) => s + r.debits_paise, 0);
      sumCr = tb.reduce((s, r) => s + r.credits_paise, 0);
      expect(sumDr).toBe(sumCr);
      expect(tb.find((r) => r.code === '1200')?.balance_paise).toBe(inv.total_paise);
    }

    // Six new entries added across three cycles (delete+restore each): so
    // total for this invoice is original + 6 mirrors = 7 entries. Order matters
    // because the entry_date is the invoice_date for all mirrors — TB reads
    // them the same day regardless.
    const forThisInvoice = (
      await db.journal_entries.where('business_id').equals(businessId).toArray()
    ).filter(
      (e) =>
        e.id === inv.journal_entry_id ||
        (e.ref_type === 'reversal' && e.ref_id === inv.id),
    );
    expect(forThisInvoice).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Round-off regression (feedback_1_to_7.md §1)
// ---------------------------------------------------------------------------
// Every mode ('auto' | 'none' | 'manual') must yield a total_paise that
// exactly equals pre_round_total_paise + round_off_paise, and 'auto' must
// snap to the nearest ₹1 via banker's rounding (0.50 → nearest even).
//
// Setup: use two 18%-GST lines at prices tuned to land inside each rounding
// bucket. The intrastateLine() helper is 200 net + 36 GST = 236 paise total,
// which lands on a boundary that's convenient for 'none'/'manual' cases; the
// round-*-line helpers below craft explicit boundaries for 'auto'.
// ---------------------------------------------------------------------------

function customLine(unitPaise: number): ReturnType<typeof intrastateLine> {
  // 1 unit, taxable = unitPaise, 18% intrastate.
  const taxable = unitPaise;
  const cgst = Math.round(taxable * 0.09);
  const sgst = Math.round(taxable * 0.09);
  return {
    item_id: itemId,
    hsn: '8471',
    warehouse_id: warehouseId,
    qty_micros: 1_000_000,
    unit_price_paise: unitPaise,
    taxable_paise: taxable,
    tax_rate_bps: 1800,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: 0,
    line_total_paise: taxable + cgst + sgst,
  };
}

describe('InvoiceService — round-off modes (feedback §1)', () => {
  it("auto: rounds DOWN a total ending in <50 paise to the nearest rupee", async () => {
    // ₹100.30 taxable + 18% = 118.354 → 11835 paise (rounded per-line).
    // Actually per-line taxable is 10030 paise; cgst/sgst = round(10030*0.09)=903+903=1806.
    // Line total = 10030 + 1806 = 11836. auto rounds 11836 → nearest 100 → 11800.
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-DOWN',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [customLine(10030)],
      round_off_mode: 'auto',
    });
    expect(inv.round_off_mode).toBe('auto');
    expect(inv.total_paise % 100).toBe(0);
    expect(inv.pre_round_total_paise + inv.round_off_paise).toBe(inv.total_paise);
    expect(inv.round_off_paise).toBeLessThan(0); // rounded down → negative
  });

  it("auto: rounds UP a total ending in >50 paise to the nearest rupee", async () => {
    // 10080 paise taxable × 18% GST = 10080 + 907 + 907 = 11894. Rounds to 11900.
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-UP',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [customLine(10080)],
      round_off_mode: 'auto',
    });
    expect(inv.round_off_mode).toBe('auto');
    expect(inv.total_paise % 100).toBe(0);
    expect(inv.pre_round_total_paise + inv.round_off_paise).toBe(inv.total_paise);
    expect(inv.round_off_paise).toBeGreaterThan(0);
  });

  it('auto: leaves an exact whole-rupee total unchanged', async () => {
    // intrastateLine() = 23600 paise = ₹236.00 exactly.
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-EXACT',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      round_off_mode: 'auto',
    });
    expect(inv.round_off_paise).toBe(0);
    expect(inv.round_off_mode).toBe('auto');
    expect(inv.total_paise).toBe(23600);
    expect(inv.pre_round_total_paise).toBe(23600);
  });

  it('auto: 50-paise halfway ties round to nearest even rupee (bankers)', async () => {
    // Craft a line that sums to exactly ₹X.50 pre-round.
    // taxable 4237, cgst=sgst=381 (round(4237*0.09)=381), sum=4999. Not 50-boundary.
    // Instead pass a raw pre-round total via a line whose pieces sum to X50.
    // Use taxable=250 gst=100 => not right. Simplest: unit=42, taxable=42,
    // cgst=round(42*0.09)=4, sgst=4 -> 50. Perfect 50-paise.
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-HALF',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [customLine(42)], // total = 42+4+4 = 50 paise = ₹0.50 halfway
      round_off_mode: 'auto',
    });
    // Banker's rounding of 0.5 → 0 (nearest even).
    expect(inv.pre_round_total_paise).toBe(50);
    expect(inv.total_paise).toBe(0);
    expect(inv.round_off_paise).toBe(-50);
  });

  it('none: keeps the exact pre-round total, round_off=0', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-NONE',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [customLine(10037)], // arbitrary sub-rupee
      round_off_mode: 'none',
    });
    expect(inv.round_off_mode).toBe('none');
    expect(inv.round_off_paise).toBe(0);
    expect(inv.total_paise).toBe(inv.pre_round_total_paise);
  });

  it('manual: applies caller-supplied positive round-off', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-MANP',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()], // pre-round 23600
      round_off_mode: 'manual',
      round_off_paise: 400, // +₹4.00
    });
    expect(inv.round_off_mode).toBe('manual');
    expect(inv.round_off_paise).toBe(400);
    expect(inv.total_paise).toBe(24000);
    expect(inv.pre_round_total_paise).toBe(23600);
  });

  it('manual: applies caller-supplied negative round-off', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-MANN',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      round_off_mode: 'manual',
      round_off_paise: -100, // -₹1.00
    });
    expect(inv.round_off_mode).toBe('manual');
    expect(inv.round_off_paise).toBe(-100);
    expect(inv.total_paise).toBe(23500);
    expect(inv.pre_round_total_paise).toBe(23600);
  });

  it('back-compat: caller who omits mode but passes round_off_paise still works', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-LEGACY',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      round_off_paise: 40,
    });
    // Non-zero round_off with no explicit mode ⇒ 'manual' (see InvoiceService.ts).
    expect(inv.round_off_mode).toBe('manual');
    expect(inv.round_off_paise).toBe(40);
    expect(inv.total_paise).toBe(23640);
  });

  it("journal balances to the paise even under 'auto' rounding", async () => {
    // The journal builder is expected to post the diff to '4900 Round Off'
    // so debits === credits === total. We assert directly on the journal_lines.
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'RO-JRNL',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [customLine(10080)],
      round_off_mode: 'auto',
    });
    const lines = await db.journal_lines
      .where('entry_id')
      .equals(inv.journal_entry_id)
      .toArray();
    const debits = lines.reduce((s, l) => s + l.debit_paise, 0);
    const credits = lines.reduce((s, l) => s + l.credit_paise, 0);
    expect(debits).toBe(credits); // trial balance ties to the paise
    // The header journal for this invoice includes AR + COGS on the debit side
    // and Sales + GST + Inventory + Round-Off on the credit side, so the
    // side-totals equal total + COGS, not total alone. The Round-Off account
    // is the one that carries the ₹6 rounding piece; verify it explicitly.
    const roundOffAcct = await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '4900'])
      .first();
    expect(roundOffAcct).toBeTruthy();
    const roundOffLine = lines.find((l) => l.account_id === roundOffAcct!.id);
    expect(roundOffLine).toBeTruthy();
    // auto-mode rounded UP → 4900 posts as a credit (income) equal to +round_off.
    // rounded DOWN would post as a debit (contra-income).
    if (inv.round_off_paise > 0) {
      expect(roundOffLine!.credit_paise).toBe(inv.round_off_paise);
    } else if (inv.round_off_paise < 0) {
      expect(roundOffLine!.debit_paise).toBe(-inv.round_off_paise);
    }
  });
});

describe('InvoiceService — editable invoice number (feedback §3 §4)', () => {
  it('validateInvoiceNumber accepts well-formed numbers and rejects garbage', () => {
    expect(validateInvoiceNumber('INV-000123').ok).toBe(true);
    expect(validateInvoiceNumber('INV-000123', 'INV').ok).toBe(true);
    const wrongPrefix = validateInvoiceNumber('INV-000123', 'SI');
    expect(wrongPrefix.ok).toBe(false);
    expect(validateInvoiceNumber('').ok).toBe(false);
    expect(validateInvoiceNumber('   ').ok).toBe(false);
    expect(validateInvoiceNumber('nonumber').ok).toBe(false);
    expect(validateInvoiceNumber('INV-').ok).toBe(false);
    expect(validateInvoiceNumber('a'.repeat(50)).ok).toBe(false);
  });

  it('isInvoiceNumberAvailable ignores recycled and superseded rows', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    expect(await isInvoiceNumberAvailable(db, businessId, 'INV-000001')).toBe(false);
    expect(await isInvoiceNumberAvailable(db, businessId, 'INV-999999')).toBe(true);
    // A live invoice's own row must exclude itself when asked with excludeInvoiceId.
    expect(await isInvoiceNumberAvailable(db, businessId, 'INV-000001', inv.id)).toBe(true);
    // After soft-delete the number is released (§4).
    await service.deleteInvoice(inv.id, 'testing');
    expect(await isInvoiceNumberAvailable(db, businessId, 'INV-000001')).toBe(true);
  });

  it('getNextAvailableInvoiceNumber reuses the lowest recycled gap before the counter', async () => {
    const inv1 = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000002',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    // Counter is at 1 (never bumped by explicit numbers). Bump it so the
    // gap-scan is meaningful — allocate once from the counter side.
    await db.businesses.update(businessId, { invoice_next_seq: 3 });

    // No gaps yet — next auto should be INV-000003.
    expect(await getNextAvailableInvoiceNumber(db, businessId)).toBe('INV-000003');

    // Recycle INV-000001; that number should now be the lowest gap.
    await service.deleteInvoice(inv1.id, 'testing');
    expect(await getNextAvailableInvoiceNumber(db, businessId)).toBe('INV-000001');
  });

  it('allocateInvoiceNumber consumes the recycled gap without bumping the counter', async () => {
    const inv1 = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000002',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await db.businesses.update(businessId, { invoice_next_seq: 3 });
    await service.deleteInvoice(inv1.id, 'testing');

    const next = await allocateInvoiceNumber(db, businessId);
    expect(next).toBe('INV-000001');
    // Counter untouched — gap was below invoice_next_seq.
    const biz = await db.businesses.get(businessId);
    expect(biz?.invoice_next_seq).toBe(3);
  });

  it('editing an invoice with a new number: renames the reissue and writes an audit_log row', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });

    const updated = await service.updateInvoice(inv.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      invoice_number: 'INV-000042',
    });

    expect(updated.invoice_number).toBe('INV-000042');
    // Original still exists and is marked as superseded (by its credit note).
    const original = await db.invoices.get(inv.id);
    expect(original?.reversed_by_invoice_id).toBeTruthy();
    expect(original?.invoice_number).toBe('INV-000001');
    // The reissue is a fresh invoice with the new number.
    expect(updated.id).not.toBe(inv.id);
    // Audit row was written.
    const audit = await db.audit_log
      .where('[business_id+entity_type+entity_id]')
      .equals([businessId, 'invoice', inv.id])
      .toArray();
    const renameRow = audit.find((a) => a.action === 'invoice.number_changed');
    expect(renameRow).toBeDefined();
    expect((renameRow?.before as { invoice_number: string }).invoice_number).toBe(
      'INV-000001',
    );
    expect((renameRow?.after as { invoice_number: string }).invoice_number).toBe(
      'INV-000042',
    );
    // No Sales Return was created — the rename is edit-only.
    const returns = await db.sales_returns
      .where('business_id')
      .equals(businessId)
      .toArray();
    expect(returns).toHaveLength(0);
  });

  it('editing an invoice with the SAME number preserves it and writes no rename audit', async () => {
    const inv = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    const updated = await service.updateInvoice(inv.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
      invoice_number: 'INV-000001',
    });
    expect(updated.invoice_number).toBe('INV-000001');
    const audit = await db.audit_log
      .where('[business_id+entity_type+entity_id]')
      .equals([businessId, 'invoice', inv.id])
      .toArray();
    expect(audit.find((a) => a.action === 'invoice.number_changed')).toBeUndefined();
  });

  it('editing to a colliding live number is rejected', async () => {
    const inv1 = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000002',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    await expect(
      service.updateInvoice(inv1.id, {
        business_id: businessId,
        device_id: deviceId,
        invoice_date: '2026-08-19',
        customer_id: customerId,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: '2026-27',
        lines: [intrastateLine()],
        invoice_number: 'INV-000002',
      }),
    ).rejects.toThrow(/already in use/);
  });

  it('restoreInvoice throws InvoiceNumberConflictError when the number has been reused', async () => {
    const inv1 = await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    // Recycle it, then a fresh invoice reuses INV-000001 (auto-allocation
    // would pick up the released gap).
    await service.deleteInvoice(inv1.id, 'testing');
    await service.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [intrastateLine()],
    });
    // Now try to restore inv1 — its number is taken.
    await expect(service.restoreInvoice(inv1.id)).rejects.toBeInstanceOf(
      InvoiceNumberConflictError,
    );
  });
});
