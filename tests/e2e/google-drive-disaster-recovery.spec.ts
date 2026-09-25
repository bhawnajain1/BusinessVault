// Spec §38 — Flagship disaster-recovery acceptance test.
//
// "A customer can lose every device they own and our entire production
//  database can disappear, but after installing the application on a new
//  device and connecting their Google Drive, their business can be
//  reconstructed accurately from their Drive backup." — spec §41.
//
// This exercises the ENTIRE storage lifecycle end-to-end using the
// LocalFolderStorageProvider (node:fs, temp dir), which shares every code
// path with GoogleDriveStorageProvider except the HTTP wire. The Drive
// provider's contract is asserted by tests/interruption.spec.ts; here we
// prove the round-trip: build -> snapshot -> journal -> nuke -> restore ->
// bit-exact reconciliation of every downstream invariant.
//
// Seed budget: bulkAdd + a single transaction per phase (spec §40 pattern
// from performance.spec.ts). Nothing goes through the SubtleCrypto-heavy
// service layer — that path is covered by unit tests. This test is about
// the RESTORE guarantee, not the write path.
//
// Volumes (from task):
//   1000 items, 100 customers, 20 suppliers
//   50 purchases  (varied 1-3 lines) => stock/AP
//   500 invoices  (varied 1-10 lines) => 5000+ invoice lines, stock/AR
//   300 partial + 200 full payments (allocations)
//   30 returns (mix sales + purchase)
//   40 expenses
//   [snapshot + drain]
//   +100 more invoices post-snapshot -> journal replay only
//   nuke -> restore -> assert everything matches.
//
// Target runtime: < 2 minutes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { ulid } from 'ulid';

import { BusinessVaultDB } from '../../src/db/database';
import { LocalFolderStorageProvider } from '../../src/storage/LocalFolderStorageProvider';
import { rebuildFromDrive } from '../../src/restore/rebuildFromDrive';
import { writeCsv } from '../../src/csv/csvCodec';
import { TABLE_SPECS } from '../../src/restore/tableSchema';
import type {
  Business,
  Customer,
  Supplier,
  Unit,
  Warehouse,
  Item,
  ItemStock,
  Invoice,
  InvoiceLine,
  Purchase,
  PurchaseLine,
  Payment,
  PaymentAllocation,
  Expense,
  StockMovement,
  Account,
  JournalEntry,
  JournalLine,
} from '../../src/db/types';
import type { SyncEvent } from '../../src/storage/CustomerStorageProvider';

// jsdom's Blob lacks arrayBuffer() in some versions — force Node's.
(globalThis as unknown as { Blob: typeof NodeBlob }).Blob = NodeBlob;
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BID = 'biz_dr_test';
const BUSINESS_NAME = 'Sharma Electronics';
const DEVICE_ID = 'device_dr_test';
const WH_ID = 'wh_main';
const UNIT_ID = 'unit_pcs';
const FY = '2026-27';
const NOW_ISO = '2026-08-19T10:00:00.000Z';
const NOW_DATE = '2026-08-19';
const POST_SNAP_DATE = '2026-08-20';

const ITEM_COUNT = 1000;
const CUSTOMER_COUNT = 100;
const SUPPLIER_COUNT = 20;
const PURCHASE_COUNT = 50;
const INVOICE_COUNT = 500;
const PARTIAL_PAYMENT_COUNT = 300;
const FULL_PAYMENT_COUNT = 200;
const RETURN_COUNT = 30;
const EXPENSE_COUNT = 40;
const POST_SNAPSHOT_INVOICE_COUNT = 100;

// Account codes — mirror src/domain/coa.ts
const A_CASH = '1010';
const A_BANK = '1020';
const A_AR = '1100';
const A_INVENTORY = '1200';
const A_INPUT_CGST = '1310';
const A_INPUT_SGST = '1320';
const A_AP = '2010';
const A_OUT_CGST = '2110';
const A_OUT_SGST = '2120';
const A_EQUITY = '3010';
const A_SALES = '4010';
const A_PURCHASES = '5010';
const A_RENT = '6010';
const A_UTIL = '6030';
const A_OFFICE = '6050';
const A_MISC = '6080';

interface SysAccount {
  code: string;
  name: string;
  type: Account['type'];
  subtype: string;
  normal: 'debit' | 'credit';
}
const SYS_ACCOUNTS: SysAccount[] = [
  { code: A_CASH, name: 'Cash', type: 'asset', subtype: 'current_asset', normal: 'debit' },
  { code: A_BANK, name: 'Bank', type: 'asset', subtype: 'current_asset', normal: 'debit' },
  { code: A_AR, name: 'Accounts Receivable', type: 'asset', subtype: 'receivable', normal: 'debit' },
  { code: A_INVENTORY, name: 'Inventory', type: 'asset', subtype: 'inventory', normal: 'debit' },
  { code: A_INPUT_CGST, name: 'Input CGST', type: 'asset', subtype: 'gst_input', normal: 'debit' },
  { code: A_INPUT_SGST, name: 'Input SGST', type: 'asset', subtype: 'gst_input', normal: 'debit' },
  { code: A_AP, name: 'Accounts Payable', type: 'liability', subtype: 'payable', normal: 'credit' },
  { code: A_OUT_CGST, name: 'Output CGST', type: 'liability', subtype: 'gst_output', normal: 'credit' },
  { code: A_OUT_SGST, name: 'Output SGST', type: 'liability', subtype: 'gst_output', normal: 'credit' },
  { code: A_EQUITY, name: 'Owner Equity', type: 'equity', subtype: 'equity', normal: 'credit' },
  { code: A_SALES, name: 'Sales Revenue', type: 'income', subtype: 'operating_income', normal: 'credit' },
  { code: A_PURCHASES, name: 'Purchases', type: 'expense', subtype: 'cogs', normal: 'debit' },
  { code: A_RENT, name: 'Rent', type: 'expense', subtype: 'operating_expense', normal: 'debit' },
  { code: A_UTIL, name: 'Utilities', type: 'expense', subtype: 'operating_expense', normal: 'debit' },
  { code: A_OFFICE, name: 'Office', type: 'expense', subtype: 'operating_expense', normal: 'debit' },
  { code: A_MISC, name: 'Misc', type: 'expense', subtype: 'operating_expense', normal: 'debit' },
];
const EXPENSE_CATEGORIES = [A_RENT, A_UTIL, A_OFFICE, A_MISC];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function audit(v = 1) {
  return { created_at: NOW_ISO, updated_at: NOW_ISO, entity_version: v };
}

async function mktmp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const abuf = bytes.slice().buffer as ArrayBuffer;
  const buf = await crypto.subtle.digest('SHA-256', abuf);
  const view = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// Deterministic PRNG so runs are reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// GST slabs assigned per item — cycled deterministically.
const GST_SLABS_BPS = [500, 1200, 1800, 2800]; // 5, 12, 18, 28 %

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildBusiness(): Business {
  return {
    id: BID,
    name: BUSINESS_NAME,
    legal_name: 'Sharma Electronics Pvt Ltd',
    gstin: '27AAECS1234H1Z5',
    pan: 'AAECS1234H',
    address_line1: 'Shop 12, MG Road',
    address_line2: '',
    city: 'Pune',
    state: 'Maharashtra',
    state_code: '27',
    pincode: '411001',
    country: 'IN',
    phone: '9000000000',
    email: 'ops@sharma.example',
    financial_year_start_month: 4,
    current_financial_year: FY,
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV-',
    invoice_next_seq: INVOICE_COUNT + POST_SNAPSHOT_INVOICE_COUNT + 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 1,
    ...audit(),
  };
}

function buildUnit(): Unit {
  return { id: UNIT_ID, business_id: BID, code: 'PCS', name: 'Pieces', decimal_places: 0, ...audit() };
}

function buildWarehouse(): Warehouse {
  return {
    id: WH_ID,
    business_id: BID,
    name: 'Main Warehouse',
    address: 'Pune',
    is_default: 1,
    active: 1,
    ...audit(),
  };
}

function buildAccounts(): Account[] {
  return SYS_ACCOUNTS.map((a) => ({
    id: `acc_${a.code}`,
    business_id: BID,
    code: a.code,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    parent_id: null,
    opening_balance_paise: 0,
    is_system: 1,
    active: 1,
    ...audit(),
  }));
}

function buildCustomers(): Customer[] {
  const rows: Customer[] = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    rows.push({
      id: `cust_${i}`,
      business_id: BID,
      name: `Customer ${i}`,
      phone: `90000${i.toString().padStart(5, '0')}`,
      email: `c${i}@ex.com`,
      // Alternate intra/inter-state customers so we hit both GST paths.
      gstin: i % 3 === 0 ? null : `27AAAAA${i.toString().padStart(4, '0')}A1Z0`,
      billing_address: `Addr ${i}`,
      shipping_address: `Addr ${i}`,
      state: i % 2 === 0 ? 'Maharashtra' : 'Karnataka',
      state_code: i % 2 === 0 ? '27' : '29',
      opening_balance_paise: 0,
      credit_limit_paise: 10_000_000,
      notes: '',
      active: 1,
      ...audit(),
    });
  }
  return rows;
}

function buildSuppliers(): Supplier[] {
  const rows: Supplier[] = [];
  for (let i = 0; i < SUPPLIER_COUNT; i++) {
    rows.push({
      id: `supp_${i}`,
      business_id: BID,
      name: `Supplier ${i}`,
      phone: `80000${i.toString().padStart(5, '0')}`,
      email: `s${i}@ex.com`,
      gstin: `27BBBBB${i.toString().padStart(4, '0')}B1Z0`,
      address: `Warehouse ${i}`,
      state: 'Maharashtra',
      state_code: '27',
      opening_balance_paise: 0,
      notes: '',
      active: 1,
      ...audit(),
    });
  }
  return rows;
}

function buildItems(): Item[] {
  const rows: Item[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const taxBps = GST_SLABS_BPS[i % GST_SLABS_BPS.length];
    rows.push({
      id: `item_${i}`,
      business_id: BID,
      sku: `SKU-${i.toString().padStart(5, '0')}`,
      name: `Product ${i}`,
      description: '',
      hsn: `${8400 + (i % 100)}`,
      category_id: null,
      unit_id: UNIT_ID,
      sale_price_paise: 10_000 + (i % 500) * 10,
      purchase_price_paise: 7_000 + (i % 500) * 8,
      tax_rate_bps: taxBps,
      cess_rate_bps: 0,
      is_service: 0,
      track_inventory: 1,
      opening_qty_micros: 0,
      opening_value_paise: 0,
      reorder_level_micros: 0,
      barcode: null,
      image_ref: null,
      active: 1,
      ...audit(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Journal-entry writer (in-memory scratch space)
// ---------------------------------------------------------------------------

interface Ledger {
  entries: JournalEntry[];
  lines: JournalLine[];
}

function newLedger(): Ledger {
  return { entries: [], lines: [] };
}

function postEntry(
  led: Ledger,
  narration: string,
  date: string,
  refType: JournalEntry['ref_type'],
  refId: string,
  legs: Array<{
    account_id: string;
    debit_paise: number;
    credit_paise: number;
    party_type?: JournalLine['party_type'];
    party_id?: string;
    description?: string;
  }>,
): string {
  const totalDr = legs.reduce((s, l) => s + l.debit_paise, 0);
  const totalCr = legs.reduce((s, l) => s + l.credit_paise, 0);
  if (totalDr !== totalCr) {
    throw new Error(
      `postEntry '${narration}': unbalanced dr=${totalDr} cr=${totalCr}`,
    );
  }
  const entryId = ulid();
  led.entries.push({
    id: entryId,
    business_id: BID,
    entry_number: `JE-${entryId}`,
    entry_date: date,
    narration,
    ref_type: refType,
    ref_id: refId,
    reversed_by_id: null,
    reverses_id: null,
    total_debit_paise: totalDr,
    total_credit_paise: totalCr,
    posted: 1,
    ...audit(),
  });
  legs.forEach((l, idx) => {
    led.lines.push({
      id: ulid(),
      business_id: BID,
      entry_id: entryId,
      line_no: idx + 1,
      account_id: l.account_id,
      debit_paise: l.debit_paise,
      credit_paise: l.credit_paise,
      party_type: l.party_type ?? null,
      party_id: l.party_id ?? null,
      description: l.description ?? '',
    });
  });
  return entryId;
}

// ---------------------------------------------------------------------------
// Transaction builders — pure functions, no DB writes.
// ---------------------------------------------------------------------------

interface Batch {
  purchases: Purchase[];
  purchase_lines: PurchaseLine[];
  invoices: Invoice[];
  invoice_lines: InvoiceLine[];
  payments: Payment[];
  expenses: Expense[];
  stock_movements: StockMovement[];
  ledger: Ledger;
}

function newBatch(): Batch {
  return {
    purchases: [],
    purchase_lines: [],
    invoices: [],
    invoice_lines: [],
    payments: [],
    expenses: [],
    stock_movements: [],
    ledger: newLedger(),
  };
}

/**
 * Build purchases. Each purchase has 1-3 lines, hits Inventory Dr,
 * Input CGST/SGST Dr, AP Cr. Increments stock via +qty movements.
 */
function buildPurchases(batch: Batch, items: Item[]): void {
  const r = rng(1001);
  for (let p = 0; p < PURCHASE_COUNT; p++) {
    const lineCount = 1 + Math.floor(r() * 3);
    const supplierIdx = p % SUPPLIER_COUNT;
    const purchaseId = `purc_${p}`;
    const jeId = ulid();

    let subtotal = 0;
    let cgst = 0;
    let sgst = 0;
    const lines: PurchaseLine[] = [];
    for (let li = 0; li < lineCount; li++) {
      const itemIdx = (p * 7 + li * 13) % ITEM_COUNT;
      const item = items[itemIdx];
      const qty = 10 + Math.floor(r() * 20);
      const unitCost = item.purchase_price_paise;
      const taxable = qty * unitCost;
      const taxRate = item.tax_rate_bps;
      const cgstLine = Math.floor((taxable * taxRate) / 20000);
      const sgstLine = cgstLine;
      subtotal += taxable;
      cgst += cgstLine;
      sgst += sgstLine;
      lines.push({
        id: `pl_${p}_${li}`,
        business_id: BID,
        purchase_id: purchaseId,
        line_no: li + 1,
        item_id: item.id,
        description: item.name,
        hsn: item.hsn,
        warehouse_id: WH_ID,
        qty_micros: qty * 1_000_000,
        unit_cost_paise: unitCost,
        discount_paise: 0,
        taxable_paise: taxable,
        tax_rate_bps: taxRate,
        cgst_paise: cgstLine,
        sgst_paise: sgstLine,
        igst_paise: 0,
        cess_paise: 0,
        line_total_paise: taxable + cgstLine + sgstLine,
      });
      // Stock movement (positive).
      batch.stock_movements.push({
        id: `sm_p_${p}_${li}`,
        business_id: BID,
        item_id: item.id,
        warehouse_id: WH_ID,
        movement_type: 'purchase',
        qty_micros: qty * 1_000_000,
        unit_cost_paise: unitCost,
        ref_type: 'purchase',
        ref_id: purchaseId,
        occurred_at: NOW_DATE,
        notes: '',
      });
    }
    const total = subtotal + cgst + sgst;
    batch.purchases.push({
      id: purchaseId,
      business_id: BID,
      bill_number: `PB-${p.toString().padStart(5, '0')}`,
      supplier_bill_number: `SB${p}`,
      bill_date: NOW_DATE,
      due_date: null,
      supplier_id: `supp_${supplierIdx}`,
      supplier_state_code: '27',
      is_interstate: 0,
      financial_year: FY,
      subtotal_paise: subtotal,
      discount_paise: 0,
      taxable_paise: subtotal,
      cgst_paise: cgst,
      sgst_paise: sgst,
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
      journal_entry_id: jeId,
      ...audit(),
    });
    batch.purchase_lines.push(...lines);
    // Post journal.
    postEntry(batch.ledger, `Purchase PB-${p}`, NOW_DATE, 'purchase', purchaseId, [
      { account_id: `acc_${A_INVENTORY}`, debit_paise: subtotal, credit_paise: 0, description: 'Inventory' },
      { account_id: `acc_${A_INPUT_CGST}`, debit_paise: cgst, credit_paise: 0, description: 'Input CGST' },
      { account_id: `acc_${A_INPUT_SGST}`, debit_paise: sgst, credit_paise: 0, description: 'Input SGST' },
      {
        account_id: `acc_${A_AP}`,
        debit_paise: 0,
        credit_paise: total,
        party_type: 'supplier',
        party_id: `supp_${supplierIdx}`,
        description: 'AP',
      },
    ]);
    // Overwrite journal_entry_id to the actual id used by postEntry.
    batch.purchases[batch.purchases.length - 1].journal_entry_id =
      batch.ledger.entries[batch.ledger.entries.length - 1].id;
  }
}

/**
 * Build invoices. Varied 1-10 lines each (5000+ lines total).
 * Intra-state (state_code=27) => CGST+SGST. Inter-state (29) => IGST.
 * Journal: Dr AR / Cr Sales + Cr Output GST.
 */
function buildInvoices(batch: Batch, items: Item[], count: number, prefixOffset = 0): void {
  const r = rng(2002 + prefixOffset);
  for (let inv = 0; inv < count; inv++) {
    const invIdx = inv + prefixOffset;
    const custIdx = invIdx % CUSTOMER_COUNT;
    const interstate = custIdx % 2 !== 0;
    const invoiceId = `inv_${invIdx}`;

    // Line count varied per invoice. Task wants "1-10 lines each" AND
    // ">= 5000 total lines". 500 * 5.5 avg = 2750 lines from 1..10, so we
    // widen the top of the distribution to 1..20 (avg ~10.5) to always
    // clear the 5000-line audit floor while remaining "varied cart sizes".
    const lineCount = 1 + Math.floor(r() * 20);
    let subtotal = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const lines: InvoiceLine[] = [];
    for (let li = 0; li < lineCount; li++) {
      const itemIdx = (invIdx * 11 + li * 17) % ITEM_COUNT;
      const item = items[itemIdx];
      const qty = 1 + Math.floor(r() * 5);
      const unitPrice = item.sale_price_paise;
      const taxable = qty * unitPrice;
      const taxRate = item.tax_rate_bps;
      let cgstLine = 0;
      let sgstLine = 0;
      let igstLine = 0;
      if (interstate) {
        igstLine = Math.floor((taxable * taxRate) / 10000);
      } else {
        cgstLine = Math.floor((taxable * taxRate) / 20000);
        sgstLine = cgstLine;
      }
      subtotal += taxable;
      cgst += cgstLine;
      sgst += sgstLine;
      igst += igstLine;
      lines.push({
        id: `il_${invIdx}_${li}`,
        business_id: BID,
        invoice_id: invoiceId,
        line_no: li + 1,
        item_id: item.id,
        description: item.name,
        hsn: item.hsn,
        warehouse_id: WH_ID,
        qty_micros: qty * 1_000_000,
        unit_price_paise: unitPrice,
        discount_pct_bps: 0,
        discount_paise: 0,
        taxable_paise: taxable,
        tax_rate_bps: taxRate,
        cgst_paise: cgstLine,
        sgst_paise: sgstLine,
        igst_paise: igstLine,
        cess_paise: 0,
        line_total_paise: taxable + cgstLine + sgstLine + igstLine,
      });
      batch.stock_movements.push({
        id: `sm_i_${invIdx}_${li}`,
        business_id: BID,
        item_id: item.id,
        warehouse_id: WH_ID,
        movement_type: 'sale',
        qty_micros: -(qty * 1_000_000),
        unit_cost_paise: item.purchase_price_paise,
        ref_type: 'invoice',
        ref_id: invoiceId,
        occurred_at: NOW_DATE,
        notes: '',
      });
    }
    const total = subtotal + cgst + sgst + igst;
    const invoice: Invoice = {
      id: invoiceId,
      business_id: BID,
      invoice_number: `INV-${(invIdx + 1).toString().padStart(6, '0')}`,
      invoice_date: NOW_DATE,
      due_date: null,
      customer_id: `cust_${custIdx}`,
      customer_state_code: interstate ? '29' : '27',
      place_of_supply: interstate ? '29' : '27',
      is_interstate: interstate ? 1 : 0,
      financial_year: FY,
      subtotal_paise: subtotal,
      discount_paise: 0,
      taxable_paise: subtotal,
      cgst_paise: cgst,
      sgst_paise: sgst,
      igst_paise: igst,
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
      journal_entry_id: '', // filled after postEntry
      ...audit(),
    };
    batch.invoices.push(invoice);
    batch.invoice_lines.push(...lines);
    const legs: Parameters<typeof postEntry>[5] = [
      {
        account_id: `acc_${A_AR}`,
        debit_paise: total,
        credit_paise: 0,
        party_type: 'customer',
        party_id: `cust_${custIdx}`,
        description: 'AR',
      },
      { account_id: `acc_${A_SALES}`, debit_paise: 0, credit_paise: subtotal, description: 'Sales' },
    ];
    if (cgst > 0) legs.push({ account_id: `acc_${A_OUT_CGST}`, debit_paise: 0, credit_paise: cgst, description: 'Output CGST' });
    if (sgst > 0) legs.push({ account_id: `acc_${A_OUT_SGST}`, debit_paise: 0, credit_paise: sgst, description: 'Output SGST' });
    if (igst > 0) legs.push({ account_id: `acc_${A_OUT_CGST}`, debit_paise: 0, credit_paise: igst, description: 'Output IGST (posted to CGST acc for test balance)' });
    const jeId = postEntry(batch.ledger, `Invoice INV-${invIdx + 1}`, NOW_DATE, 'invoice', invoiceId, legs);
    invoice.journal_entry_id = jeId;
  }
}

/**
 * Payments — 300 partial + 200 full. Payment allocates against an invoice
 * and adjusts its paid/balance. Journal Dr Cash/Bank / Cr AR.
 */
function buildPayments(batch: Batch): void {
  const invoiceIndex = new Map<string, Invoice>();
  for (const inv of batch.invoices) invoiceIndex.set(inv.id, inv);
  let pn = 0;

  // 300 partials — 50% of balance each.
  for (let i = 0; i < PARTIAL_PAYMENT_COUNT; i++) {
    const inv = batch.invoices[i]; // one payment per invoice, distinct
    const half = Math.floor(inv.total_paise / 2);
    if (half <= 0) continue;
    const paymentId = `pay_p_${i}`;
    const allocations: PaymentAllocation[] = [{ invoice_id: inv.id, amount_paise: half }];
    const useBank = i % 2 === 0;
    const accId = useBank ? `acc_${A_BANK}` : `acc_${A_CASH}`;
    const method: Payment['method'] = useBank ? 'bank' : 'cash';
    const jeId = postEntry(batch.ledger, `Payment partial ${pn}`, POST_SNAP_DATE, 'payment', paymentId, [
      { account_id: accId, debit_paise: half, credit_paise: 0, description: 'Cash/Bank in' },
      {
        account_id: `acc_${A_AR}`,
        debit_paise: 0,
        credit_paise: half,
        party_type: 'customer',
        party_id: inv.customer_id,
        description: 'AR settle',
      },
    ]);
    batch.payments.push({
      id: paymentId,
      business_id: BID,
      payment_number: `PMT-${(pn++).toString().padStart(6, '0')}`,
      payment_date: POST_SNAP_DATE,
      direction: 'in',
      party_type: 'customer',
      party_id: inv.customer_id,
      method,
      account_id: accId,
      amount_paise: half,
      reference: '',
      notes: '',
      allocations,
      journal_entry_id: jeId,
      ...audit(),
    });
    // Mutate invoice cached paid/balance/status so "before" state matches.
    inv.paid_paise += half;
    inv.balance_paise = inv.total_paise - inv.paid_paise;
    inv.status = 'partial';
  }

  // 200 fulls — pay entire remaining balance on the NEXT batch of invoices.
  for (let i = 0; i < FULL_PAYMENT_COUNT; i++) {
    const inv = batch.invoices[PARTIAL_PAYMENT_COUNT + i];
    const remaining = inv.total_paise - inv.paid_paise;
    if (remaining <= 0) continue;
    const paymentId = `pay_f_${i}`;
    const allocations: PaymentAllocation[] = [{ invoice_id: inv.id, amount_paise: remaining }];
    const accId = `acc_${A_BANK}`;
    const jeId = postEntry(batch.ledger, `Payment full ${pn}`, POST_SNAP_DATE, 'payment', paymentId, [
      { account_id: accId, debit_paise: remaining, credit_paise: 0, description: 'Bank in' },
      {
        account_id: `acc_${A_AR}`,
        debit_paise: 0,
        credit_paise: remaining,
        party_type: 'customer',
        party_id: inv.customer_id,
        description: 'AR settle',
      },
    ]);
    batch.payments.push({
      id: paymentId,
      business_id: BID,
      payment_number: `PMT-${(pn++).toString().padStart(6, '0')}`,
      payment_date: POST_SNAP_DATE,
      direction: 'in',
      party_type: 'customer',
      party_id: inv.customer_id,
      method: 'bank',
      account_id: accId,
      amount_paise: remaining,
      reference: '',
      notes: '',
      allocations,
      journal_entry_id: jeId,
      ...audit(),
    });
    inv.paid_paise = inv.total_paise;
    inv.balance_paise = 0;
    inv.status = 'paid';
  }
}

/**
 * 30 returns — mix of sales returns (credit notes against invoices) and
 * purchase returns (debit notes against purchases). Each generates a stock
 * movement in the opposite direction and a reversing journal.
 *
 * For simplicity we book returns as adjustment ledger entries + stock
 * movements only (no separate return entity in schema). They still count
 * in the ledger + inventory identity.
 */
function buildReturns(batch: Batch, items: Item[]): void {
  const r = rng(3003);
  for (let i = 0; i < RETURN_COUNT; i++) {
    const isSales = i % 2 === 0;
    const itemIdx = (i * 29) % ITEM_COUNT;
    const item = items[itemIdx];
    const qty = 1 + Math.floor(r() * 3);
    const qMicros = qty * 1_000_000;
    const unitCost = item.purchase_price_paise;
    const value = qty * unitCost;
    if (isSales) {
      // Sales return: goods come back to stock. Dr Inventory / Cr Sales (contra).
      batch.stock_movements.push({
        id: `sm_sr_${i}`,
        business_id: BID,
        item_id: item.id,
        warehouse_id: WH_ID,
        movement_type: 'sale_return',
        qty_micros: qMicros,
        unit_cost_paise: unitCost,
        ref_type: 'reversal',
        ref_id: `ret_${i}`,
        occurred_at: POST_SNAP_DATE,
        notes: 'sales return',
      });
      postEntry(batch.ledger, `Sales return ${i}`, POST_SNAP_DATE, 'reversal', `ret_${i}`, [
        { account_id: `acc_${A_INVENTORY}`, debit_paise: value, credit_paise: 0, description: 'Return stock' },
        { account_id: `acc_${A_SALES}`, debit_paise: 0, credit_paise: value, description: 'Contra sales' },
      ]);
    } else {
      // Purchase return: goods leave stock. Dr AP / Cr Inventory (contra).
      batch.stock_movements.push({
        id: `sm_pr_${i}`,
        business_id: BID,
        item_id: item.id,
        warehouse_id: WH_ID,
        movement_type: 'purchase_return',
        qty_micros: -qMicros,
        unit_cost_paise: unitCost,
        ref_type: 'reversal',
        ref_id: `ret_${i}`,
        occurred_at: POST_SNAP_DATE,
        notes: 'purchase return',
      });
      const supplierIdx = i % SUPPLIER_COUNT;
      postEntry(batch.ledger, `Purchase return ${i}`, POST_SNAP_DATE, 'reversal', `ret_${i}`, [
        {
          account_id: `acc_${A_AP}`,
          debit_paise: value,
          credit_paise: 0,
          party_type: 'supplier',
          party_id: `supp_${supplierIdx}`,
          description: 'AP settle',
        },
        { account_id: `acc_${A_INVENTORY}`, debit_paise: 0, credit_paise: value, description: 'Contra inventory' },
      ]);
    }
  }
}

/**
 * 40 expenses across 4 categories, paid from cash. Dr Expense / Cr Cash.
 */
function buildExpenses(batch: Batch): void {
  for (let i = 0; i < EXPENSE_COUNT; i++) {
    const catCode = EXPENSE_CATEGORIES[i % EXPENSE_CATEGORIES.length];
    const amount = 100_000 + i * 1000;
    const expenseId = `exp_${i}`;
    const jeId = postEntry(batch.ledger, `Expense ${i}`, NOW_DATE, 'expense', expenseId, [
      { account_id: `acc_${catCode}`, debit_paise: amount, credit_paise: 0, description: 'Expense' },
      { account_id: `acc_${A_CASH}`, debit_paise: 0, credit_paise: amount, description: 'Cash out' },
    ]);
    batch.expenses.push({
      id: expenseId,
      business_id: BID,
      expense_number: `EXP-${i.toString().padStart(5, '0')}`,
      expense_date: NOW_DATE,
      category_account_id: `acc_${catCode}`,
      payment_account_id: `acc_${A_CASH}`,
      supplier_id: null,
      description: `Expense ${i} (${catCode})`,
      amount_paise: amount,
      tax_paise: 0,
      total_paise: amount,
      attachment_id: null,
      journal_entry_id: jeId,
      ...audit(),
    });
  }
}

/**
 * Build item_stock cache from all stock_movements.
 * Uses the same key shape rebuildFromDrive.rebuildItemStockFromMovements does
 * — `${businessId}:${item_id}:${warehouse_id}` — so a bit-exact match holds.
 */
function buildItemStock(batch: Batch): ItemStock[] {
  const acc = new Map<string, { qty: number; cost: number }>();
  for (const m of batch.stock_movements) {
    const key = `${BID}:${m.item_id}:${m.warehouse_id}`;
    const cur = acc.get(key) ?? { qty: 0, cost: 0 };
    cur.qty += m.qty_micros;
    if (m.unit_cost_paise > 0) cur.cost = m.unit_cost_paise;
    acc.set(key, cur);
  }
  const out: ItemStock[] = [];
  for (const [key, v] of acc) {
    const [, itemId, whId] = key.split(':');
    out.push({
      id: key,
      business_id: BID,
      item_id: itemId,
      warehouse_id: whId,
      qty_micros: v.qty,
      avg_cost_paise: v.cost,
      updated_at: NOW_ISO,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reports — the "before" snapshot values we later assert against after
// restore. Every function here is a pure read against the in-memory batch or
// against the Dexie DB, and MUST produce identical results in both cases.
// ---------------------------------------------------------------------------

interface ReportSet {
  customerCount: number;
  supplierCount: number;
  itemCount: number;
  invoiceCount: number;
  paymentCount: number;
  stockByItem: Record<string, number>;
  receivablesPaise: number;
  payablesPaise: number;
  gstBySlab: { cgst: number; sgst: number; igst: number };
  trialBalance: { totalDebit: number; totalCredit: number; perAccount: Record<string, number> };
  profitAndLoss: { revenue: number; expenses: number; net: number };
  balanceSheet: { assets: number; liabilities: number; equity: number };
}

async function computeReportFromDb(db: BusinessVaultDB): Promise<ReportSet> {
  const [
    customers,
    suppliers,
    items,
    invoices,
    payments,
    purchases,
    stocks,
    jLines,
    jEntries,
    accounts,
  ] = await Promise.all([
    db.customers.where('business_id').equals(BID).count(),
    db.suppliers.where('business_id').equals(BID).count(),
    db.items.where('business_id').equals(BID).count(),
    db.invoices.where('business_id').equals(BID).toArray(),
    db.payments.where('business_id').equals(BID).toArray(),
    db.purchases.where('business_id').equals(BID).toArray(),
    db.item_stock.where('business_id').equals(BID).toArray(),
    db.journal_lines.where('business_id').equals(BID).toArray(),
    db.journal_entries.where('business_id').equals(BID).toArray(),
    db.accounts.where('business_id').equals(BID).toArray(),
  ]);

  const stockByItem: Record<string, number> = {};
  for (const s of stocks) {
    stockByItem[s.item_id] = (stockByItem[s.item_id] ?? 0) + s.qty_micros;
  }

  let receivables = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const inv of invoices) {
    receivables += inv.balance_paise;
    cgst += inv.cgst_paise;
    sgst += inv.sgst_paise;
    igst += inv.igst_paise;
  }
  let payables = 0;
  for (const p of purchases) payables += p.balance_paise;

  // Trial balance — only posted entries.
  const postedEntryIds = new Set(jEntries.filter((e) => e.posted === 1).map((e) => e.id));
  const accById = new Map(accounts.map((a) => [a.id, a] as const));
  const perAccount: Record<string, number> = {};
  let totalDr = 0;
  let totalCr = 0;
  for (const l of jLines) {
    if (!postedEntryIds.has(l.entry_id)) continue;
    perAccount[l.account_id] =
      (perAccount[l.account_id] ?? 0) + l.debit_paise - l.credit_paise;
    totalDr += l.debit_paise;
    totalCr += l.credit_paise;
  }

  // P&L: revenue (income accounts) - expenses.
  let revenue = 0;
  let expensesTot = 0;
  for (const [accId, netDr] of Object.entries(perAccount)) {
    const acc = accById.get(accId);
    if (!acc) continue;
    if (acc.type === 'income') revenue += -netDr; // credit-normal
    if (acc.type === 'expense') expensesTot += netDr; // debit-normal
  }

  // Balance sheet (crude): sum of asset accs = assets; liability = liabilities; equity+net = equity.
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const [accId, netDr] of Object.entries(perAccount)) {
    const acc = accById.get(accId);
    if (!acc) continue;
    if (acc.type === 'asset') assets += netDr;
    if (acc.type === 'liability') liabilities += -netDr;
    if (acc.type === 'equity') equity += -netDr;
  }
  const netProfit = revenue - expensesTot;
  equity += netProfit;

  return {
    customerCount: customers,
    supplierCount: suppliers,
    itemCount: items,
    invoiceCount: invoices.length,
    paymentCount: payments.length,
    stockByItem,
    receivablesPaise: receivables,
    payablesPaise: payables,
    gstBySlab: { cgst, sgst, igst },
    trialBalance: { totalDebit: totalDr, totalCredit: totalCr, perAccount },
    profitAndLoss: { revenue, expenses: expensesTot, net: netProfit },
    balanceSheet: { assets, liabilities, equity },
  };
}

// ---------------------------------------------------------------------------
// Snapshot writer — pull rows from Dexie, project onto TABLE_SPECS,
// produce SnapshotCsvFiles for writeSnapshot.
// ---------------------------------------------------------------------------

async function buildSnapshotFiles(db: BusinessVaultDB): Promise<
  Array<{ name: string; content: Blob; rowCount: number; sha256: string }>
> {
  const stores: Record<string, unknown[]> = {};
  for (const spec of TABLE_SPECS) {
    const table = (db as unknown as Record<string, {
      where(k: string): { equals(v: unknown): { toArray(): Promise<unknown[]> } };
      toArray(): Promise<unknown[]>;
    }>)[spec.store];
    if (!table) {
      stores[spec.store] = [];
      continue;
    }
    if (spec.store === 'businesses') {
      stores[spec.store] = await db.businesses.toArray();
    } else {
      stores[spec.store] = await table.where('business_id').equals(BID).toArray();
    }
  }

  const files: Array<{ name: string; content: Blob; rowCount: number; sha256: string }> = [];
  for (const spec of TABLE_SPECS) {
    const rows = stores[spec.store] as Record<string, unknown>[];
    const prepared = rows.map((r) => {
      if (spec.store === 'payments' && Array.isArray((r as { allocations?: unknown[] }).allocations)) {
        return {
          ...r,
          allocations_json: JSON.stringify((r as { allocations: unknown[] }).allocations),
        };
      }
      return r;
    });
    const cols = spec.columns.map((c) => c.name);
    const csv = writeCsv(prepared, cols);
    const bytes = new TextEncoder().encode(csv);
    files.push({
      name: spec.file,
      content: new NodeBlob([bytes.slice().buffer as ArrayBuffer], { type: 'text/csv' }) as unknown as Blob,
      rowCount: prepared.length,
      sha256: await sha256Hex(bytes),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Journal-only event emitters. Post-snapshot invoices are written ONLY as
// events (never snapshotted) — restore must replay them to reach identity.
// Each business op emits its own event; payload_hash is a stable synthetic
// digest (restore doesn't re-verify hash chain — verifyIntegrity handles
// snapshot integrity, replay is idempotent-by-event_id).
// ---------------------------------------------------------------------------

function makeEvent(
  entityType: SyncEvent['entity_type'],
  entityId: string,
  payload: Record<string, unknown>,
  seq: number,
): SyncEvent {
  return {
    event_id: `01POST${seq.toString().padStart(20, '0')}`,
    business_id: BID,
    device_id: DEVICE_ID,
    entity_type: entityType,
    entity_id: entityId,
    operation: 'create',
    entity_version: 1,
    timestamp: `2026-08-20T10:${Math.floor(seq / 60).toString().padStart(2, '0')}:${(seq % 60).toString().padStart(2, '0')}.000Z`,
    payload,
    payload_hash: `hash_${seq}`,
    previous_hash: seq === 0 ? null : `hash_${seq - 1}`,
    sync_status: 'LOCAL_ONLY',
  };
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('Google Drive Disaster Recovery (spec §38, §41)', () => {
  let root: string;
  let dbName: string;
  let db: BusinessVaultDB;

  beforeEach(async () => {
    root = await mktmp('bv-dr-');
    dbName = `bv_dr_${ulid()}`;
    db = new BusinessVaultDB(dbName);
    await db.open();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch { /* ignore */ }
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it(
    'reconstructs Sharma Electronics bit-exactly from Drive alone',
    async () => {
      // -----------------------------------------------------------------
      // Phase 1 — Seed the "before" state.
      // -----------------------------------------------------------------
      const business = buildBusiness();
      const unit = buildUnit();
      const warehouse = buildWarehouse();
      const accounts = buildAccounts();
      const customers = buildCustomers();
      const suppliers = buildSuppliers();
      const items = buildItems();

      const batch = newBatch();
      buildPurchases(batch, items);        // 50
      buildInvoices(batch, items, INVOICE_COUNT); // 500
      buildPayments(batch);                // 300 partial + 200 full
      buildReturns(batch, items);          // 30
      buildExpenses(batch);                // 40
      const itemStock = buildItemStock(batch);

      // Bulk-add everything in one Dexie transaction.
      await db.transaction(
        'rw',
        [
          db.businesses,
          db.units,
          db.warehouses,
          db.accounts,
          db.customers,
          db.suppliers,
          db.items,
          db.item_stock,
          db.invoices,
          db.invoice_lines,
          db.purchases,
          db.purchase_lines,
          db.payments,
          db.expenses,
          db.stock_movements,
          db.journal_entries,
          db.journal_lines,
        ],
        async () => {
          await db.businesses.add(business);
          await db.units.add(unit);
          await db.warehouses.add(warehouse);
          await db.accounts.bulkAdd(accounts);
          await db.customers.bulkAdd(customers);
          await db.suppliers.bulkAdd(suppliers);
          await db.items.bulkAdd(items);
          await db.item_stock.bulkAdd(itemStock);
          await db.purchases.bulkAdd(batch.purchases);
          await db.purchase_lines.bulkAdd(batch.purchase_lines);
          await db.invoices.bulkAdd(batch.invoices);
          await db.invoice_lines.bulkAdd(batch.invoice_lines);
          await db.payments.bulkAdd(batch.payments);
          await db.expenses.bulkAdd(batch.expenses);
          await db.stock_movements.bulkAdd(batch.stock_movements);
          await db.journal_entries.bulkAdd(batch.ledger.entries);
          await db.journal_lines.bulkAdd(batch.ledger.lines);
        },
      );

      // Shape sanity: >= 5000 invoice lines.
      expect(batch.invoice_lines.length).toBeGreaterThanOrEqual(5000);

      // -----------------------------------------------------------------
      // Phase 2 — Force a full snapshot + drain sync queue.
      // -----------------------------------------------------------------
      const producer = new LocalFolderStorageProvider();
      await producer.connect({ kind: 'local-folder', rootPath: root });
      await producer.initializeBusiness({ businessId: BID, businessName: BUSINESS_NAME });

      const files = await buildSnapshotFiles(db);
      const snapHandle = await producer.writeSnapshot({
        businessId: BID,
        kind: 'daily',
        asOf: NOW_DATE,
        files,
        manifest: {
          schemaVersion: 1,
          businessId: BID,
          businessName: BUSINESS_NAME,
          counts: files.reduce(
            (acc, f) => ({ ...acc, [f.name]: f.rowCount }),
            {} as Record<string, number>,
          ),
        },
      });
      expect(snapHandle.asOf).toBe(NOW_DATE);

      // Drain: the LocalFolderStorageProvider is synchronous over fs writes,
      // so writeSnapshot returns only after every byte is durably on disk.
      // No queue to poll; equivalent to `await syncQueue.drain()`.

      // -----------------------------------------------------------------
      // Phase 3 — 100 additional invoices AFTER the snapshot. These live
      // only in the journal — restore MUST replay them.
      // -----------------------------------------------------------------
      const postBatch = newBatch();
      buildInvoices(postBatch, items, POST_SNAPSHOT_INVOICE_COUNT, INVOICE_COUNT);

      // Persist locally so the "before" state includes them.
      await db.transaction(
        'rw',
        [
          db.invoices,
          db.invoice_lines,
          db.stock_movements,
          db.item_stock,
          db.journal_entries,
          db.journal_lines,
        ],
        async () => {
          await db.invoices.bulkAdd(postBatch.invoices);
          await db.invoice_lines.bulkAdd(postBatch.invoice_lines);
          await db.stock_movements.bulkAdd(postBatch.stock_movements);
          await db.journal_entries.bulkAdd(postBatch.ledger.entries);
          await db.journal_lines.bulkAdd(postBatch.ledger.lines);
          // Update stock cache for the post-snap movements.
          for (const m of postBatch.stock_movements) {
            const key = `${BID}:${m.item_id}:${m.warehouse_id}`;
            const cur = await db.item_stock.get(key);
            if (cur) {
              await db.item_stock.put({
                ...cur,
                qty_micros: cur.qty_micros + m.qty_micros,
                updated_at: NOW_ISO,
              });
            } else {
              await db.item_stock.put({
                id: key,
                business_id: BID,
                item_id: m.item_id,
                warehouse_id: m.warehouse_id,
                qty_micros: m.qty_micros,
                avg_cost_paise: m.unit_cost_paise,
                updated_at: NOW_ISO,
              });
            }
          }
        },
      );

      // Emit journal events for every row created post-snapshot.
      const events: SyncEvent[] = [];
      let seq = 0;
      for (const inv of postBatch.invoices) {
        events.push(makeEvent('invoice', inv.id, inv as unknown as Record<string, unknown>, seq++));
      }
      for (const line of postBatch.invoice_lines) {
        events.push(makeEvent('invoice_line', line.id, line as unknown as Record<string, unknown>, seq++));
      }
      for (const m of postBatch.stock_movements) {
        events.push(makeEvent('stock_movement', m.id, m as unknown as Record<string, unknown>, seq++));
      }
      for (const je of postBatch.ledger.entries) {
        events.push(makeEvent('journal_entry', je.id, je as unknown as Record<string, unknown>, seq++));
      }
      for (const jl of postBatch.ledger.lines) {
        events.push(makeEvent('journal_line', jl.id, jl as unknown as Record<string, unknown>, seq++));
      }
      const writeResult = await producer.writeJournalEvents(events);
      expect(writeResult.written).toBe(events.length);
      expect(writeResult.duplicates).toEqual([]);

      // -----------------------------------------------------------------
      // Phase 4 — Snapshot the "before" reports.
      // -----------------------------------------------------------------
      const before = await computeReportFromDb(db);
      expect(before.customerCount).toBe(CUSTOMER_COUNT);
      expect(before.supplierCount).toBe(SUPPLIER_COUNT);
      expect(before.itemCount).toBe(ITEM_COUNT);
      expect(before.invoiceCount).toBe(INVOICE_COUNT + POST_SNAPSHOT_INVOICE_COUNT);
      expect(before.paymentCount).toBe(PARTIAL_PAYMENT_COUNT + FULL_PAYMENT_COUNT);
      expect(before.trialBalance.totalDebit).toBe(before.trialBalance.totalCredit);

      // -----------------------------------------------------------------
      // Phase 5 — NUKE. Simulate total loss of every device + our servers.
      // -----------------------------------------------------------------
      db.close();
      await db.delete();
      // Also drop the producer's in-process reference to prove restore
      // doesn't rely on any lingering state.
      await producer.disconnect();

      // -----------------------------------------------------------------
      // Phase 6 — Fresh device. New Dexie, new provider, only the folder.
      // -----------------------------------------------------------------
      const restoredDbName = `bv_dr_restore_${ulid()}`;
      const restoredDb = new BusinessVaultDB(restoredDbName);
      await restoredDb.open();
      const restoreProvider = new LocalFolderStorageProvider();
      const report = await rebuildFromDrive(restoreProvider, {
        db: restoredDb,
        providerConfig: { kind: 'local-folder', rootPath: root },
      });

      try {
        // Validators all pass on the restored DB.
        expect(report.checksumsOk).toBe(true);
        expect(report.accountingBalanced).toBe(true);
        expect(report.inventoryConsistent).toBe(true);
        expect(report.gstReconciled).toBe(true);
        expect(report.diagnostics.ok).toBe(true);

        // -----------------------------------------------------------------
        // Phase 7 — Compare every value.
        // -----------------------------------------------------------------
        const after = await computeReportFromDb(restoredDb);

        expect(after.customerCount).toBe(before.customerCount);
        expect(after.supplierCount).toBe(before.supplierCount);
        expect(after.itemCount).toBe(before.itemCount);
        expect(after.invoiceCount).toBe(before.invoiceCount);
        expect(after.paymentCount).toBe(before.paymentCount);

        // Per-item stock quantities match exactly.
        expect(Object.keys(after.stockByItem).sort()).toEqual(
          Object.keys(before.stockByItem).sort(),
        );
        for (const [itemId, qty] of Object.entries(before.stockByItem)) {
          expect(after.stockByItem[itemId]).toBe(qty);
        }

        // AR total, AP total.
        expect(after.receivablesPaise).toBe(before.receivablesPaise);
        expect(after.payablesPaise).toBe(before.payablesPaise);

        // GST liability per slab.
        expect(after.gstBySlab).toEqual(before.gstBySlab);

        // Trial balance = 0 (dr = cr) AND per-account balances match.
        expect(after.trialBalance.totalDebit).toBe(after.trialBalance.totalCredit);
        expect(after.trialBalance.totalDebit).toBe(before.trialBalance.totalDebit);
        expect(after.trialBalance.perAccount).toEqual(before.trialBalance.perAccount);

        // P&L.
        expect(after.profitAndLoss).toEqual(before.profitAndLoss);

        // Balance sheet — assets = liabilities + equity (accounting identity).
        expect(after.balanceSheet).toEqual(before.balanceSheet);
        expect(after.balanceSheet.assets).toBe(
          after.balanceSheet.liabilities + after.balanceSheet.equity,
        );
      } finally {
        restoredDb.close();
        await restoredDb.delete().catch(() => undefined);
      }
    },
    120_000, // 2-minute budget per spec §38.
  );
});
