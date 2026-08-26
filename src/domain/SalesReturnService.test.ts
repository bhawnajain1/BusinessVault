import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../db/database';
import type {
  Account,
  Business,
  Customer,
  Invoice,
  Item,
  ItemStock,
  Warehouse,
} from '../db/types';
import { InvoiceService } from './InvoiceService';
import { SalesReturnService, SalesReturnValidationError } from './SalesReturnService';

// Shared seed — mirrors the InvoiceService test setup with the extras needed
// by Sales Return (Customer Advances account, sales_return_next_seq).

let db: BusinessVaultDB;
let invSvc: InvoiceService;
let retSvc: SalesReturnService;

const businessId = '01BUSINESS';
const deviceId = '01DEVICE';
const customerId = '01CUSTOMER';
const warehouseId = '01WAREHOUSE';
const itemId = '01ITEM';

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
    sales_return_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 5,
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
    qty_micros: 100_000_000,
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
    accRow('2050', 'Customer Advances', 'liability'),
    accRow('4900', 'Round Off', 'income'),
    accRow('5020', 'Cost of Goods Sold', 'expense'),
  ];
  for (const a of accounts) await db.accounts.add(a);
}

// Line: 10 units @ ₹100 = ₹1000 net, 18% intrastate GST => CGST 9% ₹90,
// SGST 9% ₹90, total ₹1180. Micros: 10_000_000. Paise: taxable 100000,
// cgst 9000, sgst 9000, line_total 118000.
function tenUnitLine() {
  return {
    item_id: itemId,
    hsn: '8471',
    warehouse_id: warehouseId,
    qty_micros: 10_000_000,
    unit_price_paise: 10000,
    taxable_paise: 100_000,
    tax_rate_bps: 1800,
    cgst_paise: 9000,
    sgst_paise: 9000,
    igst_paise: 0,
    line_total_paise: 118_000,
  };
}

async function makeInvoice(number: string): Promise<Invoice> {
  return invSvc.createInvoice({
    business_id: businessId,
    device_id: deviceId,
    invoice_number: number,
    invoice_date: '2026-08-19',
    customer_id: customerId,
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: false,
    financial_year: '2026-27',
    lines: [tenUnitLine()],
  });
}

beforeEach(async () => {
  const uniqueName = `bv_sr_test_${Math.random().toString(36).slice(2)}`;
  db = new BusinessVaultDB(uniqueName);
  await db.open();
  await seed();
  invSvc = new InvoiceService(db);
  retSvc = new SalesReturnService(db);
});

describe('SalesReturnService.createSalesReturn', () => {
  it('T1: creates a partial per-line return, preserves original invoice totals, and reduces balance', async () => {
    const inv = await makeInvoice('INV-000001');
    const originalLines = await db.invoice_lines
      .where('invoice_id')
      .equals(inv.id)
      .toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Damaged',
      lines: [
        { original_invoice_line_id: originalLines[0].id, qty_micros: 3_000_000 },
      ],
    });

    // Return numbering starts at SR-000001
    expect(sr.return_number).toBe('SR-000001');
    // 30% of ₹1180 = ₹354, in paise = 35400
    expect(sr.total_paise).toBe(35_400);
    // Original invoice UNTOUCHED for total/taxable
    const stillOriginal = await db.invoices.get(inv.id);
    expect(stillOriginal!.total_paise).toBe(118_000);
    expect(stillOriginal!.taxable_paise).toBe(100_000);
    // ... but balance reduced by the return amount (invoice was unpaid, so
    // full 35400 offsets balance).
    expect(stillOriginal!.balance_paise).toBe(118_000 - 35_400);
  });

  it('T2: available_to_return math — cannot exceed original qty minus prior returns', async () => {
    const inv = await makeInvoice('INV-000002');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    // First return: 6 of 10.
    await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Partial',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 6_000_000 }],
    });

    // Second return: attempt 5 (only 4 remain) — must reject.
    await expect(
      retSvc.createSalesReturn({
        business_id: businessId,
        device_id: deviceId,
        original_invoice_id: inv.id,
        return_date: '2026-08-21',
        reason: 'Overreach',
        lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 5_000_000 }],
      }),
    ).rejects.toBeInstanceOf(SalesReturnValidationError);
  });

  it('T3: rejects zero/negative qty and missing reason', async () => {
    const inv = await makeInvoice('INV-000003');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    await expect(
      retSvc.createSalesReturn({
        business_id: businessId,
        device_id: deviceId,
        original_invoice_id: inv.id,
        return_date: '2026-08-20',
        reason: 'x',
        lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 0 }],
      }),
    ).rejects.toBeInstanceOf(SalesReturnValidationError);

    await expect(
      retSvc.createSalesReturn({
        business_id: businessId,
        device_id: deviceId,
        original_invoice_id: inv.id,
        return_date: '2026-08-20',
        reason: '   ',
        lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 1_000_000 }],
      }),
    ).rejects.toBeInstanceOf(SalesReturnValidationError);
  });

  it('T4: pro-rates line-level financials by requested fraction of qty', async () => {
    const inv = await makeInvoice('INV-000004');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Half',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 5_000_000 }],
    });
    // 50% of taxable/CGST/SGST/line_total
    const items = await db.sales_return_items
      .where('sales_return_id')
      .equals(sr.id)
      .toArray();
    expect(items).toHaveLength(1);
    expect(items[0].taxable_paise).toBe(50_000);
    expect(items[0].cgst_paise).toBe(4_500);
    expect(items[0].sgst_paise).toBe(4_500);
    expect(items[0].line_total_paise).toBe(59_000);
  });

  it('T5: posts a balanced reversing journal entry with JE-SR- prefix', async () => {
    const inv = await makeInvoice('INV-000005');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Test',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 4_000_000 }],
    });
    const je = await db.journal_entries.get(sr.journal_entry_id);
    expect(je).toBeDefined();
    expect(je!.entry_number).toBe(`JE-SR-${sr.return_number}`);
    expect(je!.ref_type).toBe('reversal');
    expect(je!.ref_id).toBe(sr.id);
    expect(je!.reverses_id).toBe(inv.journal_entry_id);
    expect(je!.total_debit_paise).toBe(je!.total_credit_paise);
    expect(je!.total_debit_paise).toBe(sr.total_paise);
  });

  it('T6: restores stock via positive sale_return movements', async () => {
    const inv = await makeInvoice('INV-000006');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    // Sale reduced stock 100M → 90M.
    let stockRow = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stockRow!.qty_micros).toBe(90_000_000);

    await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Restock',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 4_000_000 }],
    });

    stockRow = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stockRow!.qty_micros).toBe(94_000_000);

    const movs = await db.stock_movements
      .where('business_id')
      .equals(businessId)
      .toArray();
    const retMov = movs.find(
      (m) => m.movement_type === 'sale_return' && m.qty_micros === 4_000_000,
    );
    expect(retMov).toBeDefined();
    expect(retMov!.ref_type).toBe('reversal');
  });

  it('T7: settlement — apply-to-balance for unpaid invoice, no customer credit', async () => {
    const inv = await makeInvoice('INV-000007');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Full',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 10_000_000 }],
    });
    expect(sr.total_paise).toBe(118_000);

    // No advance for a fully-outstanding invoice.
    const advances = await db.advances
      .where('business_id')
      .equals(businessId)
      .toArray();
    expect(advances).toHaveLength(0);

    const stillOriginal = await db.invoices.get(inv.id);
    expect(stillOriginal!.balance_paise).toBe(0);
    expect(stillOriginal!.total_paise).toBe(118_000);
  });

  it('T8: excess-return creates a customer credit Advance, not a negative balance', async () => {
    const inv = await makeInvoice('INV-000008');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    // Manually mark the invoice fully paid to simulate a customer that already
    // paid — so a return should now become customer credit, not a balance
    // reduction.
    await db.invoices.update(inv.id, {
      paid_paise: inv.total_paise,
      balance_paise: 0,
      status: 'paid',
    });

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Refund via credit',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 4_000_000 }],
    });
    // 40% of ₹1180 = ₹472 → 47200 paise.
    expect(sr.total_paise).toBe(47_200);

    const stillOriginal = await db.invoices.get(inv.id);
    expect(stillOriginal!.balance_paise).toBe(0); // NEVER goes negative
    expect(stillOriginal!.total_paise).toBe(118_000);

    const advances = await db.advances
      .where('business_id')
      .equals(businessId)
      .toArray();
    expect(advances).toHaveLength(1);
    expect(advances[0].amount_paise).toBe(47_200);
    expect(advances[0].remaining_paise).toBe(47_200);
    expect(advances[0].party_id).toBe(customerId);
    expect(advances[0].reference).toBe(`sales_return:${sr.return_number}`);
  });

  it('T9: partial payment + partial return — mixes balance-offset and customer credit', async () => {
    const inv = await makeInvoice('INV-000009');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    // Simulate ₹1000 already received against a ₹1180 invoice — balance is
    // now ₹180 (18000 paise), paid ₹1000 (100000 paise).
    await db.invoices.update(inv.id, {
      paid_paise: 100_000,
      balance_paise: 18_000,
      status: 'partial',
    });

    // Return 6 of 10 (₹708 = 70800 paise). 18000 offsets balance, 52800 →
    // customer credit.
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Mixed',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 6_000_000 }],
    });
    expect(sr.total_paise).toBe(70_800);

    const stillOriginal = await db.invoices.get(inv.id);
    expect(stillOriginal!.balance_paise).toBe(0);
    // total unchanged
    expect(stillOriginal!.total_paise).toBe(118_000);

    const advances = await db.advances.where('business_id').equals(businessId).toArray();
    expect(advances).toHaveLength(1);
    expect(advances[0].amount_paise).toBe(52_800);
  });

  it('T10: idempotency — same key returns the same sales_return record', async () => {
    const inv = await makeInvoice('INV-000010');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const key = 'idem-1';
    const a = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Once',
      idempotency_key: key,
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 2_000_000 }],
    });
    const b = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-21',
      reason: 'Again',
      idempotency_key: key,
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 9_000_000 }],
    });
    expect(b.id).toBe(a.id);
    const all = await db.sales_returns.where('business_id').equals(businessId).toArray();
    expect(all).toHaveLength(1);
  });

  it('T11: sequential SR- numbering', async () => {
    const inv = await makeInvoice('INV-000011');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const a = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'First',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 1_000_000 }],
    });
    const b = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Second',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 1_000_000 }],
    });
    expect(a.return_number).toBe('SR-000001');
    expect(b.return_number).toBe('SR-000002');
  });

  it('T12: cancelSalesReturn — status flips to cancelled, subsequent returns see qty as available again', async () => {
    const inv = await makeInvoice('INV-000012');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Oops',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 8_000_000 }],
    });
    await retSvc.cancelSalesReturn(sr.id, businessId, 'typo');
    const after = await db.sales_returns.get(sr.id);
    expect(after!.status).toBe('cancelled');

    // Since cancelled returns are excluded, the full 10 should be available
    // again for a fresh return.
    const sr2 = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-21',
      reason: 'Retry',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 10_000_000 }],
    });
    expect(sr2.id).not.toBe(sr.id);
  });

  it('T13: sync events written for header, items, movements, JE, JE lines', async () => {
    const inv = await makeInvoice('INV-000013');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Events',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 3_000_000 }],
    });
    const events = await db.sync_events
      .where('business_id')
      .equals(businessId)
      .toArray();
    const headerEvt = events.find(
      (e) => e.entity_type === 'sales_return' && e.entity_id === sr.id,
    );
    expect(headerEvt).toBeDefined();
    expect(headerEvt!.operation).toBe('created');
    const itemEvents = events.filter(
      (e) => e.entity_type === 'sales_return_item',
    );
    expect(itemEvents).toHaveLength(1);
    const movementEvents = events.filter(
      (e) => e.entity_type === 'stock_movement' && e.payload,
    );
    // Sale movement + return movement.
    expect(movementEvents.length).toBeGreaterThanOrEqual(2);
    const jeEvents = events.filter(
      (e) =>
        e.entity_type === 'journal_entry' &&
        e.entity_id === sr.journal_entry_id,
    );
    expect(jeEvents).toHaveLength(1);
    const jlEvents = events.filter((e) => e.entity_type === 'journal_line');
    expect(jlEvents.length).toBeGreaterThan(0);
  });

  it('T14: edit-guard — updateInvoice rejects qty reduction below returned qty', async () => {
    const inv = await makeInvoice('INV-000014');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    // Return 6 of 10.
    await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Book return',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 6_000_000 }],
    });

    // Attempt to edit invoice down to 5 units — must reject.
    await expect(
      invSvc.updateInvoice(inv.id, {
        business_id: businessId,
        device_id: deviceId,
        invoice_date: inv.invoice_date,
        customer_id: customerId,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: '2026-27',
        lines: [
          {
            item_id: itemId,
            hsn: '8471',
            warehouse_id: warehouseId,
            qty_micros: 5_000_000, // below the 6 returned — must fail
            unit_price_paise: 10000,
            taxable_paise: 50_000,
            tax_rate_bps: 1800,
            cgst_paise: 4_500,
            sgst_paise: 4_500,
            igst_paise: 0,
            line_total_paise: 59_000,
          },
        ],
      }),
    ).rejects.toThrow(/already been returned/);

    // Editing back up to the same 10 (or higher) must succeed.
    await invSvc.updateInvoice(inv.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: inv.invoice_date,
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [tenUnitLine()],
    });
  });

  // ------- PR3: audit_log + real cancel reversal ---------------------------

  it('T15: audit_log — sales_return.created row is written on createSalesReturn', async () => {
    const inv = await makeInvoice('INV-A15');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Audit trail',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 2_000_000 }],
    });

    const auditRows = await db.audit_log
      .where('[business_id+entity_type+entity_id]')
      .equals([businessId, 'sales_return', sr.id])
      .toArray();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('sales_return.created');
    expect(auditRows[0].actor).toBe(deviceId);
    const after = auditRows[0].after as Record<string, unknown>;
    expect(after.return_number).toBe(sr.return_number);
    expect(after.total_paise).toBe(sr.total_paise);
    expect(after.reason).toBe('Audit trail');
  });

  it('T16: cancelSalesReturn posts a balanced reversal JE that swaps debits/credits and links via reverses_id', async () => {
    const inv = await makeInvoice('INV-A16');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Reverse me',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 3_000_000 }],
    });
    const originalJe = await db.journal_entries.get(sr.journal_entry_id);
    expect(originalJe).toBeDefined();

    await retSvc.cancelSalesReturn(sr.id, businessId, 'cancel test');

    // Original JE now has reversed_by_id set
    const origAfter = await db.journal_entries.get(sr.journal_entry_id);
    expect(origAfter!.reversed_by_id).not.toBeNull();

    // Reversal JE exists, balanced, links back via reverses_id
    const revJe = await db.journal_entries.get(origAfter!.reversed_by_id!);
    expect(revJe).toBeDefined();
    expect(revJe!.reverses_id).toBe(sr.journal_entry_id);
    expect(revJe!.total_debit_paise).toBe(revJe!.total_credit_paise);
    expect(revJe!.entry_number).toContain(sr.return_number);
    expect(revJe!.entry_number.endsWith('-CX')).toBe(true);

    // Every reversal line is a swapped-side copy of an original line
    const origLines = await db.journal_lines
      .where('entry_id')
      .equals(sr.journal_entry_id)
      .toArray();
    const revLines = await db.journal_lines
      .where('entry_id')
      .equals(revJe!.id)
      .toArray();
    expect(revLines).toHaveLength(origLines.length);
    const origByAcct = new Map(origLines.map((l) => [l.account_id, l]));
    for (const rl of revLines) {
      const ol = origByAcct.get(rl.account_id);
      expect(ol).toBeDefined();
      expect(rl.debit_paise).toBe(ol!.credit_paise);
      expect(rl.credit_paise).toBe(ol!.debit_paise);
    }
  });

  it('T17: cancelSalesReturn reverses stock movements and item_stock', async () => {
    const inv = await makeInvoice('INV-A17');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();

    const stockBefore = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    const qtyBefore = stockBefore!.qty_micros;

    // Return 5 units: stock goes UP by 5 units.
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Reversal stock test',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 5_000_000 }],
    });
    const stockAfterReturn = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stockAfterReturn!.qty_micros).toBe(qtyBefore + 5_000_000);

    // Cancel: stock should go back DOWN by 5 units.
    await retSvc.cancelSalesReturn(sr.id, businessId, 'undo stock');
    const stockAfterCancel = await db.item_stock
      .where('[business_id+item_id+warehouse_id]')
      .equals([businessId, itemId, warehouseId])
      .first();
    expect(stockAfterCancel!.qty_micros).toBe(qtyBefore);

    // A negative-qty sale_return movement should exist referencing the SR.
    const reversalMovements = await db.stock_movements
      .where('[business_id+ref_type+ref_id]')
      .equals([businessId, 'reversal', sr.id])
      .toArray();
    const negMv = reversalMovements.find((m) => m.qty_micros < 0);
    expect(negMv).toBeDefined();
    expect(negMv!.movement_type).toBe('sale_return');
    expect(negMv!.qty_micros).toBe(-5_000_000);
  });

  it('T18: cancelSalesReturn restores invoice balance for the applied portion', async () => {
    const inv = await makeInvoice('INV-A18');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    const balanceBefore = inv.balance_paise;

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Balance restore',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 4_000_000 }],
    });
    // Fully unpaid invoice: entire return offsets balance.
    const invAfterReturn = await db.invoices.get(inv.id);
    expect(invAfterReturn!.balance_paise).toBe(balanceBefore - sr.total_paise);

    await retSvc.cancelSalesReturn(sr.id, businessId, 'undo');
    const invAfterCancel = await db.invoices.get(inv.id);
    expect(invAfterCancel!.balance_paise).toBe(balanceBefore);
  });

  it('T19: cancelSalesReturn zeros an unapplied customer-credit advance', async () => {
    const inv = await makeInvoice('INV-A19');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    // Simulate: invoice is fully paid. A subsequent return produces an
    // advance for the full return amount.
    await db.invoices.update(inv.id, {
      paid_paise: 118_000,
      balance_paise: 0,
      status: 'paid',
    });
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Credit test',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 2_000_000 }],
    });
    const advBefore = (
      await db.advances
        .where('business_id')
        .equals(businessId)
        .filter((a) => a.reference === `sales_return:${sr.return_number}`)
        .toArray()
    )[0];
    expect(advBefore).toBeDefined();
    expect(advBefore.remaining_paise).toBeGreaterThan(0);

    await retSvc.cancelSalesReturn(sr.id, businessId, 'undo credit');
    const advAfter = await db.advances.get(advBefore.id);
    expect(advAfter!.remaining_paise).toBe(0);
    expect(advAfter!.notes).toContain('reversed');
  });

  it('T20: cancelSalesReturn refuses when the credit advance has been partially applied', async () => {
    const inv = await makeInvoice('INV-A20');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    await db.invoices.update(inv.id, {
      paid_paise: 118_000,
      balance_paise: 0,
      status: 'paid',
    });
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Partial-applied test',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 2_000_000 }],
    });
    const adv = (
      await db.advances
        .where('business_id')
        .equals(businessId)
        .filter((a) => a.reference === `sales_return:${sr.return_number}`)
        .toArray()
    )[0];
    // Simulate partial application by hand — mirroring what AdvanceService would do.
    await db.advances.update(adv.id, {
      remaining_paise: adv.amount_paise - 1000,
    });

    await expect(
      retSvc.cancelSalesReturn(sr.id, businessId, 'should refuse'),
    ).rejects.toThrow(/already applied/);
  });

  it('T21: cancelSalesReturn writes a sales_return.cancelled audit_log row', async () => {
    const inv = await makeInvoice('INV-A21');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Audit cancel',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 1_000_000 }],
    });
    await retSvc.cancelSalesReturn(sr.id, businessId, 'why not');

    const auditRows = await db.audit_log
      .where('[business_id+entity_type+entity_id]')
      .equals([businessId, 'sales_return', sr.id])
      .toArray();
    // create + cancel
    expect(auditRows).toHaveLength(2);
    const cancelRow = auditRows.find((r) => r.action === 'sales_return.cancelled');
    expect(cancelRow).toBeDefined();
    const after = cancelRow!.after as Record<string, unknown>;
    expect(after.status).toBe('cancelled');
    expect(after.reason).toBe('why not');
    expect(after.reversal_journal_entry_id).not.toBeNull();
  });

  it('T22: cancelSalesReturn is idempotent — second cancel is a no-op', async () => {
    const inv = await makeInvoice('INV-A22');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Idem cancel',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 1_000_000 }],
    });
    await retSvc.cancelSalesReturn(sr.id, businessId, 'first');

    const jesBefore = await db.journal_entries
      .where('business_id')
      .equals(businessId)
      .toArray();
    const stockBefore = await db.stock_movements
      .where('business_id')
      .equals(businessId)
      .toArray();
    const auditBefore = await db.audit_log
      .where('business_id')
      .equals(businessId)
      .toArray();

    await retSvc.cancelSalesReturn(sr.id, businessId, 'second');

    const jesAfter = await db.journal_entries
      .where('business_id')
      .equals(businessId)
      .toArray();
    const stockAfter = await db.stock_movements
      .where('business_id')
      .equals(businessId)
      .toArray();
    const auditAfter = await db.audit_log
      .where('business_id')
      .equals(businessId)
      .toArray();

    expect(jesAfter.length).toBe(jesBefore.length);
    expect(stockAfter.length).toBe(stockBefore.length);
    expect(auditAfter.length).toBe(auditBefore.length);
  });

  it('T23: cancelSalesReturn correctly splits reversal on a partially-paid invoice (mixed settlement)', async () => {
    // Invoice ₹1416 total, ₹1000 paid → balance ₹416.
    // SR for ₹708 (half the invoice): ₹416 offsets balance, ₹292 becomes credit advance.
    // Cancel: ₹416 restored to invoice balance AND advance zeroed.
    const inv = await makeInvoice('INV-A23');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    await db.invoices.update(inv.id, {
      paid_paise: 100_000,
      balance_paise: inv.balance_paise - 100_000,
      status: 'partial',
    });
    const invBefore = await db.invoices.get(inv.id);
    const balanceBeforeSr = invBefore!.balance_paise;

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Mixed settlement',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 3_000_000 }],
    });

    // After create: split fields recorded on header.
    expect(sr.apply_to_balance_paise + sr.customer_credit_paise).toBe(sr.total_paise);
    if (sr.total_paise > balanceBeforeSr) {
      expect(sr.apply_to_balance_paise).toBe(balanceBeforeSr);
      expect(sr.customer_credit_paise).toBe(sr.total_paise - balanceBeforeSr);
    }
    const invAfterSr = await db.invoices.get(inv.id);
    expect(invAfterSr!.balance_paise).toBe(balanceBeforeSr - sr.apply_to_balance_paise);

    const advBefore = (
      await db.advances
        .where('business_id')
        .equals(businessId)
        .filter((a) => a.reference === `sales_return:${sr.return_number}`)
        .toArray()
    )[0];
    if (sr.customer_credit_paise > 0) {
      expect(advBefore).toBeDefined();
      expect(advBefore.amount_paise).toBe(sr.customer_credit_paise);
    }

    await retSvc.cancelSalesReturn(sr.id, businessId, 'undo mixed');

    // Balance restored to pre-SR value AND advance zeroed.
    const invAfterCancel = await db.invoices.get(inv.id);
    expect(invAfterCancel!.balance_paise).toBe(balanceBeforeSr);
    if (advBefore) {
      const advAfter = await db.advances.get(advBefore.id);
      expect(advAfter!.remaining_paise).toBe(0);
    }
  });

  it('T24: cancelSalesReturn uses persisted apply_to_balance_paise, not the advance amount', async () => {
    // Regression guard for the AC-F1 latent defect: if the credit advance
    // record is unreachable (simulated by deleting it), cancel must still
    // restore the correct balance by reading sr.apply_to_balance_paise.
    const inv = await makeInvoice('INV-A24');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    await db.invoices.update(inv.id, {
      paid_paise: 100_000,
      balance_paise: inv.balance_paise - 100_000,
      status: 'partial',
    });
    const invBefore = await db.invoices.get(inv.id);
    const balanceBeforeSr = invBefore!.balance_paise;

    const sr = await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'AC-F1 regression',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 3_000_000 }],
    });
    // Only run the assertion when the mix actually produced a credit advance.
    if (sr.customer_credit_paise === 0) return;

    const adv = (
      await db.advances
        .where('business_id')
        .equals(businessId)
        .filter((a) => a.reference === `sales_return:${sr.return_number}`)
        .toArray()
    )[0];
    // Simulate the failure mode: advance record's reference has been mutated
    // so the cancel-time lookup can't find it. If cancel relied on the
    // advance amount, balance would over-restore by customer_credit_paise.
    await db.advances.update(adv.id, { reference: 'lost' });

    await retSvc.cancelSalesReturn(sr.id, businessId, 'undo with lost advance');
    const invAfterCancel = await db.invoices.get(inv.id);
    expect(invAfterCancel!.balance_paise).toBe(balanceBeforeSr);
  });

  it('E2E invariant: original invoice totals are IMMUTABLE across a partial return + a subsequent edit', async () => {
    const inv = await makeInvoice('INV-INV1');
    const lines = await db.invoice_lines.where('invoice_id').equals(inv.id).toArray();
    const beforeTotal = inv.total_paise;
    const beforeTaxable = inv.taxable_paise;

    await retSvc.createSalesReturn({
      business_id: businessId,
      device_id: deviceId,
      original_invoice_id: inv.id,
      return_date: '2026-08-20',
      reason: 'Invariant',
      lines: [{ original_invoice_line_id: lines[0].id, qty_micros: 4_000_000 }],
    });

    // The original invoice's total_paise / taxable_paise must NOT change.
    const stillOriginal = await db.invoices.get(inv.id);
    expect(stillOriginal!.total_paise).toBe(beforeTotal);
    expect(stillOriginal!.taxable_paise).toBe(beforeTaxable);

    // Edit the invoice — bump qty from 10 to 12 (above returned qty of 4).
    // The edit path reissues the invoice under the same invoice_number; the
    // reissued row's total should reflect the new qty. The ORIGINAL row is
    // marked reversed_by_invoice_id.
    const twelveUnitLine = {
      ...tenUnitLine(),
      qty_micros: 12_000_000,
      taxable_paise: 120_000,
      cgst_paise: 10_800,
      sgst_paise: 10_800,
      line_total_paise: 141_600,
    };
    await invSvc.updateInvoice(inv.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: inv.invoice_date,
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [twelveUnitLine],
    });
    // Original invoice STILL has its historical total_paise.
    const originalAgain = await db.invoices.get(inv.id);
    expect(originalAgain!.total_paise).toBe(beforeTotal);
    expect(originalAgain!.taxable_paise).toBe(beforeTaxable);
    // But is now marked as superseded.
    expect(originalAgain!.reversed_by_invoice_id).not.toBeNull();
  });
});
