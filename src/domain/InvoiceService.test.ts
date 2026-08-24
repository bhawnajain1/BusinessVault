import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../db/database';
import type { Account, Business, Customer, Item, ItemStock, Warehouse } from '../db/types';
import { InvoiceService } from './InvoiceService';

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
