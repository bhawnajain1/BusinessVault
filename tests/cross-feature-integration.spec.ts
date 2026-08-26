// §22 Cross-feature integration tests.
//
// The feedback spec mandates that each pair of previously-fixed features
// must remain independently correct when the other feature is applied on
// top. Prior phases each ship their own unit tests, but a cross-feature bug
// (e.g. Round Off drifts when a rounded invoice is recycled and restored)
// wouldn't get caught by either phase's suite alone. This file adds one
// integration test per critical cross-feature pair from §22.
//
// We use real services (InvoiceService, PaymentService, SalesReturnService)
// against fake-indexeddb so the exact production code paths run — no mocks.
// Every scenario finishes with a call to `runFullRegressionSuite` so
// nothing else can silently drift.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../src/db/database';
import type {
  Account,
  Business,
  Customer,
  Item,
  ItemStock,
  Warehouse,
} from '../src/db/types';
import { InvoiceService } from '../src/domain/InvoiceService';
import { PaymentService } from '../src/domain/PaymentService';
import { runFullRegressionSuite } from '../src/testing/regressionAssertions';

let db: BusinessVaultDB;
let invoices: InvoiceService;
let payments: PaymentService;

const businessId = 'biz_cf';
const deviceId = 'dev_cf';
const customerId = 'cust_cf';
const warehouseId = 'wh_cf';
const itemId = 'item_cf';

function acc(code: string, name: string, type: Account['type']): Account {
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
    name: 'CF Traders',
    legal_name: 'CF Traders Pvt Ltd',
    gstin: '29AABCS1234A1Z5',
    pan: 'AABCS1234A',
    address_line1: '',
    address_line2: '',
    city: '',
    state: 'Karnataka',
    state_code: '29',
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
  };
  await db.businesses.add(business);
  await db.customers.add({
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
    created_at: now,
    updated_at: now,
    entity_version: 1,
  } as Customer);
  await db.warehouses.add({
    id: warehouseId,
    business_id: businessId,
    name: 'Main',
    address: '',
    is_default: 1,
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  } as Warehouse);
  await db.items.add({
    id: itemId,
    business_id: businessId,
    sku: 'SKU-1',
    name: 'Widget',
    description: '',
    hsn: '8471',
    category_id: null,
    unit_id: 'PCS',
    sale_price_paise: 10099, // ₹100.99 so 18% GST gives a non-round total → round-off active
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
  } as Item);
  await db.item_stock.add({
    id: ulid(),
    business_id: businessId,
    item_id: itemId,
    warehouse_id: warehouseId,
    qty_micros: 100_000_000,
    avg_cost_paise: 8000,
    updated_at: now,
  } as ItemStock);
  // Chart of accounts (minimal, matching InvoiceService.test.ts).
  const rows: Account[] = [
    acc('1200', 'Accounts Receivable', 'asset'),
    acc('1400', 'Inventory', 'asset'),
    acc('4000', 'Sales Revenue', 'income'),
    acc('2210', 'Output CGST', 'liability'),
    acc('2220', 'Output SGST', 'liability'),
    acc('2230', 'Output IGST', 'liability'),
    acc('2240', 'Output Cess', 'liability'),
    acc('4900', 'Round Off', 'income'),
    acc('5020', 'Cost of Goods Sold', 'expense'),
    acc('1100', 'Cash', 'asset'),
    acc('2050', 'Customer Advances', 'liability'),
  ];
  for (const a of rows) await db.accounts.add(a);
}

beforeEach(async () => {
  db = new BusinessVaultDB(`bv_cf_${ulid()}`);
  await db.open();
  await seed();
  invoices = new InvoiceService(db);
  payments = new PaymentService(db);
});

describe('§22 Cross-feature — Round Off + Recycle + Restore', () => {
  it('round-off-active invoice stays balanced through delete → restore cycle', async () => {
    // Line: 1 unit @ ₹100.99 → net 10099, CGST 909, SGST 909 → pre-round 11917.
    // Auto round-off → nearest ₹1 → total 11900, round_off_paise = -17.
    const inv = await invoices.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-CF-1',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      round_off_mode: 'auto',
      lines: [
        {
          item_id: itemId,
          hsn: '8471',
          warehouse_id: warehouseId,
          qty_micros: 1_000_000,
          unit_price_paise: 10099,
          taxable_paise: 10099,
          tax_rate_bps: 1800,
          cgst_paise: 909,
          sgst_paise: 909,
          igst_paise: 0,
          line_total_paise: 11917,
        },
      ],
    });
    // Auto rounding must have populated round_off_mode = 'auto' and a non-zero
    // round_off_paise. If either drifted, the recycle mirror below would be
    // computed against the wrong baseline.
    expect(inv.round_off_mode).toBe('auto');
    expect(inv.round_off_paise).not.toBe(0);
    expect(inv.total_paise).toBe(inv.pre_round_total_paise + inv.round_off_paise);

    // First checkpoint: assertions pass while the invoice is live.
    let suite = await runFullRegressionSuite(businessId, { db });
    expect(suite.failures).toEqual([]);

    // Recycle → §9 posts a mirror journal so TB drops to 0.
    await invoices.deleteInvoice(inv.id, 'wrong customer');
    suite = await runFullRegressionSuite(businessId, { db });
    // The mirror journal must exactly offset the original 4900 Round Off
    // posting; if it didn't, accountingSelfCheck would trip here.
    expect(suite.failures).toEqual([]);

    // Restore → §9 posts an un-mirror. TB returns to the pre-recycle state.
    await invoices.restoreInvoice(inv.id);
    suite = await runFullRegressionSuite(businessId, { db });
    expect(suite.failures).toEqual([]);

    // Repeat a second cycle — feedback §21 mandates that delete/restore
    // cycles never drift.
    await invoices.deleteInvoice(inv.id, 'testing again');
    await invoices.restoreInvoice(inv.id);
    suite = await runFullRegressionSuite(businessId, { db });
    expect(suite.failures).toEqual([]);
  });
});

describe('§22 Cross-feature — Round Off + Payment (full settle)', () => {
  it('paying a rounded invoice in full brings balance to exactly 0 (no fractional drift)', async () => {
    const inv = await invoices.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-CF-P1',
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      round_off_mode: 'auto',
      lines: [
        {
          item_id: itemId,
          hsn: '8471',
          warehouse_id: warehouseId,
          qty_micros: 1_000_000,
          unit_price_paise: 10099,
          taxable_paise: 10099,
          tax_rate_bps: 1800,
          cgst_paise: 909,
          sgst_paise: 909,
          igst_paise: 0,
          line_total_paise: 11917,
        },
      ],
    });
    // Pay the full rounded total (not the pre-round total). If Payment
    // allocates against pre_round_total_paise by mistake, invoice balance
    // would go to -17 or +17.
    const cashAcc = (await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '1100'])
      .first())!;
    const arAcc = (await db.accounts
      .where('[business_id+code]')
      .equals([businessId, '1200'])
      .first())!;
    await payments.createPayment({
      business_id: businessId,
      device_id: deviceId,
      payment_number: 'PAY-CF-1',
      payment_date: '2026-08-26',
      direction: 'in',
      party_type: 'customer',
      party_id: customerId,
      method: 'cash',
      cash_or_bank_account_id: cashAcc.id,
      ar_or_ap_account_id: arAcc.id,
      amount_paise: inv.total_paise,
      allocations: [{ invoice_id: inv.id, amount_paise: inv.total_paise }],
    });

    const settled = await db.invoices.get(inv.id);
    expect(settled?.paid_paise).toBe(inv.total_paise);
    expect(settled?.balance_paise).toBe(0);

    const suite = await runFullRegressionSuite(businessId, { db });
    expect(suite.failures).toEqual([]);
  });
});
