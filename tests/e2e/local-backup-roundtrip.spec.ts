/**
 * Mandatory local-backup round-trip coverage.
 *
 * This test deliberately uses the production snapshot builder and restore
 * pipeline: seed a populated database, write a local-folder backup, delete
 * the source database, restore into a fresh database, and compare counts,
 * identities, money, JSON fields, and derived inventory/accounting state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../../src/db/database';
import type {
  Account,
  Advance,
  AuditLogEntry,
  Business,
  Customer,
  CustomerItemPrice,
  Expense,
  Invoice,
  InvoiceLine,
  Item,
  ItemStock,
  JournalEntry,
  JournalLine,
  Payment,
  Purchase,
  PurchaseLine,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
  Supplier,
  Unit,
  Warehouse,
} from '../../src/db/types';
import { buildSnapshotInput } from '../../src/sync/buildSnapshotInput';
import { LocalFolderStorageProvider } from '../../src/storage/LocalFolderStorageProvider';
import { rebuildFromDrive } from '../../src/restore/rebuildFromDrive';
import { TABLE_SPECS } from '../../src/restore/tableSchema';

(globalThis as unknown as { Blob: typeof NodeBlob }).Blob = NodeBlob;
process.env.NODE_ENV = 'test';

const BID = 'local-round-trip-business';
const COUNT = 20;
const NOW = '2026-09-25T10:00:00.000Z';
const DATE = '2026-09-25';
const FY = '2026-27';
const DEVICE_ID = 'local-round-trip-device';

function audit() {
  return { created_at: NOW, updated_at: NOW, entity_version: 1 };
}

function business(): Business {
  return {
    id: BID,
    name: 'Local Round Trip Test',
    legal_name: 'Local Round Trip Test Pvt Ltd',
    gstin: '27AABCU9603R1ZM',
    pan: 'AABCU9603R',
    address_line1: '1 Test Road',
    address_line2: '',
    city: 'Mumbai',
    state: 'Maharashtra',
    state_code: '27',
    pincode: '400001',
    country: 'IN',
    phone: '9000000000',
    email: 'roundtrip@example.test',
    financial_year_start_month: 4,
    current_financial_year: FY,
    currency: 'INR',
    logo_ref: null,
    signature_ref: null,
    show_signature_on_invoice: 0,
    invoice_prefix: 'RT-',
    invoice_next_seq: COUNT + 1,
    default_invoice_terms: 'Due on receipt',
    sales_return_next_seq: COUNT + 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 13,
    ...audit(),
  };
}

function makeRows() {
  const customers: Customer[] = [];
  const suppliers: Supplier[] = [];
  const categories = [] as Array<Record<string, unknown>>;
  const units: Unit[] = [];
  const warehouses: Warehouse[] = [];
  const items: Item[] = [];
  const prices: CustomerItemPrice[] = [];
  const accounts: Account[] = [];

  for (let i = 0; i < COUNT; i += 1) {
    customers.push({
      id: `rt-customer-${i}`,
      business_id: BID,
      name: `Customer ${i}`,
      phone: `900000${i.toString().padStart(4, '0')}`,
      email: `customer-${i}@example.test`,
      gstin: null,
      billing_address: `Customer address ${i}`,
      shipping_address: `Customer address ${i}`,
      state: 'Maharashtra',
      state_code: '27',
      opening_balance_paise: i * 100,
      credit_limit_paise: 1_000_000,
      notes: `Customer note ${i}`,
      active: 1,
      ...audit(),
    });
    suppliers.push({
      id: `rt-supplier-${i}`,
      business_id: BID,
      name: `Supplier ${i}`,
      phone: `800000${i.toString().padStart(4, '0')}`,
      email: `supplier-${i}@example.test`,
      gstin: null,
      address: `Supplier address ${i}`,
      state: 'Maharashtra',
      state_code: '27',
      opening_balance_paise: i * 80,
      notes: `Supplier note ${i}`,
      active: 1,
      ...audit(),
    });
    categories.push({ id: `rt-category-${i}`, business_id: BID, name: `Category ${i}`, parent_id: null, ...audit() });
    units.push({ id: `rt-unit-${i}`, business_id: BID, code: `U${i}`, name: `Unit ${i}`, decimal_places: i % 3, ...audit() });
    warehouses.push({ id: `rt-warehouse-${i}`, business_id: BID, name: `Warehouse ${i}`, address: `Warehouse address ${i}`, is_default: i === 0 ? 1 : 0, active: 1, ...audit() });
    items.push({
      id: `rt-item-${i}`,
      business_id: BID,
      sku: `RT-SKU-${i}`,
      name: `Product ${i}`,
      description: `Product description ${i}`,
      hsn: '8471',
      category_id: categories[i].id as string,
      unit_id: units[i].id,
      sale_price_paise: 10_000 + i * 100,
      purchase_price_paise: 8_000 + i * 100,
      tax_rate_bps: 1800,
      cess_rate_bps: 0,
      is_service: 0,
      track_inventory: 1,
      opening_qty_micros: 100_000_000,
      opening_value_paise: (8_000 + i * 100) * 100,
      reorder_level_micros: 10_000_000,
      barcode: `RT-BAR-${i}`,
      image_ref: null,
      active: 1,
      ...audit(),
    });
    prices.push({
      id: `rt-price-${i}`,
      business_id: BID,
      customer_id: customers[i].id,
      item_id: items[i].id,
      unit_price_paise: 9_500 + i * 100,
      ...audit(),
    });
  }

  const accountDefs: Array<[string, string, Account['type'], string]> = [
    ['cash', 'Cash', 'asset', 'current_asset'],
    ['ar', 'Accounts Receivable', 'asset', 'receivable'],
    ['inventory', 'Inventory', 'asset', 'inventory'],
    ['ap', 'Accounts Payable', 'liability', 'payable'],
    ['input-cgst', 'Input CGST', 'asset', 'gst_input'],
    ['input-sgst', 'Input SGST', 'asset', 'gst_input'],
    ['output-cgst', 'Output CGST', 'liability', 'gst_output'],
    ['output-sgst', 'Output SGST', 'liability', 'gst_output'],
    ['customer-advances', 'Customer Advances', 'liability', 'advances'],
    ['revenue', 'Sales Revenue', 'income', 'operating_income'],
    ...Array.from({ length: 11 }, (_, i): [string, string, Account['type'], string] => [
      `expense-${i}`,
      `Expense ${i}`,
      'expense',
      'operating_expense',
    ]),
  ];
  for (const [code, name, type, subtype] of accountDefs) {
    accounts.push({ id: `rt-account-${code}`, business_id: BID, code: `RT-${code}`, name, type, subtype, parent_id: null, opening_balance_paise: 0, is_system: 0, active: 1, ...audit() });
  }
  return { customers, suppliers, categories, units, warehouses, items, prices, accounts };
}

function postEntry(entries: JournalEntry[], lines: JournalLine[], index: number, refType: JournalEntry['ref_type'], refId: string, legs: Array<{ account_id: string; debit_paise: number; credit_paise: number; party_id?: string }>): string {
  const id = `rt-journal-${index}`;
  const totalDebit = legs.reduce((sum, leg) => sum + leg.debit_paise, 0);
  const totalCredit = legs.reduce((sum, leg) => sum + leg.credit_paise, 0);
  expect(totalDebit).toBe(totalCredit);
  entries.push({ id, business_id: BID, entry_number: `RT-JE-${index}`, entry_date: DATE, narration: `Round-trip ${refType} ${refId}`, ref_type: refType, ref_id: refId, reversed_by_id: null, reverses_id: null, total_debit_paise: totalDebit, total_credit_paise: totalCredit, posted: 1, ...audit() });
  for (const [lineNo, leg] of legs.entries()) {
    lines.push({ id: `rt-line-${index}-${lineNo}`, business_id: BID, entry_id: id, line_no: lineNo + 1, account_id: leg.account_id, debit_paise: leg.debit_paise, credit_paise: leg.credit_paise, party_type: leg.party_id ? 'customer' : null, party_id: leg.party_id ?? null, description: refType });
  }
  return id;
}

async function seed(db: BusinessVaultDB) {
  const rows = makeRows();
  const invoices: Invoice[] = [];
  const invoiceLines: InvoiceLine[] = [];
  const purchases: Purchase[] = [];
  const purchaseLines: PurchaseLine[] = [];
  const payments: Payment[] = [];
  const expenses: Expense[] = [];
  const advances: Advance[] = [];
  const salesReturns: SalesReturn[] = [];
  const salesReturnItems: SalesReturnItem[] = [];
  const stocks: ItemStock[] = [];
  const movements: StockMovement[] = [];
  const journalEntries: JournalEntry[] = [];
  const journalLines: JournalLine[] = [];
  const attachments = [] as Array<Record<string, unknown>>;
  const auditLogs: AuditLogEntry[] = [];
  let journalIndex = 0;

  for (let i = 0; i < COUNT; i += 1) {
    const item = rows.items[i];
    const customer = rows.customers[i];
    const supplier = rows.suppliers[i];
    const warehouse = rows.warehouses[i];
    const taxable = 10_000 + i * 100;
    const tax = Math.floor(taxable * 0.09);
    const total = taxable + tax * 2;
    const invoiceId = `rt-invoice-${i}`;
    const purchaseId = `rt-purchase-${i}`;
    const invoiceLineId = `rt-invoice-line-${i}`;
    const purchaseLineId = `rt-purchase-line-${i}`;
    const invoiceJournalId = postEntry(journalEntries, journalLines, journalIndex++, 'invoice', invoiceId, [
      { account_id: 'rt-account-ar', debit_paise: total, credit_paise: 0, party_id: customer.id },
      { account_id: 'rt-account-revenue', debit_paise: 0, credit_paise: taxable },
      { account_id: 'rt-account-output-cgst', debit_paise: 0, credit_paise: tax },
      { account_id: 'rt-account-output-sgst', debit_paise: 0, credit_paise: tax },
    ]);
    invoices.push({ id: invoiceId, business_id: BID, invoice_number: `RT-INV-${i}`, invoice_date: DATE, due_date: null, customer_id: customer.id, customer_state_code: '27', place_of_supply: '27', is_interstate: 0, financial_year: FY, subtotal_paise: taxable, discount_paise: 0, taxable_paise: taxable, cgst_paise: tax, sgst_paise: tax, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: total, total_paise: total, paid_paise: 1_000, balance_paise: total - 1_000, status: 'partial', reversed_by_invoice_id: null, reverses_invoice_id: null, notes: '', terms: '', pdf_attachment_id: null, journal_entry_id: invoiceJournalId, ...audit() });
    invoiceLines.push({ id: invoiceLineId, business_id: BID, invoice_id: invoiceId, line_no: 1, item_id: item.id, description: item.name, hsn: item.hsn, warehouse_id: warehouse.id, qty_micros: 1_000_000, unit_price_paise: taxable, discount_pct_bps: 0, discount_paise: 0, taxable_paise: taxable, tax_rate_bps: 1800, cgst_paise: tax, sgst_paise: tax, igst_paise: 0, cess_paise: 0, line_total_paise: total });

    const purchaseJournalId = postEntry(journalEntries, journalLines, journalIndex++, 'purchase', purchaseId, [
      { account_id: 'rt-account-inventory', debit_paise: taxable, credit_paise: 0 },
      { account_id: 'rt-account-input-cgst', debit_paise: tax, credit_paise: 0 },
      { account_id: 'rt-account-input-sgst', debit_paise: tax, credit_paise: 0 },
      { account_id: 'rt-account-ap', debit_paise: 0, credit_paise: total },
    ]);
    purchases.push({ id: purchaseId, business_id: BID, bill_number: `RT-BILL-${i}`, supplier_bill_number: `SUP-${i}`, bill_date: DATE, due_date: null, supplier_id: supplier.id, supplier_state_code: '27', is_interstate: 0, financial_year: FY, subtotal_paise: taxable, discount_paise: 0, taxable_paise: taxable, cgst_paise: tax, sgst_paise: tax, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: total, total_paise: total, paid_paise: 0, balance_paise: total, status: 'received', reversed_by_purchase_id: null, reverses_purchase_id: null, notes: '', attachment_id: null, journal_entry_id: purchaseJournalId, ...audit() });
    purchaseLines.push({ id: purchaseLineId, business_id: BID, purchase_id: purchaseId, line_no: 1, item_id: item.id, description: item.name, hsn: item.hsn, warehouse_id: warehouse.id, qty_micros: 2_000_000, unit_cost_paise: taxable, discount_paise: 0, taxable_paise: taxable, tax_rate_bps: 1800, cgst_paise: tax, sgst_paise: tax, igst_paise: 0, cess_paise: 0, line_total_paise: total });

    const paymentJournalId = postEntry(journalEntries, journalLines, journalIndex++, 'payment', `rt-payment-${i}`, [{ account_id: 'rt-account-cash', debit_paise: 1_000, credit_paise: 0 }, { account_id: 'rt-account-ar', debit_paise: 0, credit_paise: 1_000, party_id: customer.id }]);
    payments.push({ id: `rt-payment-${i}`, business_id: BID, payment_number: `RT-PAY-${i}`, payment_date: DATE, direction: 'in', party_type: 'customer', party_id: customer.id, method: 'cash', account_id: 'rt-account-cash', amount_paise: 1_000, reference: `REF-${i}`, notes: '', allocations: [{ invoice_id: invoiceId, amount_paise: 1_000 }], journal_entry_id: paymentJournalId, ...audit() });

    const expenseAmount = 500 + i;
    const expenseJournalId = postEntry(journalEntries, journalLines, journalIndex++, 'expense', `rt-expense-${i}`, [{ account_id: `rt-account-expense-${i % 11}`, debit_paise: expenseAmount, credit_paise: 0 }, { account_id: 'rt-account-cash', debit_paise: 0, credit_paise: expenseAmount }]);
    expenses.push({ id: `rt-expense-${i}`, business_id: BID, expense_number: `RT-EXP-${i}`, expense_date: DATE, category_account_id: `rt-account-expense-${i % 11}`, payment_account_id: 'rt-account-cash', supplier_id: supplier.id, description: `Expense ${i}`, amount_paise: expenseAmount, tax_paise: 0, total_paise: expenseAmount, attachment_id: null, journal_entry_id: expenseJournalId, ...audit() });

    const advanceJournalId = postEntry(journalEntries, journalLines, journalIndex++, 'advance', `rt-advance-${i}`, [{ account_id: 'rt-account-cash', debit_paise: 700, credit_paise: 0 }, { account_id: 'rt-account-customer-advances', debit_paise: 0, credit_paise: 700 }]);
    advances.push({ id: `rt-advance-${i}`, business_id: BID, advance_number: `RT-ADV-${i}`, advance_date: DATE, party_type: 'customer', party_id: customer.id, method: 'cash', account_id: 'rt-account-cash', amount_paise: 700, remaining_paise: 700, reference: `ADV-${i}`, notes: '', applications: [], journal_entry_id: advanceJournalId, ...audit() });

    salesReturns.push({ id: `rt-return-${i}`, business_id: BID, return_number: `RT-SR-${i}`, return_date: DATE, original_invoice_id: invoiceId, customer_id: customer.id, subtotal_paise: 100, discount_paise: 0, taxable_paise: 100, cgst_paise: 9, sgst_paise: 9, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 118, total_paise: 118, apply_to_balance_paise: 0, customer_credit_paise: 0, status: 'cancelled', reason: 'Test cancellation', notes: '', journal_entry_id: `cancelled-return-journal-${i}`, reversed_credit_note_invoice_id: null, legacy_migration_classification: null, device_id: DEVICE_ID, ...audit() });
    salesReturnItems.push({ id: `rt-return-line-${i}`, business_id: BID, sales_return_id: `rt-return-${i}`, original_invoice_id: invoiceId, original_invoice_line_id: invoiceLineId, item_id: item.id, description: item.name, hsn: item.hsn, warehouse_id: warehouse.id, line_no: 1, qty_micros: 100_000, unit_price_paise: 100, discount_pct_bps: 0, discount_paise: 0, taxable_paise: 100, tax_rate_bps: 1800, cgst_paise: 9, sgst_paise: 9, igst_paise: 0, cess_paise: 0, line_total_paise: 118, cogs_paise: 80 });

    movements.push({ id: `rt-opening-${i}`, business_id: BID, item_id: item.id, warehouse_id: warehouse.id, movement_type: 'opening', qty_micros: 100_000_000, unit_cost_paise: item.purchase_price_paise, ref_type: 'opening', ref_id: item.id, occurred_at: DATE, notes: '' });
    movements.push({ id: `rt-purchase-movement-${i}`, business_id: BID, item_id: item.id, warehouse_id: warehouse.id, movement_type: 'purchase', qty_micros: 2_000_000, unit_cost_paise: item.purchase_price_paise, ref_type: 'purchase', ref_id: purchaseId, occurred_at: DATE, notes: '' });
    movements.push({ id: `rt-sale-movement-${i}`, business_id: BID, item_id: item.id, warehouse_id: warehouse.id, movement_type: 'sale', qty_micros: -1_000_000, unit_cost_paise: item.purchase_price_paise, ref_type: 'invoice', ref_id: invoiceId, occurred_at: DATE, notes: '' });
    stocks.push({ id: `${BID}:${item.id}:${warehouse.id}`, business_id: BID, item_id: item.id, warehouse_id: warehouse.id, qty_micros: 101_000_000, avg_cost_paise: item.purchase_price_paise, updated_at: NOW });
    attachments.push({ id: `rt-attachment-${i}`, business_id: BID, ref_type: 'invoice', ref_id: invoiceId, filename: `receipt-${i}.txt`, mime_type: 'text/plain', size_bytes: 10 + i, checksum: `checksum-${i}`, blob: null, drive_file_id: null, logical_path: `attachments/receipt-${i}.txt`, created_at: NOW, updated_at: NOW });
    auditLogs.push({ id: `rt-audit-${i}`, business_id: BID, device_id: DEVICE_ID, actor: 'test', action: 'created', entity_type: 'invoice', entity_id: invoiceId, before: null, after: { invoice_number: `RT-INV-${i}`, total_paise: total }, at: NOW });
  }

  const tableRows: Record<string, unknown[]> = {
    businesses: [business()], customer_item_prices: rows.prices, customers: rows.customers, suppliers: rows.suppliers,
    categories: rows.categories, units: rows.units, warehouses: rows.warehouses, items: rows.items, item_stock: stocks,
    invoices, invoice_lines: invoiceLines, purchases, purchase_lines: purchaseLines, payments, expenses,
    stock_movements: movements, accounts: rows.accounts, journal_entries: journalEntries, journal_lines: journalLines,
    advances, sales_returns: salesReturns, sales_return_items: salesReturnItems, attachments, audit_log: auditLogs,
  };
  for (const spec of TABLE_SPECS) tableRows[spec.store] ??= [];
  const tables = Object.entries(tableRows) as Array<[string, unknown[]]>;
  await db.transaction('rw', TABLE_SPECS.map((spec) => (db as unknown as Record<string, unknown>)[spec.store]) as never, async () => {
    for (const [store, values] of tables) {
      const table = (db as unknown as Record<string, { bulkPut(rows: unknown[]): Promise<void> }>)[store];
      await table.bulkPut(values);
    }
  });
  return tableRows;
}

interface RoundTripState {
  counts: Record<string, number>;
  ids: Record<string, string[]>;
  invoiceTotals: number;
  invoicePaid: number;
  invoiceBalances: number;
  purchaseTotals: number;
  purchaseBalances: number;
  paymentTotals: number;
  expenseTotals: number;
  advanceTotals: number;
  journalDebit: number;
  journalCredit: number;
  stockQty: number;
  paymentAllocations: unknown[][];
}

async function countsAndMoney(db: BusinessVaultDB): Promise<RoundTripState> {
  const counts: Record<string, number> = {};
  const ids: Record<string, string[]> = {};
  for (const spec of TABLE_SPECS) {
    const table = (db as unknown as Record<string, { where(key: string): { equals(value: string): { toArray(): Promise<Array<Record<string, unknown>>> } } }>)[spec.store];
    const rows = spec.store === 'businesses'
      ? await db.businesses.where('id').equals(BID).toArray() as unknown as Array<Record<string, unknown>>
      : await table.where('business_id').equals(BID).toArray();
    counts[spec.store] = rows.length;
    ids[spec.store] = rows.map((row) => String(row[spec.pk])).sort();
  }
  const [invoices, purchases, payments, expenses, advances, journalLines, stocks] = await Promise.all([
    db.invoices.where('business_id').equals(BID).toArray(), db.purchases.where('business_id').equals(BID).toArray(), db.payments.where('business_id').equals(BID).toArray(), db.expenses.where('business_id').equals(BID).toArray(), db.advances.where('business_id').equals(BID).toArray(), db.journal_lines.where('business_id').equals(BID).toArray(), db.item_stock.where('business_id').equals(BID).toArray(),
  ]);
  return {
    counts,
    ids,
    invoiceTotals: invoices.reduce((a, row) => a + row.total_paise, 0),
    invoicePaid: invoices.reduce((a, row) => a + row.paid_paise, 0),
    invoiceBalances: invoices.reduce((a, row) => a + row.balance_paise, 0),
    purchaseTotals: purchases.reduce((a, row) => a + row.total_paise, 0),
    purchaseBalances: purchases.reduce((a, row) => a + row.balance_paise, 0),
    paymentTotals: payments.reduce((a, row) => a + row.amount_paise, 0),
    expenseTotals: expenses.reduce((a, row) => a + row.total_paise, 0),
    advanceTotals: advances.reduce((a, row) => a + row.amount_paise, 0),
    journalDebit: journalLines.reduce((a, row) => a + row.debit_paise, 0),
    journalCredit: journalLines.reduce((a, row) => a + row.credit_paise, 0),
    stockQty: stocks.reduce((a, row) => a + row.qty_micros, 0),
    paymentAllocations: payments.map((row) => row.allocations).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

describe('mandatory local backup round trip', () => {
  let root: string;
  let sourceDb: BusinessVaultDB;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-local-round-trip-'));
    sourceDb = new BusinessVaultDB(`bv-local-round-trip-source-${ulid()}`);
    await sourceDb.open();
  });

  afterEach(async () => {
    sourceDb.close();
    await sourceDb.delete().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves every populated backup entity, counts, balances, and money after reset and restore', async () => {
    const expectedRows = await seed(sourceDb);
    const before = await countsAndMoney(sourceDb);
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business().name });
    const snapshot = await buildSnapshotInput(sourceDb, BID, business().name, 'ondemand', '2026-09-25T10-00-00.000Z');
    expect(new Set(snapshot.files.map((file) => file.name))).toEqual(new Set(TABLE_SPECS.map((spec) => spec.file)));
    await producer.writeSnapshot(snapshot);
    expect((await producer.verifyIntegrity()).ok).toBe(true);
    await producer.disconnect();

    expect(before.counts).toEqual(Object.fromEntries(Object.entries(expectedRows).map(([store, values]) => [store, values.length])));
    sourceDb.close();
    await sourceDb.delete();
    const restoredDb = new BusinessVaultDB(`bv-local-round-trip-restored-${ulid()}`);
    await restoredDb.open();
    try {
      const report = await rebuildFromDrive(new LocalFolderStorageProvider(), { db: restoredDb, providerConfig: { kind: 'local-folder', rootPath: root } });
      const after = await countsAndMoney(restoredDb);
      expect(report.checksumsOk).toBe(true);
      expect(report.accountingBalanced).toBe(true);
      expect(report.inventoryConsistent).toBe(true);
      expect(report.gstReconciled).toBe(true);
      expect(report.diagnostics.ok).toBe(true);
      expect(report.unhandledEvents).toBe(0);
      expect(report.countReconciliation).toEqual({ exact: true, compared: true, mismatches: {} });
      expect(after).toEqual(before);
      for (const spec of TABLE_SPECS) expect(report.counts[spec.store]).toBe(before.counts[spec.store]);
      expect(await restoredDb.payments.toArray().then((rows) => rows.map((row) => row.allocations).every((allocations) => allocations.length === 1))).toBe(true);
      expect(await restoredDb.audit_log.toArray().then((rows) => rows.every((row) => (row.after as Record<string, unknown>).total_paise !== undefined))).toBe(true);
    } finally {
      restoredDb.close();
      await restoredDb.delete().catch(() => undefined);
    }
  }, 120_000);
});
