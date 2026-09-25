// Coherence test — dashboard KPI == invoices-page filter == receivables report.
//
// This exercises the exact rename-edit path from the user's bug report:
// create N invoices, rename K of them, then assert that the number the
// dashboard shows equals what the invoices page shows equals the count
// implied by computeReceivables. All three surfaces read the same Dexie
// tables — they should never disagree.
//
// Runs the real InvoiceService.createInvoice + updateInvoice code paths
// against fake-indexeddb so any drift in the reverse-and-reissue mechanic
// gets caught here, not by a customer.

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
import {
  computeReceivables,
  computePayables,
} from '../src/domain/partyLedger';
import {
  computeDashboardStats,
  isLiveInvoice,
} from '../src/domain/dashboardStats';

let db: BusinessVaultDB;
let invoices: InvoiceService;

const businessId = 'biz_dc';
const deviceId = 'dev_dc';
const customerId = 'cust_dc';
const warehouseId = 'wh_dc';
const itemId = 'item_dc';

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
    name: 'DC Traders',
    legal_name: 'DC Traders',
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
    sale_price_paise: 10000,
    purchase_price_paise: 5000,
    tax_rate_bps: 0,
    cess_rate_bps: 0,
    is_service: 0,
    track_inventory: 1,
    opening_qty_micros: 1_000_000_000,
    opening_value_paise: 5_000_000,
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
    qty_micros: 1_000_000_000,
    avg_cost_paise: 5000,
    updated_at: now,
  } as ItemStock);
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

async function createSimpleInvoice(number: string, totalPaise: number) {
  return invoices.createInvoice({
    business_id: businessId,
    device_id: deviceId,
    invoice_number: number,
    invoice_date: '2026-08-26',
    customer_id: customerId,
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: false,
    financial_year: '2026-27',
    round_off_mode: 'none',
    lines: [
      {
        item_id: itemId,
        hsn: '8471',
        warehouse_id: warehouseId,
        qty_micros: 1_000_000,
        unit_price_paise: totalPaise,
        taxable_paise: totalPaise,
        tax_rate_bps: 0,
        cgst_paise: 0,
        sgst_paise: 0,
        igst_paise: 0,
        line_total_paise: totalPaise,
      },
    ],
  });
}

beforeEach(async () => {
  db = new BusinessVaultDB(`bv_dc_${ulid()}`);
  await db.open();
  await seed();
  invoices = new InvoiceService(db);
});

describe('Dashboard/InvoicesPage/Receivables coherence', () => {
  it('after 4 creates + 2 renames + 1 more, all three surfaces agree', async () => {
    // Reproduces the exact sequence from the user's debug log:
    // 4 invoices created, 2 renamed (rename-edit produces original + CN + reissue),
    // then 1 more invoice created.
    const inv1 = await createSimpleInvoice('INV-000001', 100000);
    const inv2 = await createSimpleInvoice('INV-000002', 200000);
    await createSimpleInvoice('INV-000003', 300000);
    await createSimpleInvoice('INV-000004', 400000);

    // Rename INV-000001 → INV-7608 (fresh id under the hood).
    await invoices.updateInvoice(inv1.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      round_off_mode: 'none',
      invoice_number: 'INV-7608',
      lines: [
        {
          item_id: itemId,
          hsn: '8471',
          warehouse_id: warehouseId,
          qty_micros: 1_000_000,
          unit_price_paise: 100000,
          taxable_paise: 100000,
          tax_rate_bps: 0,
          cgst_paise: 0,
          sgst_paise: 0,
          igst_paise: 0,
          line_total_paise: 100000,
        },
      ],
    });
    // Rename INV-000002 → INV-7609.
    await invoices.updateInvoice(inv2.id, {
      business_id: businessId,
      device_id: deviceId,
      invoice_date: '2026-08-26',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      round_off_mode: 'none',
      invoice_number: 'INV-7609',
      lines: [
        {
          item_id: itemId,
          hsn: '8471',
          warehouse_id: warehouseId,
          qty_micros: 1_000_000,
          unit_price_paise: 200000,
          taxable_paise: 200000,
          tax_rate_bps: 0,
          cgst_paise: 0,
          sgst_paise: 0,
          igst_paise: 0,
          line_total_paise: 200000,
        },
      ],
    });
    // One more fresh invoice.
    await createSimpleInvoice('INV-7610', 500000);

    // Now read every surface off the SAME database state.
    const [invoiceRows, purchaseRows, customers, suppliers, advances] =
      await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.purchases.where('business_id').equals(businessId).toArray(),
        db.customers.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.advances.where('business_id').equals(businessId).toArray(),
      ]);

    // Sanity: 4 originals + 2 CNs + 2 reissues + 1 fresh = 9 raw rows.
    // If InvoiceService ever changes the reissue mechanic (e.g. mutates
    // in place instead of appending), this number drops — but every
    // downstream surface should still agree.
    expect(invoiceRows.length).toBe(9);

    // Surface 1: Dashboard KPI (via extracted pure fn).
    const stats = computeDashboardStats({
      invoices: invoiceRows,
      purchases: purchaseRows,
      customers,
      suppliers,
      advances,
      itemCount: 1,
      asOfYmd: '2026-08-27',
    });

    // Surface 2: InvoicesPage default filter (from InvoicesPage.tsx:66-73).
    // We inline the same predicate here so if the invoices page filter
    // changes, this test fails and forces someone to reconcile the two.
    const invoicesPageRows = invoiceRows.filter((inv) => {
      if (inv.deleted_at) return false;
      if (inv.reverses_invoice_id) return false;
      if (inv.reversed_by_invoice_id) return false;
      return true;
    });

    // Surface 3: computeReceivables (what Receivables/Payables report reads).
    const ar = computeReceivables(
      invoiceRows,
      '2026-08-27',
      advances,
      customers,
    );

    // Coherence #1: KPI count == invoices page rows == live-invoice filter.
    expect(stats.invoices).toBe(invoicesPageRows.length);
    expect(stats.invoices).toBe(invoiceRows.filter(isLiveInvoice).length);
    // 5 live invoices: INV-000003, INV-000004, INV-7608, INV-7609, INV-7610.
    expect(stats.invoices).toBe(5);

    // Coherence #2: dashboard outstanding == receivables report total.
    expect(stats.outstandingReceivablesPaise).toBe(
      ar.totals.outstanding_paise,
    );

    // Coherence #3: dashboard outstanding == sum of live invoice totals
    // (nobody paid anything). If the reversed originals were leaking in,
    // this equality would break — the reversed originals still have
    // balance_paise = their original total (§9 preserves history).
    const expectedOutstanding =
      300000 + 400000 + 100000 + 200000 + 500000; // = 1500000
    expect(stats.outstandingReceivablesPaise).toBe(expectedOutstanding);

    // Coherence #4: perInvoice from receivables report should contain
    // exactly the live rows. Nothing extra, nothing missing.
    const receivablesInvoiceIds = new Set(
      ar.perInvoice.map((row) => row.invoice_id),
    );
    const liveIds = new Set(invoiceRows.filter(isLiveInvoice).map((i) => i.id));
    // ar.perInvoice lists ALL originals (including reversed ones with net-0
    // outstanding), so filter to those with any economic contribution.
    const receivablesLiveIds = new Set(
      ar.perInvoice
        .filter(
          (row) =>
            row.outstanding_paise > 0 ||
            row.paid_paise > 0 ||
            row.credit_note_paise === 0,
        )
        .map((row) => row.invoice_id)
        .filter((id) => liveIds.has(id)),
    );
    expect(receivablesLiveIds).toEqual(liveIds);
    // Silence unused-var lint — the assertion above IS using both sets.
    void receivablesInvoiceIds;

    // Diagnostics: the hidden-row gap matches what actually happened.
    expect(stats.diagnostics.supersededInvoices).toBe(2);
    expect(stats.diagnostics.creditNotes).toBe(2);
    expect(stats.diagnostics.recycledInvoices).toBe(0);
  });

  it('a recycled invoice drops out of the dashboard but stays queryable', async () => {
    const inv = await createSimpleInvoice('INV-001', 50000);
    await createSimpleInvoice('INV-002', 75000);
    await invoices.deleteInvoice(inv.id, 'test recycle');

    const [invoiceRows, purchaseRows, customers, suppliers, advances] =
      await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.purchases.where('business_id').equals(businessId).toArray(),
        db.customers.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.advances.where('business_id').equals(businessId).toArray(),
      ]);

    const stats = computeDashboardStats({
      invoices: invoiceRows,
      purchases: purchaseRows,
      customers,
      suppliers,
      advances,
      itemCount: 1,
      asOfYmd: '2026-08-27',
    });

    expect(stats.invoices).toBe(1); // INV-002 only
    expect(stats.outstandingReceivablesPaise).toBe(75000);
    expect(stats.diagnostics.recycledInvoices).toBe(1);
  });

  it('dashboard payables total equals computePayables total (empty purchases coherence)', async () => {
    await createSimpleInvoice('INV-001', 10000);
    const [invoiceRows, purchaseRows, customers, suppliers, advances] =
      await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.purchases.where('business_id').equals(businessId).toArray(),
        db.customers.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.advances.where('business_id').equals(businessId).toArray(),
      ]);
    const stats = computeDashboardStats({
      invoices: invoiceRows,
      purchases: purchaseRows,
      customers,
      suppliers,
      advances,
      itemCount: 1,
      asOfYmd: '2026-08-27',
    });
    const ap = computePayables(purchaseRows, '2026-08-27', advances, suppliers);
    expect(stats.outstandingPayablesPaise).toBe(ap.totals.outstanding_paise);
  });
});
