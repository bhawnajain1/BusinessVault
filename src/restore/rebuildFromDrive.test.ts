import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { LocalFolderStorageProvider } from '../storage/LocalFolderStorageProvider';
import type { SyncEvent } from '../storage/CustomerStorageProvider';
import { BusinessVaultDB } from '../db/database';
import {
  rebuildFromDrive,
  BackupIntegrityError,
  EmptyBackupError,
  UnshippedEventsError,
  repairLegacyJournalHeaders,
} from './rebuildFromDrive';
import { metaDb, __resetMetaDbForTests } from '../lib/device';
import { writeCsv } from '../csv/csvCodec';
import { TABLE_SPECS } from './tableSchema';
import type {
  Advance,
  Invoice,
  Payment,
  Purchase,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
  JournalEntry,
  JournalLine,
  GstProfile,
} from '../db/types';
import { applyEvent, getEventHandler } from './eventHandlers';

// jsdom Blob has no arrayBuffer; force Node's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Blob = NodeBlob;
process.env.NODE_ENV = 'test';

async function mktmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'bv-restore-'));
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

// ---------------------------------------------------------------------------
// Fixture: a tiny complete business with two customers, one item, one invoice
// (2 lines), one payment, and a balanced journal.
// ---------------------------------------------------------------------------

const BID = 'biz_1';
const NOW = '2026-08-19T10:00:00.000Z';

function commonAudit(v = 1) {
  return { created_at: NOW, updated_at: NOW, entity_version: v };
}

const business = {
  id: BID,
  name: 'Acme Traders',
  legal_name: 'Acme Traders Pvt Ltd',
  gstin: '27AAECA1234H1Z5',
  pan: 'AAECA1234H',
  address_line1: 'Plot 1',
  address_line2: '',
  city: 'Mumbai',
  state: 'Maharashtra',
  state_code: '27',
  pincode: '400001',
  country: 'IN',
  phone: '9999999999',
  email: 'ops@acme.example',
  financial_year_start_month: 4,
  current_financial_year: '2026-27',
  currency: 'INR',
  logo_ref: null,
  invoice_prefix: 'INV-',
  invoice_next_seq: 2,
  drive_folder_id: null,
  drive_connected_email: null,
  schema_version: 1,
  ...commonAudit(),
};

const cust1 = {
  id: 'cust_1',
  business_id: BID,
  name: 'Alpha Retail',
  phone: '8000000001',
  email: 'a@alpha.example',
  gstin: '27AAAAA0000A1Z0',
  billing_address: 'BLD 1',
  shipping_address: 'BLD 1',
  state: 'Maharashtra',
  state_code: '27',
  opening_balance_paise: 0,
  credit_limit_paise: 10000000,
  notes: '',
  active: 1,
  ...commonAudit(),
};
const cust2 = { ...cust1, id: 'cust_2', name: 'Beta Kirana', phone: '8000000002' };

const unit = {
  id: 'unit_pcs',
  business_id: BID,
  code: 'PCS',
  name: 'Pieces',
  decimal_places: 0,
  ...commonAudit(),
};
const warehouse = {
  id: 'wh_main',
  business_id: BID,
  name: 'Main Warehouse',
  address: '',
  is_default: 1,
  active: 1,
  ...commonAudit(),
};

const item = {
  id: 'item_1',
  business_id: BID,
  sku: 'SKU-1',
  name: 'Widget',
  description: '',
  hsn: '8481',
  category_id: null,
  unit_id: 'unit_pcs',
  sale_price_paise: 10000, // 100.00
  purchase_price_paise: 8000,
  tax_rate_bps: 1800, // 18%
  cess_rate_bps: 0,
  is_service: 0,
  track_inventory: 1,
  opening_qty_micros: 100_000_000, // 100 units
  opening_value_paise: 800_000,
  reorder_level_micros: 0,
  barcode: null,
  image_ref: null,
  active: 1,
  ...commonAudit(),
};

// Opening stock movement so identity holds.
const mvOpening = {
  id: 'mv_opening',
  business_id: BID,
  item_id: 'item_1',
  warehouse_id: 'wh_main',
  movement_type: 'opening',
  qty_micros: 100_000_000,
  unit_cost_paise: 8000,
  ref_type: 'opening',
  ref_id: 'mv_opening',
  occurred_at: NOW,
  notes: '',
};
// Sale movement matching the invoice below (2 units).
const mvSale = {
  id: 'mv_sale',
  business_id: BID,
  item_id: 'item_1',
  warehouse_id: 'wh_main',
  movement_type: 'sale',
  qty_micros: -2_000_000,
  unit_cost_paise: 8000,
  ref_type: 'invoice',
  ref_id: 'inv_1',
  occurred_at: NOW,
  notes: '',
};

// One CGST/SGST intra-state invoice: 2 * 100 = 200 taxable + 18% GST = 236.
const inv1 = {
  id: 'inv_1',
  business_id: BID,
  invoice_number: 'INV-000001',
  invoice_date: '2026-08-19',
  due_date: null,
  customer_id: 'cust_1',
  customer_state_code: '27',
  place_of_supply: '27',
  is_interstate: 0,
  financial_year: '2026-27',
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
  paid_paise: 0,
  balance_paise: 23600,
  status: 'issued',
  reversed_by_invoice_id: null,
  reverses_invoice_id: null,
  notes: '',
  terms: '',
  pdf_attachment_id: null,
  journal_entry_id: 'je_1',
  ...commonAudit(),
};
const inv1_line = {
  id: 'line_1',
  business_id: BID,
  invoice_id: 'inv_1',
  line_no: 1,
  item_id: 'item_1',
  description: 'Widget',
  hsn: '8481',
  warehouse_id: 'wh_main',
  qty_micros: 2_000_000,
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

// Chart of accounts (system minimum).
const accCash = {
  id: 'acc_cash',
  business_id: BID,
  code: '1000',
  name: 'Cash',
  type: 'asset',
  subtype: 'current_asset',
  parent_id: null,
  opening_balance_paise: 0,
  is_system: 1,
  active: 1,
  ...commonAudit(),
};
const accAR = { ...accCash, id: 'acc_ar', code: '1200', name: 'Accounts Receivable' };
const accRevenue = {
  ...accCash,
  id: 'acc_rev',
  code: '4000',
  name: 'Sales Revenue',
  type: 'income',
  subtype: 'operating_income',
};
const accCgst = {
  ...accCash,
  id: 'acc_cgst',
  code: '2100',
  name: 'CGST Payable',
  type: 'liability',
  subtype: 'gst_payable',
};
const accSgst = {
  ...accCash,
  id: 'acc_sgst',
  code: '2110',
  name: 'SGST Payable',
  type: 'liability',
  subtype: 'gst_payable',
};

const accounts = [accCash, accAR, accRevenue, accCgst, accSgst];

// Sales journal: DR AR 236 / CR Revenue 200, CR CGST 18, CR SGST 18.
const je1 = {
  id: 'je_1',
  business_id: BID,
  entry_number: 'JE-1',
  entry_date: '2026-08-19',
  narration: 'Invoice INV-000001',
  ref_type: 'invoice',
  ref_id: 'inv_1',
  reversed_by_id: null,
  reverses_id: null,
  total_debit_paise: 23600,
  total_credit_paise: 23600,
  posted: 1,
  ...commonAudit(),
};
const je1_lines = [
  {
    id: 'jl_1',
    business_id: BID,
    entry_id: 'je_1',
    line_no: 1,
    account_id: 'acc_ar',
    debit_paise: 23600,
    credit_paise: 0,
    party_type: 'customer',
    party_id: 'cust_1',
    description: 'AR',
  },
  {
    id: 'jl_2',
    business_id: BID,
    entry_id: 'je_1',
    line_no: 2,
    account_id: 'acc_rev',
    debit_paise: 0,
    credit_paise: 20000,
    party_type: null,
    party_id: null,
    description: 'Revenue',
  },
  {
    id: 'jl_3',
    business_id: BID,
    entry_id: 'je_1',
    line_no: 3,
    account_id: 'acc_cgst',
    debit_paise: 0,
    credit_paise: 1800,
    party_type: null,
    party_id: null,
    description: 'CGST',
  },
  {
    id: 'jl_4',
    business_id: BID,
    entry_id: 'je_1',
    line_no: 4,
    account_id: 'acc_sgst',
    debit_paise: 0,
    credit_paise: 1800,
    party_type: null,
    party_id: null,
    description: 'SGST',
  },
];

// One payment: Alpha pays 10000 paise on inv_1. Emitted as a journal event
// after the snapshot to prove replay works.
const payment1 = {
  id: 'pay_1',
  business_id: BID,
  payment_number: 'PMT-1',
  payment_date: '2026-08-20',
  direction: 'in',
  party_type: 'customer',
  party_id: 'cust_1',
  method: 'cash',
  account_id: 'acc_cash',
  amount_paise: 10000,
  reference: '',
  notes: '',
  allocations: [{ invoice_id: 'inv_1', amount_paise: 10000 }],
  journal_entry_id: 'je_2',
  ...commonAudit(),
};
const je2 = {
  id: 'je_2',
  business_id: BID,
  entry_number: 'JE-2',
  entry_date: '2026-08-20',
  narration: 'Payment PMT-1',
  ref_type: 'payment',
  ref_id: 'pay_1',
  reversed_by_id: null,
  reverses_id: null,
  total_debit_paise: 10000,
  total_credit_paise: 10000,
  posted: 1,
  ...commonAudit(),
};
const je2_lines = [
  {
    id: 'jl_5',
    business_id: BID,
    entry_id: 'je_2',
    line_no: 1,
    account_id: 'acc_cash',
    debit_paise: 10000,
    credit_paise: 0,
    party_type: null,
    party_id: null,
    description: 'Cash in',
  },
  {
    id: 'jl_6',
    business_id: BID,
    entry_id: 'je_2',
    line_no: 2,
    account_id: 'acc_ar',
    debit_paise: 0,
    credit_paise: 10000,
    party_type: 'customer',
    party_id: 'cust_1',
    description: 'AR settle',
  },
];

// ---------------------------------------------------------------------------
// Test helper: turn our fixture rows into snapshot CSV files
// ---------------------------------------------------------------------------

async function makeSnapshotFiles(
  snapshotBusiness: Record<string, unknown> = business,
  snapshotPayments: Payment[] = [],
  additionalRows: Record<string, Record<string, unknown>[]> = {},
) {
  const byStore: Record<string, Record<string, unknown>[]> = {
    businesses: [snapshotBusiness],
    customers: [cust1, cust2],
    suppliers: [],
    categories: [],
    units: [unit],
    warehouses: [warehouse],
    items: [item],
    item_stock: [
      {
        id: `${BID}:item_1:wh_main`,
        business_id: BID,
        item_id: 'item_1',
        warehouse_id: 'wh_main',
        qty_micros: 98_000_000, // 100 - 2
        avg_cost_paise: 8000,
        updated_at: NOW,
      },
    ],
    invoices: [inv1],
    invoice_lines: [inv1_line],
    purchases: [],
    purchase_lines: [],
    payments: snapshotPayments as unknown as Record<string, unknown>[],
    expenses: [],
    stock_movements: [mvOpening, mvSale],
    accounts,
    journal_entries: [je1],
    journal_lines: je1_lines,
    ...additionalRows,
  };

  const files = [] as Array<{
    name: string;
    content: Blob;
    rowCount: number;
    sha256: string;
  }>;
  for (const spec of TABLE_SPECS) {
    const rows = byStore[spec.store] ?? [];
    // For payments, serialize allocations into allocations_json column.
    const preparedRows = rows.map((r) => {
      if (spec.store === 'payments' && Array.isArray((r as { allocations?: unknown[] }).allocations)) {
        return {
          ...r,
          allocations_json: JSON.stringify((r as { allocations: unknown[] }).allocations),
        };
      }
      return r;
    });
    const cols = spec.columns.map((c) => c.name);
    const csv = writeCsv(preparedRows, cols);
    const bytes = new TextEncoder().encode(csv);
    files.push({
      name: spec.file,
      content: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/csv' }),
      rowCount: preparedRows.length,
      sha256: await sha256Hex(bytes),
    });
  }
  return files;
}

function makePaymentEvent(): SyncEvent {
  return {
    event_id: '01JABC0000000000000000001',
    business_id: BID,
    device_id: 'device_test',
    entity_type: 'payment',
    entity_id: 'pay_1',
    operation: 'create',
    entity_version: 1,
    timestamp: '2026-08-20T10:00:00.000Z',
      payload: payment1 as unknown as Readonly<Record<string, unknown>>,
    payload_hash: 'deadbeef',
    previous_hash: null,
    sync_status: 'LOCAL_ONLY',
  };
}
function makeJournalPostedEvent(): SyncEvent {
  return {
    event_id: '01JABC0000000000000000002',
    business_id: BID,
    device_id: 'device_test',
    entity_type: 'journal_entry',
    // provider-side SyncOperation vocabulary is create|update|delete|void|adjust|reverse.
    // Restore's handler map matches on entity+operation, and we register
    // journal_entry:create as an alias.
    entity_id: 'je_2',
    operation: 'create',
    entity_version: 1,
    timestamp: '2026-08-20T10:00:01.000Z',
    payload: je2,
    payload_hash: 'deadbee2',
    previous_hash: 'deadbeef',
    sync_status: 'LOCAL_ONLY',
  };
}
function makeJournalLineEvents(): SyncEvent[] {
  return je2_lines.map((l, i) => ({
    event_id: `01JABC000000000000000010${i}`,
    business_id: BID,
    device_id: 'device_test',
    entity_type: 'journal_line',
    entity_id: l.id,
    operation: 'create',
    entity_version: 1,
    timestamp: '2026-08-20T10:00:02.000Z',
    payload: l,
    payload_hash: `dead1${i}`,
    previous_hash: 'deadbee2',
    sync_status: 'LOCAL_ONLY',
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rebuildFromDrive', () => {
  let root: string;
  let db: BusinessVaultDB;
  let provider: LocalFolderStorageProvider;

  it('repairs stale totals only when journal lines are balanced', async () => {
    const testDb = new BusinessVaultDB(`bv-header-repair-${Date.now()}-${Math.random()}`);
    const entry = {
      ...je1,
      total_debit_paise: 100,
      total_credit_paise: 100,
    } as unknown as JournalEntry;
    const badEntry = {
      ...je2,
      total_debit_paise: 99,
      total_credit_paise: 99,
    } as unknown as JournalEntry;
    await testDb.journal_entries.bulkPut([entry, badEntry]);
    const snapshotLines = [
      ...(je1_lines as unknown as JournalLine[]),
      ...(je2_lines as unknown as JournalLine[]),
    ];
    const badLine = {
      ...je2_lines[0],
      id: 'unbalanced-line',
      debit_paise: 1,
    } as unknown as JournalLine;
    await testDb.journal_lines.bulkPut([...snapshotLines, badLine]);

    const repaired = await repairLegacyJournalHeaders(BID, testDb);

    expect(repaired).toContain(entry.id);
    expect(repaired).not.toContain(badEntry.id);
    expect((await testDb.journal_entries.get(entry.id))?.total_debit_paise).toBe(23600);
    expect((await testDb.journal_entries.get(badEntry.id))?.total_debit_paise).toBe(99);
    testDb.close();
  });

  it('rejects journal events from another business before dispatch', async () => {
    const testDb = new BusinessVaultDB(`bv-event-scope-${Date.now()}-${Math.random()}`);
    const diagnostics: string[] = [];
    await expect(
      applyEvent(
        {
          event_id: 'evt-wrong-business',
          business_id: 'other-business',
          device_id: 'device-1',
          entity_type: 'customer',
          entity_id: 'customer-1',
          operation: 'create',
          entity_version: 1,
          timestamp: new Date().toISOString(),
          payload: { id: 'customer-1', business_id: 'other-business' },
          payload_hash: 'hash',
          previous_hash: null,
          sync_status: 'SYNCED',
        },
        { db: testDb, businessId: BID, diagnostics },
      ),
    ).rejects.toThrow('belongs to business other-business');
    await testDb.delete();
  });

  it('replays one aggregate GSTR-2B import idempotently and rejects cross-business children', async () => {
    const testDb = new BusinessVaultDB(`bv-gstr2b-event-${Date.now()}-${Math.random()}`);
    const stores = testDb as unknown as Record<string, {
      get(id: string): Promise<Record<string, unknown> | undefined>;
      where(key: string): { equals(value: string): { count(): Promise<number> } };
    }>;
    const diagnostics: string[] = [];
    const imported = {
      id: 'gstr2b-import-event',
      business_id: BID,
      return_period: '082026',
      status: 'imported',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const documents = [
      {
        id: 'gstr2b-document-event-1',
        business_id: BID,
        gstr2b_import_id: imported.id,
        canonical_document_number: 'INV/001',
        search_normalized_document_number: 'INV001',
        taxable_paise: 10000,
      },
      {
        id: 'gstr2b-document-event-2',
        business_id: BID,
        gstr2b_import_id: imported.id,
        canonical_document_number: 'CN/002',
        search_normalized_document_number: 'CN002',
        taxable_paise: 5000,
      },
    ];
    const attachment = {
      id: 'gstr2b-attachment-event',
      business_id: BID,
      ref_type: 'gstr2b_import',
      ref_id: imported.id,
      filename: 'gstr2b.json',
      mime_type: 'application/json',
      size_bytes: 128,
      checksum: 'checksum-gstr2b',
      drive_file_id: null,
      logical_path: 'attachments/gstr2b/import.json',
      created_at: NOW,
      updated_at: NOW,
    };
    const event: SyncEvent = {
      event_id: 'evt_gstr2b_aggregate',
      business_id: BID,
      device_id: 'device_test',
      entity_type: 'gstr2b_import',
      entity_id: imported.id,
      operation: 'create',
      entity_version: 1,
      timestamp: NOW,
      payload: { business_id: BID, import: imported, documents, attachment },
      payload_hash: 'gstr2b-hash',
      previous_hash: null,
      sync_status: 'SYNCED',
    };

    expect(await applyEvent(event, { db: testDb, businessId: BID, diagnostics })).toBe('applied');
    expect(await applyEvent(event, { db: testDb, businessId: BID, diagnostics })).toBe('applied');
    expect(await stores.gstr2b_imports.where('business_id').equals(BID).count()).toBe(1);
    expect(await stores.gstr2b_documents.where('business_id').equals(BID).count()).toBe(2);
    expect(await stores.attachments.where('business_id').equals(BID).count()).toBe(1);
    expect(await stores.attachments.get(attachment.id)).toMatchObject({ blob: null });
    expect(await testDb.sync_events.count()).toBe(0);

    await expect(
      applyEvent(
        {
          ...event,
          event_id: 'evt_gstr2b_cross_business_child',
          payload: {
            business_id: BID,
            import: imported,
            documents: [{ ...documents[0], business_id: 'other-business' }],
            attachment: null,
          },
        },
        { db: testDb, businessId: BID, diagnostics },
      ),
    ).rejects.toThrow('another business');
    expect(await stores.gstr2b_imports.where('business_id').equals(BID).count()).toBe(1);
    expect(await stores.gstr2b_documents.where('business_id').equals(BID).count()).toBe(2);
    await testDb.delete();
  });

  it('replays a GSTR-2B import when attachment is omitted', async () => {
    const testDb = new BusinessVaultDB(`bv-gstr2b-no-attachment-${Date.now()}-${Math.random()}`);
    const imported = {
      id: 'gstr2b-import-without-attachment',
      business_id: BID,
      return_period: '082026',
      status: 'imported',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const event: SyncEvent = {
      event_id: 'evt_gstr2b_without_attachment',
      business_id: BID,
      device_id: 'device_test',
      entity_type: 'gstr2b_import',
      entity_id: imported.id,
      operation: 'create',
      entity_version: 1,
      timestamp: NOW,
      payload: { business_id: BID, import: imported, documents: [] },
      payload_hash: 'gstr2b-no-attachment-hash',
      previous_hash: null,
      sync_status: 'SYNCED',
    };

    await expect(
      applyEvent(event, { db: testDb, businessId: BID, diagnostics: [] }),
    ).resolves.toBe('applied');
    expect(await testDb.gstr2b_imports.get(imported.id)).toMatchObject({ id: imported.id });
    expect(await testDb.attachments.count()).toBe(0);
    await testDb.delete();
  });

  it('does not create a phantom journal entry from an orphaned legacy update', async () => {
    const testDb = new BusinessVaultDB(`bv-orphan-journal-${Date.now()}-${Math.random()}`);
    const diagnostics: string[] = [];
    await applyEvent(
      {
        event_id: 'orphan-journal-update',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'journal_entry',
        entity_id: 'missing-entry',
        operation: 'update',
        entity_version: 1,
        timestamp: new Date().toISOString(),
        payload: {
          id: 'missing-entry',
          business_id: BID,
          total_debit_paise: 100,
          total_credit_paise: 100,
        },
        payload_hash: 'hash',
        previous_hash: null,
        sync_status: 'SYNCED',
      },
      { db: testDb, businessId: BID, diagnostics },
    );

    expect(await testDb.journal_entries.get('missing-entry')).toBeUndefined();
    expect(diagnostics).not.toContain('journal_entry:update missing-entry: existing row not found');
    await testDb.delete();
  });

  it('replays a full legacy journal entry carried by an update event', async () => {
    const testDb = new BusinessVaultDB(`bv-full-journal-update-${Date.now()}-${Math.random()}`);
    const diagnostics: string[] = [];
    const row = {
      id: 'full-journal-update',
      business_id: BID,
      entry_number: 'JE-1',
      entry_date: NOW.slice(0, 10),
      narration: 'Legacy entry',
      ref_type: 'manual',
      ref_id: null,
      reversed_by_id: null,
      reverses_id: null,
      total_debit_paise: 100,
      total_credit_paise: 100,
      posted: 1,
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    } satisfies JournalEntry;

    await applyEvent(
      {
        event_id: 'full-journal-update-event',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'journal_entry',
        entity_id: row.id,
        operation: 'update',
        entity_version: 1,
        timestamp: NOW,
        payload: row,
        payload_hash: 'hash',
        previous_hash: null,
        sync_status: 'SYNCED',
      },
      { db: testDb, businessId: BID, diagnostics },
    );

    expect(await testDb.journal_entries.get(row.id)).toMatchObject(row);
    expect(diagnostics).toEqual([]);
    await testDb.delete();
  });

  it('replays a full legacy journal line carried by an update event', async () => {
    const testDb = new BusinessVaultDB(`bv-full-journal-line-update-${Date.now()}-${Math.random()}`);
    const diagnostics: string[] = [];
    const line = {
      ...je1_lines[0],
      id: 'legacy-line-update',
      entry_id: 'je_1',
    };
    await testDb.journal_entries.put({
      ...je1,
      id: 'je_1',
      total_debit_paise: line.debit_paise,
      total_credit_paise: line.credit_paise,
    } as JournalEntry);

    const result = await applyEvent(
      {
        event_id: 'full-journal-line-update-event',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'journal_line',
        entity_id: line.id,
        operation: 'update',
        entity_version: 1,
        timestamp: NOW,
        payload: line,
        payload_hash: 'hash',
        previous_hash: null,
        sync_status: 'SYNCED',
      },
      { db: testDb, businessId: BID, diagnostics },
    );

    expect(result).toBe('applied');
    expect(await testDb.journal_lines.get(line.id)).toEqual(line);
    expect(diagnostics).toEqual([]);
    await testDb.delete();
  });

  beforeEach(async () => {
    root = await mktmp();
    db = new BusinessVaultDB(`bv-restore-${Date.now()}-${Math.random()}`);

    // Prime a "producer" provider that writes the fixture into Drive.
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({
      businessId: BID,
      businessName: 'Acme Traders',
    });

    // Write a daily snapshot.
    const files = await makeSnapshotFiles();
    await producer.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-19',
      files,
      manifest: {
        schemaVersion: 1,
        counts: files.reduce(
          (acc, f) => ({ ...acc, [f.name]: f.rowCount }),
          {} as Record<string, number>,
        ),
      },
    });

    // Emit journal events for the payment created after the snapshot.
    await producer.writeJournalEvents([
      makePaymentEvent(),
      makeJournalPostedEvent(),
      ...makeJournalLineEvents(),
    ]);

    // Now build the "restore" provider (fresh instance) — this is what
    // rebuildFromDrive will use.
    provider = new LocalFolderStorageProvider();
    // rebuildFromDrive will call connect + initializeBusiness itself.
  });

  afterEach(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
    __resetMetaDbForTests();
  });

  it('registers create and update replay handlers for every GST entity type', () => {
    const entityTypes = [
      'gst_profile', 'gst_aato', 'gst_document_metadata', 'gst_report_run',
      'gst_report_row', 'gst_adjustment', 'gstr2b_import', 'gstr2b_document',
      'gst_match', 'gst_itc_ledger',
    ];
    for (const entityType of entityTypes) {
      for (const operation of ['create', 'created', 'update', 'updated']) {
        expect(getEventHandler(entityType, operation), `${entityType}:${operation}`).toBeDefined();
      }
    }
  });

  it('rebuilds a business end-to-end from the folder', async () => {
    const report = await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    // Structural counts.
    expect(report.counts.customers).toBe(2);
    expect(report.counts.items).toBe(1);
    expect(report.counts.invoices).toBe(1);
    expect(report.counts.invoice_lines).toBe(1);
    expect(report.counts.accounts).toBe(5);
    expect(report.counts.stock_movements).toBe(2);

    // Payment was NOT in the snapshot — it comes from journal replay.
    expect(report.counts.payments).toBe(1);
    expect(report.counts.journal_entries).toBe(2); // je_1 (snapshot) + je_2 (replay)
    expect(report.counts.journal_lines).toBe(4 + 2); // je_1 has 4, je_2 has 2
    expect(report.countReconciliation).toEqual({
      exact: true,
      compared: true,
      mismatches: {},
    });
    expect(report.sourceCounts.payments).toBe(1);
    expect(report.sourceCounts.journal_entries).toBe(2);
    expect(report.sourceCounts.journal_lines).toBe(6);

    // Validation flags.
    expect(report.checksumsOk).toBe(true);
    expect(report.accountingBalanced).toBe(true);
    expect(report.inventoryConsistent).toBe(true);
    expect(report.gstReconciled).toBe(true);
    expect(report.diagnostics.ok).toBe(true);
    expect(report.diagnostics.issues.filter((issue) => issue.severity === 'warning')).toHaveLength(0);

    // Derived rebuild: invoice paid/balance recomputed from payment replay.
    const inv = await db.invoices.get('inv_1');
    expect(inv).toBeDefined();
    expect(inv!.paid_paise).toBe(10000);
    expect(inv!.balance_paise).toBe(13600);
    expect(inv!.status).toBe('partial');
  });

  it('restores normalized GSTR-2B documents from the snapshot and reconciles aggregate replay counts', async () => {
    const snapshotImport = {
      id: 'gstr2b-import-snapshot',
      business_id: BID,
      return_period: '072026',
      status: 'imported',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const snapshotDocument = {
      id: 'gstr2b-document-snapshot',
      business_id: BID,
      gstr2b_import_id: snapshotImport.id,
      canonical_document_number: 'A/001',
      search_normalized_document_number: 'A001',
      supplier_gstin: '27AAAAA0000A1Z0',
      taxable_paise: 20000,
      igst_paise: 3600,
    };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-19',
      files: await makeSnapshotFiles(business, [], {
        gstr2b_imports: [snapshotImport],
        gstr2b_documents: [snapshotDocument],
      }),
      manifest: { schemaVersion: 13, journalCheckpoint: 'snapshot-checkpoint' },
    });
    const replayImport = {
      id: 'gstr2b-import-replay',
      business_id: BID,
      return_period: '082026',
      status: 'imported',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const replayDocument = {
      id: 'gstr2b-document-replay',
      business_id: BID,
      gstr2b_import_id: replayImport.id,
      canonical_document_number: 'B/002',
      search_normalized_document_number: 'B002',
      supplier_gstin: '27BBBBB0000B1Z0',
      taxable_paise: 30000,
      igst_paise: 5400,
    };
    const replayAttachment = {
      id: 'gstr2b-attachment-replay',
      business_id: BID,
      ref_type: 'gstr2b_import',
      ref_id: replayImport.id,
      filename: 'gstr2b-082026.json',
      mime_type: 'application/json',
      size_bytes: 256,
      checksum: 'replay-attachment-checksum',
      drive_file_id: 'drive-file-gstr2b',
      logical_path: 'attachments/gstr2b/082026.json',
      created_at: NOW,
      updated_at: NOW,
    };
    const importWithoutAttachment = {
      id: 'gstr2b-import-without-attachment-replay',
      business_id: BID,
      return_period: '092026',
      status: 'imported',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    await producer.writeJournalEvents([
      {
        event_id: 'evt_gstr2b_import_after_snapshot',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'gstr2b_import',
        entity_id: replayImport.id,
        operation: 'create',
        entity_version: 1,
        timestamp: '2026-08-20T10:00:00.000Z',
        payload: {
          business_id: BID,
          import: replayImport,
          documents: [replayDocument],
          attachment: replayAttachment,
        },
        payload_hash: 'gstr2b-replay-hash',
        previous_hash: null,
        sync_status: 'LOCAL_ONLY',
      },
      {
        event_id: 'evt_gstr2b_import_without_attachment_after_snapshot',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'gstr2b_import',
        entity_id: importWithoutAttachment.id,
        operation: 'create',
        entity_version: 1,
        timestamp: '2026-08-21T10:00:00.000Z',
        payload: {
          business_id: BID,
          import: importWithoutAttachment,
          documents: [],
          attachment: null,
        },
        payload_hash: 'gstr2b-no-attachment-replay-hash',
        previous_hash: null,
        sync_status: 'LOCAL_ONLY',
      },
    ]);

    const report = await rebuildFromDrive(new LocalFolderStorageProvider(), {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });
    const stores = db as unknown as Record<string, {
      get(id: string): Promise<Record<string, unknown> | undefined>;
    }>;

    expect(report.migratedFrom).toBe(13);
    expect(report.countReconciliation).toEqual({ exact: true, compared: true, mismatches: {} });
    expect(report.counts.gstr2b_imports).toBe(3);
    expect(report.counts.gstr2b_documents).toBe(2);
    expect(report.counts.attachments).toBe(1);
    expect(report.sourceCounts.gstr2b_imports).toBe(3);
    expect(report.sourceCounts.gstr2b_documents).toBe(2);
    expect(report.sourceCounts.attachments).toBe(1);
    expect(await stores.gstr2b_documents.get(snapshotDocument.id)).toMatchObject({
      canonical_document_number: 'A/001',
      search_normalized_document_number: 'A001',
      gstr2b_import_id: snapshotImport.id,
    });
    expect(await stores.gstr2b_documents.get(replayDocument.id)).toMatchObject({
      canonical_document_number: 'B/002',
      search_normalized_document_number: 'B002',
    });
    expect(await stores.attachments.get(replayAttachment.id)).toMatchObject({ blob: null });
    expect(report.unhandledEvents).toBe(0);
  });

  it('restores saved GST working JSON, aggregate child/audit counts and rejects corrupt bytes before wipe', async () => {
    const runId = 'monthly-gst-run';
    const attachmentId = 'monthly-gst-attachment';
    const logicalPath = `attachments/gst/report-runs/${runId}/working.json`;
    const json = '{"schema":"businessvault.gst-working.v1","sourceDataHash":"unchanged-source-hash"}';
    const bytes = new TextEncoder().encode(json);
    const checksum = await sha256Hex(bytes);
    const run = { id: runId, business_id: BID, gstin_snapshot: business.gstin, report_type: 'MONTHLY_GST_PACK',
      financial_year: '2026-27', tax_period_key: '2026-08', period_start: '2026-08-01', period_end: '2026-08-31',
      next_period_start: '2026-09-01', period_type: 'MONTH', report_schema_version: 1, filing_frequency: 'MONTHLY',
      rule_set_version: 'synthetic-v1', status: 'FINALIZED_WORKING', generated_at: NOW, generated_by_device_id: 'device_test',
      source_data_hash: 'unchanged-source-hash', source_artifact_attachment_id: attachmentId, totals_json: '{"cgst_paise":90}',
      imported_file_hash: null, finalized_at: NOW, reviewed_at: NOW, filed_at: null, arn: null,
      filing_acknowledgment_attachment_id: null, supersedes_report_run_id: null, ...commonAudit() };
    const attachment = { id: attachmentId, business_id: BID, ref_type: 'gst_report_run', ref_id: runId, filename: 'working.json',
      mime_type: 'application/json', size_bytes: bytes.length, checksum, blob: null, drive_file_id: null,
      logical_path: logicalPath, created_at: NOW, updated_at: NOW };
    const row = { id: 'monthly-gst-child', business_id: BID, report_run_id: runId, section_code: 'MONTHLY_GST_PACK', row_key: '2026-08',
      source_entity_type: null, source_entity_id: null, source_entity_version: null, classification_reason: null,
      taxable_paise: null, cgst_paise: null, sgst_paise: null, igst_paise: null, cess_paise: null,
      invoice_value_paise: null, quantity_micros: null, payload_json: json, ...commonAudit() };
    const auditRow = { id: 'monthly-gst-audit', business_id: BID, device_id: 'device_test', actor: 'device_test',
      action: 'gst_report_run.saved', entity_type: 'gst_report_run', entity_id: runId, before: null, after: run, at: NOW };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.uploadAttachment({ path: logicalPath, blob: new Blob([json], { type: 'application/json' }), mimeType: 'application/json' });
    await producer.writeJournalEvents([{ event_id: 'monthly-gst-event', business_id: BID, device_id: 'device_test',
      entity_type: 'gst_report_run', entity_id: runId, operation: 'create', entity_version: 1, timestamp: '2026-08-20T10:00:00Z',
      payload: { row: run, rows: [row], audit: auditRow, attachment }, payload_hash: 'synthetic-hash', previous_hash: null, sync_status: 'LOCAL_ONLY' }]);
    const report = await rebuildFromDrive(new LocalFolderStorageProvider(), { db, providerConfig: { kind: 'local-folder', rootPath: root } });
    expect(report.countReconciliation.exact).toBe(true);
    expect((await db.gst_report_runs.get(runId))?.source_data_hash).toBe('unchanged-source-hash');
    expect((await db.gst_report_rows.get(row.id))?.payload_json).toBe(json);
    expect(await db.audit_log.get(auditRow.id)).toMatchObject({ entity_id: runId });
    expect(await new Response((await db.attachments.get(attachmentId))!.blob!).text()).toBe(json);
    await fs.writeFile(path.join(root, 'BusinessVault - Acme Traders', logicalPath), 'corrupt');
    await expect(rebuildFromDrive(new LocalFolderStorageProvider(), { db, providerConfig: { kind: 'local-folder', rootPath: root }, confirmDataLoss: true })).rejects.toBeInstanceOf(BackupIntegrityError);
    expect(await new Response((await db.attachments.get(attachmentId))!.blob!).text()).toBe(json);
  });

  it('restores and verifies original GSTR-2B attachment bytes from a snapshot', async () => {
    const sourceBytes = new TextEncoder().encode('{"redacted":"portal source"}');
    const sourceHash = await sha256Hex(sourceBytes);
    const importId = 'gstr2b-import-with-source';
    const attachmentId = 'gstr2b-source-attachment';
    const logicalPath = `attachments/gstr2b/${importId}-source.json`;
    const imported = {
      id: importId,
      business_id: BID,
      gstin_snapshot: business.gstin,
      tax_period_key: '2026-08',
      source_type: 'GSTR2B_JSON',
      original_attachment_id: attachmentId,
      sha256: sourceHash,
      imported_at: NOW,
      portal_generated_at: null,
      recomputed_at: null,
      schema_adapter_version: 'fixture-interface-v1',
      parse_status: 'PARSED',
      parse_errors_json: null,
      supersedes_import_id: null,
      is_latest: 1,
      ...commonAudit(),
    };
    const attachment = {
      id: attachmentId,
      business_id: BID,
      ref_type: 'gstr2b_import',
      ref_id: importId,
      filename: 'source.json',
      mime_type: 'application/json',
      size_bytes: sourceBytes.length,
      checksum: sourceHash,
      drive_file_id: null,
      logical_path: logicalPath,
      created_at: NOW,
      updated_at: NOW,
    };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.uploadAttachment({
      path: logicalPath,
      blob: new Blob([sourceBytes.slice().buffer as ArrayBuffer], { type: 'application/json' }),
      mimeType: 'application/json',
    });
    await producer.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-19',
      files: await makeSnapshotFiles(business, [], {
        gstr2b_imports: [imported],
        attachments: [attachment],
      }),
      manifest: { schemaVersion: 14 },
    });

    const report = await rebuildFromDrive(new LocalFolderStorageProvider(), {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    const restoredAttachment = await db.attachments.get(attachmentId);
    expect(report.countReconciliation.exact).toBe(true);
    expect(restoredAttachment?.checksum).toBe(imported.sha256);
    expect(restoredAttachment?.blob).toBeInstanceOf(Blob);
    expect(await new Response(restoredAttachment!.blob!).text()).toBe('{"redacted":"portal source"}');
    await fs.writeFile(path.join(root, 'BusinessVault - Acme Traders', logicalPath), 'corrupted source');
    await expect(
      rebuildFromDrive(new LocalFolderStorageProvider(), {
        db,
        providerConfig: { kind: 'local-folder', rootPath: root },
        confirmDataLoss: true,
      }),
    ).rejects.toBeInstanceOf(BackupIntegrityError);
    expect(await db.gstr2b_imports.get(importId)).toMatchObject({ sha256: sourceHash });
    expect(await new Response((await db.attachments.get(attachmentId))!.blob!).text())
      .toBe('{"redacted":"portal source"}');
  });

  it('replays a post-snapshot GST profile create with correct counts and applies profile updates', async () => {
    const snapshotProfile = {
      id: 'gst-profile-snapshot',
      business_id: BID,
      gstin: '27AAAAA0000A1Z0',
      legal_name: 'Snapshot profile',
      state_code: '27',
      registration_type: 'REGULAR',
      gst_reporting_enabled: 1,
      registration_start_date: '2020-04-01',
      registration_end_date: null,
      filing_frequency: 'MONTHLY',
      effective_from: '2020-04-01',
      effective_to: null,
      active: 1,
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const createdProfile = {
      ...snapshotProfile,
      id: 'gst-profile-created-after-snapshot',
      gstin: '29BBBBB0000B1Z0',
      state_code: '29',
      legal_name: 'Journal profile',
    };
    const updateUpsertProfile = {
      ...snapshotProfile,
      id: 'gst-profile-update-upsert',
      gstin: '29DDDDD0000D1Z0',
      state_code: '29',
      legal_name: 'Update-upsert profile',
    };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-19',
      files: await makeSnapshotFiles(business, [], { gst_profiles: [snapshotProfile] }),
      manifest: { schemaVersion: 14, journalCheckpoint: 'gst-profile-checkpoint' },
    });
    await producer.writeJournalEvents([
      {
        event_id: 'evt_gst_profile_created_after_snapshot',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'gst_profile',
        entity_id: createdProfile.id,
        operation: 'create',
        entity_version: 1,
        timestamp: '2026-08-20T10:00:00.000Z',
        payload: createdProfile,
        payload_hash: 'gst-profile-create-hash',
        previous_hash: null,
        sync_status: 'LOCAL_ONLY',
      },
      {
        event_id: 'evt_gst_profile_updated_after_snapshot',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'gst_profile',
        entity_id: snapshotProfile.id,
        operation: 'update',
        entity_version: 2,
        timestamp: '2026-08-21T10:00:00.000Z',
        payload: {
          id: snapshotProfile.id,
          gstin: '27CCCCC0000C1Z0',
          legal_name: 'Updated snapshot profile',
          entity_version: 2,
        },
        payload_hash: 'gst-profile-update-hash',
        previous_hash: 'gst-profile-create-hash',
        sync_status: 'LOCAL_ONLY',
      },
      {
        event_id: 'evt_gst_profile_update_upsert_after_snapshot',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'gst_profile',
        entity_id: updateUpsertProfile.id,
        operation: 'updated' as unknown as SyncEvent['operation'],
        entity_version: 2,
        timestamp: '2026-08-22T10:00:00.000Z',
        payload: updateUpsertProfile,
        payload_hash: 'gst-profile-update-upsert-hash',
        previous_hash: 'gst-profile-update-hash',
        sync_status: 'LOCAL_ONLY',
      },
    ]);

    const report = await rebuildFromDrive(new LocalFolderStorageProvider(), {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    expect(report.countReconciliation).toEqual({ exact: true, compared: true, mismatches: {} });
    expect(report.counts.gst_profiles).toBe(3);
    expect(report.sourceCounts.gst_profiles).toBe(3);
    expect(await db.gst_profiles.get(createdProfile.id)).toMatchObject({
      gstin: createdProfile.gstin,
      filing_frequency: 'MONTHLY',
    });
    expect(await db.gst_profiles.get(snapshotProfile.id)).toMatchObject({
      gstin: '27CCCCC0000C1Z0',
      legal_name: 'Updated snapshot profile',
      state_code: '27',
    });
    expect(await db.gst_profiles.get(updateUpsertProfile.id)).toMatchObject({
      gstin: updateUpsertProfile.gstin,
      legal_name: 'Update-upsert profile',
    });
    expect(report.unhandledEvents).toBe(0);
  });

  it('restores pre-restore GST rows after a GST aggregate replay failure', async () => {
    const priorProfile: GstProfile = {
      id: 'gst-profile-prior',
      business_id: BID,
      gstin: '27AAAAA0000A1Z0',
      legal_name: 'Prior profile',
      state_code: '27',
      registration_type: 'REGULAR',
      gst_reporting_enabled: 1,
      registration_start_date: '2020-04-01',
      registration_end_date: null,
      filing_frequency: 'MONTHLY',
      effective_from: NOW,
      effective_to: null,
      active: 1,
      ...commonAudit(),
    };
    const otherBusinessProfile: GstProfile = {
      id: 'gst-profile-other-business',
      business_id: 'other-business',
      gstin: '29BBBBB0000B1Z0',
      legal_name: 'Other business profile',
      state_code: '29',
      registration_type: 'REGULAR',
      gst_reporting_enabled: 1,
      registration_start_date: '2020-04-01',
      registration_end_date: null,
      filing_frequency: 'MONTHLY',
      effective_from: NOW,
      effective_to: null,
      active: 1,
      ...commonAudit(),
    };
    await db.gst_profiles.bulkPut([priorProfile, otherBusinessProfile]);

    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeJournalEvents([{
      event_id: 'evt_gstr2b_invalid_child',
      business_id: BID,
      device_id: 'device_test',
      entity_type: 'gstr2b_import',
      entity_id: 'gstr2b-import-invalid',
      operation: 'create',
      entity_version: 1,
      timestamp: '2026-08-20T10:00:00.000Z',
      payload: {
        business_id: BID,
        import: { id: 'gstr2b-import-invalid', business_id: BID },
        documents: [{ id: 'gstr2b-document-invalid', business_id: 'other-business' }],
        attachment: null,
      },
      payload_hash: 'invalid-gstr2b-hash',
      previous_hash: null,
      sync_status: 'SYNCED',
    }]);

    await expect(
      rebuildFromDrive(new LocalFolderStorageProvider(), {
        db,
        providerConfig: { kind: 'local-folder', rootPath: root },
      }),
    ).rejects.toThrow('Restore replay failed');
    expect(await db.gst_profiles.get(priorProfile.id)).toEqual(priorProfile);
    expect(await db.gst_profiles.get(otherBusinessProfile.id)).toEqual(otherBusinessProfile);
    expect(await db.gstr2b_imports.get('gstr2b-import-invalid')).toBeUndefined();
  });

  it('restores pre-restore rows when post-replay validation fails', async () => {
    const priorProfile: GstProfile = {
      id: 'gst-profile-validation-rollback',
      business_id: BID,
      gstin: '27AAAAA0000A1Z0',
      legal_name: 'Local profile before restore',
      state_code: '27',
      registration_type: 'REGULAR',
      gst_reporting_enabled: 1,
      registration_start_date: '2020-04-01',
      registration_end_date: null,
      filing_frequency: 'MONTHLY',
      effective_from: NOW,
      effective_to: null,
      active: 1,
      ...commonAudit(),
    };
    const restoredProfile = { ...priorProfile, legal_name: 'Profile from backup' };
    await db.gst_profiles.put(priorProfile);

    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-19',
      files: await makeSnapshotFiles(business, [], { gst_profiles: [restoredProfile] }),
      manifest: { schemaVersion: 14 },
    });

    await expect(
      rebuildFromDrive(new LocalFolderStorageProvider(), {
        db,
        providerConfig: { kind: 'local-folder', rootPath: root },
        onProgress: (step) => {
          if (step === 'Verifying accounting and inventory') throw new Error('simulated validation failure');
        },
      }),
    ).rejects.toThrow('simulated validation failure');
    expect(await db.gst_profiles.get(priorProfile.id)).toEqual(priorProfile);
  });

  it('does not replay historical allocation events already covered by a snapshot', async () => {
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-21T10-00-00.000Z',
      files: await makeSnapshotFiles(business, [payment1 as unknown as Payment]),
      manifest: { schemaVersion: 1 },
    });
    await producer.writeJournalEvents([{
      event_id: '01HISTORICALALLOCATION0000001',
      business_id: BID,
      device_id: 'device_test',
      entity_type: 'payment',
      entity_id: payment1.id,
      operation: 'update',
      entity_version: 2,
      timestamp: '2026-08-18T10:00:00.000Z',
      payload: {
        payment_id: payment1.id,
        allocations: payment1.allocations,
      },
      payload_hash: 'historical-allocation',
      previous_hash: null,
      sync_status: 'LOCAL_ONLY',
    }]);

    const report = await rebuildFromDrive(new LocalFolderStorageProvider(), {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    expect(report.eventsReplayed).toBe(0);
    expect(report.diagnostics.ok).toBe(true);
    expect(await db.payments.get(payment1.id)).toMatchObject({
      allocations: payment1.allocations,
    });
  });

  it('reorders same-timestamp payment create before allocation update', async () => {
    const payment: Payment = {
      ...(payment1 as Payment),
      id: 'payment_out_of_order',
      payment_number: 'PAY-OUT-OF-ORDER',
    };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeJournalEvents([
      {
        event_id: '01ORDEREDUPDATE00000000000001',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'payment',
        entity_id: payment.id,
        operation: 'update',
        entity_version: 2,
        timestamp: '2026-08-20T10:00:00.000Z',
        payload: { payment_id: payment.id, allocations: payment.allocations },
        payload_hash: 'update-first',
        previous_hash: null,
        sync_status: 'LOCAL_ONLY',
      },
      {
        event_id: '01ORDEREDCREATE00000000000001',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'payment',
        entity_id: payment.id,
        operation: 'create',
        entity_version: 1,
        timestamp: '2026-08-20T10:00:00.000Z',
        payload: payment as unknown as Readonly<Record<string, unknown>>,
        payload_hash: 'create-second',
        previous_hash: null,
        sync_status: 'LOCAL_ONLY',
      },
    ]);

    const report = await rebuildFromDrive(new LocalFolderStorageProvider(), {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    expect(report.diagnostics.ok).toBe(true);
    expect(await db.payments.get(payment.id)).toMatchObject({
      allocations: payment.allocations,
    });
  });

  it('is idempotent — running restore twice yields the same DB state', async () => {
    await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });
    const cust = await db.customers.count();
    const inv = await db.invoices.count();
    const je = await db.journal_entries.count();

    // Second restore — reuse a fresh provider (the previous one is bound to
    // the same business but a repeat connect on LocalFolderStorageProvider is
    // fine — it just picks up the same folder).
    const p2 = new LocalFolderStorageProvider();
    await rebuildFromDrive(p2, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });
    expect(await db.customers.count()).toBe(cust);
    expect(await db.invoices.count()).toBe(inv);
    expect(await db.journal_entries.count()).toBe(je);
  });

  it('rebuilds purchase payments and supplier advance applications', async () => {
    const purchase: Purchase = {
      id: 'purchase_settlement',
      business_id: BID,
      bill_number: 'BILL-SETTLEMENT',
      supplier_bill_number: 'SUP-SETTLEMENT',
      bill_date: '2026-08-20',
      due_date: null,
      supplier_id: 'supplier_1',
      supplier_state_code: '27',
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
      status: 'received',
      reversed_by_purchase_id: null,
      reverses_purchase_id: null,
      notes: '',
      attachment_id: null,
      journal_entry_id: 'je_purchase_settlement',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const supplierPayment: Payment = {
      id: 'payment_supplier',
      business_id: BID,
      payment_number: 'PMT-SUPPLIER',
      payment_date: '2026-08-20',
      direction: 'out',
      party_type: 'supplier',
      party_id: purchase.supplier_id,
      method: 'cash',
      account_id: 'acc_cash',
      amount_paise: 3000,
      reference: '',
      notes: '',
      allocations: [{ bill_id: purchase.id, amount_paise: 3000 }],
      journal_entry_id: 'je_payment_supplier',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const supplierAdvance: Advance = {
      id: 'advance_supplier',
      business_id: BID,
      advance_number: 'ADV-SUPPLIER',
      advance_date: '2026-08-20',
      party_type: 'supplier',
      party_id: purchase.supplier_id,
      method: 'cash',
      account_id: 'acc_cash',
      amount_paise: 4000,
      remaining_paise: 2000,
      reference: '',
      notes: '',
      applications: [
        {
          bill_id: purchase.id,
          amount_paise: 2000,
          applied_at: NOW,
          journal_entry_id: 'je_advance_supplier_apply',
        },
      ],
      journal_entry_id: 'je_advance_supplier',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 2,
    };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    const event = (
      row: Purchase | Payment | Advance,
      entityType: SyncEvent['entity_type'],
    ): SyncEvent => ({
      event_id: `evt_${row.id}`,
      business_id: BID,
      device_id: 'device_test',
      entity_type: entityType,
      entity_id: row.id,
      operation: 'create',
      entity_version: row.entity_version,
      timestamp: NOW,
      payload: row as unknown as Readonly<Record<string, unknown>>,
      payload_hash: `hash_${row.id}`,
      previous_hash: null,
      sync_status: 'LOCAL_ONLY',
    });
    await producer.writeJournalEvents([
      event(purchase, 'purchase'),
      event(supplierPayment, 'payment'),
      event(supplierAdvance, 'advance'),
    ]);

    await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    expect(await db.purchases.get(purchase.id)).toMatchObject({
      paid_paise: 5000,
      balance_paise: 6800,
      status: 'partial',
    });
  });

  it('rebuilds Sales Return balance reductions and moving-average inventory cost', async () => {
    const salesReturn: SalesReturn = {
      id: 'sr_balance',
      business_id: BID,
      return_number: 'SR-BALANCE',
      return_date: '2026-08-20',
      original_invoice_id: inv1.id,
      customer_id: cust1.id,
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
      apply_to_balance_paise: 11800,
      customer_credit_paise: 0,
      status: 'posted',
      reason: 'damaged',
      notes: '',
      journal_entry_id: 'je_sr_balance',
      reversed_credit_note_invoice_id: null,
      legacy_migration_classification: null,
      device_id: 'device_test',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const laterPurchase: StockMovement = {
      id: 'mv_later_purchase',
      business_id: BID,
      item_id: item.id,
      warehouse_id: warehouse.id,
      movement_type: 'purchase',
      qty_micros: 100_000_000,
      unit_cost_paise: 12000,
      ref_type: 'purchase',
      ref_id: 'purchase_later',
      occurred_at: '2026-08-20T08:00:00.000Z',
      notes: '',
    };
    const laterSale: StockMovement = {
      id: 'mv_later_sale',
      business_id: BID,
      item_id: item.id,
      warehouse_id: warehouse.id,
      movement_type: 'sale',
      qty_micros: -50_000_000,
      unit_cost_paise: 10020,
      ref_type: 'invoice',
      ref_id: 'inv_later',
      occurred_at: '2026-08-20T09:00:00.000Z',
      notes: '',
    };
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: root });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    const event = (
      row: SalesReturn | StockMovement,
      entityType: SyncEvent['entity_type'],
    ): SyncEvent => ({
      event_id: `evt_${row.id}`,
      business_id: BID,
      device_id: 'device_test',
      entity_type: entityType,
      entity_id: row.id,
      operation: 'create',
      entity_version: 1,
      timestamp:
        entityType === 'sales_return'
          ? '2026-08-20T07:00:00.000Z'
          : (row as StockMovement).occurred_at,
      payload: row as unknown as Readonly<Record<string, unknown>>,
      payload_hash: `hash_${row.id}`,
      previous_hash: null,
      sync_status: 'LOCAL_ONLY',
    });
    await producer.writeJournalEvents([
      event(salesReturn, 'sales_return'),
      event(laterPurchase, 'stock_movement'),
      event(laterSale, 'stock_movement'),
    ]);

    await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    expect(await db.invoices.get(inv1.id)).toMatchObject({
      paid_paise: 10000,
      balance_paise: 1800,
      status: 'partial',
    });
    expect(
      await db.item_stock
        .where('[business_id+item_id+warehouse_id]')
        .equals([BID, item.id, warehouse.id])
        .first(),
    ).toMatchObject({
      qty_micros: 148_000_000,
      avg_cost_paise: 9333,
    });
  });

  it('removes stale stock cache rows when no movements remain', async () => {
    const emptyRoot = await mktmp();
    const producer = new LocalFolderStorageProvider();
    await producer.connect({ kind: 'local-folder', rootPath: emptyRoot });
    await producer.initializeBusiness({ businessId: BID, businessName: business.name });
    await producer.writeJournalEvents([
      {
        event_id: 'evt_business_only',
        business_id: BID,
        device_id: 'device_test',
        entity_type: 'business',
        entity_id: business.id,
        operation: 'create',
        entity_version: business.entity_version,
        timestamp: NOW,
        payload: business,
        payload_hash: 'hash_business_only',
        previous_hash: null,
        sync_status: 'LOCAL_ONLY',
      },
    ]);
    await db.item_stock.add({
      id: `${BID}:stale:warehouse`,
      business_id: BID,
      item_id: 'stale',
      warehouse_id: 'warehouse',
      qty_micros: 99_000_000,
      avg_cost_paise: 9999,
      updated_at: NOW,
    });

    await rebuildFromDrive(new LocalFolderStorageProvider(), {
      db,
      providerConfig: { kind: 'local-folder', rootPath: emptyRoot },
    });

    expect(await db.item_stock.where('business_id').equals(BID).count()).toBe(0);
    await fs.rm(emptyRoot, { recursive: true, force: true });
  });

  it('replaces only the selected business and preserves other local businesses', async () => {
    const otherBusinessId = 'biz_other';
    await db.businesses.add({
      ...business,
      id: otherBusinessId,
      name: 'Other Traders',
      legal_name: 'Other Traders Pvt Ltd',
    });
    await db.customers.add({
      ...cust1,
      id: 'cust_other',
      business_id: otherBusinessId,
      name: 'Other Customer',
    });
    await db.sync_events.add({
      event_id: 'evt_other_unshipped',
      business_id: otherBusinessId,
      device_id: 'device_other',
      entity_type: 'customer',
      entity_id: 'cust_other',
      operation: 'created',
      entity_version: 1,
      timestamp: '2026-08-21T09:00:00.000Z',
      payload: { id: 'cust_other' },
      payload_hash: 'otherhash',
      previous_hash: 'genesis',
      sync_status: 'LOCAL_ONLY',
      sync_attempts: 0,
      last_error: null,
      synced_at: null,
      journal_file: null,
    });

    const report = await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    expect(await db.businesses.get(otherBusinessId)).toBeDefined();
    expect(await db.customers.get('cust_other')).toMatchObject({
      business_id: otherBusinessId,
      name: 'Other Customer',
    });
    expect(await db.sync_events.get('evt_other_unshipped')).toBeDefined();
    expect(await db.businesses.get(BID)).toMatchObject({ name: 'Acme Traders' });
    expect(await db.customers.where('business_id').equals(BID).count()).toBe(2);
    expect((await db.businesses.count())).toBe(2);
    expect(report.counts.businesses).toBe(1);
  });

  it('refuses to run when the target DB has unshipped local events', async () => {
    // Seed one unshipped sync_event for this business into the target DB.
    // Restore must throw UnshippedEventsError instead of wiping.
    await db.sync_events.add({
      event_id: 'evt_unshipped_1',
      business_id: BID,
      device_id: 'device_test',
      entity_type: 'invoice',
      entity_id: 'inv_local',
      operation: 'created',
      entity_version: 1,
      timestamp: '2026-08-21T09:00:00.000Z',
      payload: { note: 'never synced' },
      payload_hash: 'unshipped1',
      previous_hash: 'genesis',
      sync_status: 'LOCAL_ONLY',
      sync_attempts: 0,
      last_error: null,
      synced_at: null,
      journal_file: null,
    });
    // Also seed a "customer" row so we can verify tables were NOT cleared.
    await db.customers.add({
      id: 'cust_local_only',
      business_id: BID,
      name: 'Local Only Cust',
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
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    });

    let thrown: unknown = null;
    try {
      await rebuildFromDrive(provider, {
        db,
        providerConfig: { kind: 'local-folder', rootPath: root },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(UnshippedEventsError);
    const err = thrown as UnshippedEventsError;
    expect(err.summary.total).toBe(1);
    expect(err.summary.byStatus.LOCAL_ONLY).toBe(1);
    expect(err.summary.byEntityType.invoice).toBe(1);
    expect(err.summary.businessId).toBe(BID);

    // Nothing on the local DB was touched — the pre-existing seed row survives.
    expect(await db.customers.get('cust_local_only')).toBeDefined();
    expect(await db.sync_events.get('evt_unshipped_1')).toBeDefined();
    // And nothing from the backup snapshot was imported.
    expect(await db.customers.count()).toBe(1);
    expect(await db.invoices.count()).toBe(0);
  });

  it('proceeds when confirmDataLoss=true is passed', async () => {
    // Same setup as the refusal test — one unshipped event + one local row.
    await db.sync_events.add({
      event_id: 'evt_unshipped_2',
      business_id: BID,
      device_id: 'device_test',
      entity_type: 'invoice',
      entity_id: 'inv_local_2',
      operation: 'created',
      entity_version: 1,
      timestamp: '2026-08-21T09:00:00.000Z',
      payload: { note: 'never synced' },
      payload_hash: 'unshipped2',
      previous_hash: 'genesis',
      sync_status: 'LOCAL_ONLY',
      sync_attempts: 0,
      last_error: null,
      synced_at: null,
      journal_file: null,
    });

    const report = await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
      confirmDataLoss: true,
    });

    // Restore ran to completion — unshipped event is gone; snapshot data landed.
    expect(report.counts.customers).toBe(2);
    expect(await db.sync_events.get('evt_unshipped_2')).toBeUndefined();
  });

  it('replays permanent invoice deletion events idempotently', async () => {
    const { applyEvent } = await import('./eventHandlers');
    const now = new Date().toISOString();
    await db.invoices.add({ ...inv1, deleted_at: now } as Invoice);
    await db.invoice_lines.add(inv1_line);
    await db.invoice_line_return_summary.add({
      invoice_line_id: inv1_line.id,
      invoice_id: inv1.id,
      business_id: BID,
      returned_qty_micros: 0,
      updated_at: now,
    });
    await db.payments.add({
      id: 'payment_invoice_purge',
      business_id: BID,
      payment_number: 'PAY-PURGE',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust_1',
      method: 'cash',
      account_id: 'acc_cash',
      amount_paise: inv1.total_paise,
      reference: '',
      notes: '',
      allocations: [{ invoice_id: inv1.id, amount_paise: inv1.total_paise }],
      journal_entry_id: 'je_payment_purge',
      deleted_at: now,
      deleted_reason: `cascade:${inv1.id}`,
      created_at: now,
      updated_at: now,
      entity_version: 2,
    });
    await db.payments.add({
      id: 'payment_invoice_purge_active',
      business_id: BID,
      payment_number: 'PAY-PURGE-ACTIVE',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust_1',
      method: 'cash',
      account_id: 'acc_cash',
      amount_paise: 100,
      reference: '',
      notes: '',
      allocations: [{ invoice_id: 'another_invoice', amount_paise: 100 }],
      journal_entry_id: 'je_payment_purge_active',
      deleted_at: null,
      deleted_reason: null,
      created_at: now,
      updated_at: now,
      entity_version: 3,
    });
    const event: SyncEvent = {
      event_id: 'evt_invoice_purge',
      business_id: BID,
      device_id: 'dev_1',
      entity_type: 'invoice',
      entity_id: inv1.id,
      operation: 'delete',
      entity_version: 2,
      timestamp: now,
      payload: {
        invoice_id: inv1.id,
        permanently_deleted: true,
        cascaded_payment_ids: [
          'payment_invoice_purge',
          'payment_invoice_purge_active',
        ],
        cascaded_advance_ids: [],
      },
      payload_hash: 'x',
      previous_hash: null,
      sync_status: 'SYNCED',
    };

    expect(await applyEvent(event, { db, businessId: BID, diagnostics: [] })).toBe(
      'applied',
    );
    expect(await applyEvent(event, { db, businessId: BID, diagnostics: [] })).toBe(
      'applied',
    );
    expect(await db.invoices.get(inv1.id)).toBeUndefined();
    expect(await db.invoice_lines.where('invoice_id').equals(inv1.id).count()).toBe(0);
    expect(await db.payments.get('payment_invoice_purge')).toBeUndefined();
    expect(await db.payments.get('payment_invoice_purge_active')).toBeDefined();
    expect(
      await db.invoice_line_return_summary.where('invoice_id').equals(inv1.id).count(),
    ).toBe(0);
  });

  it('replays "business:created" events into the businesses table', async () => {
    // Onboarding emits events with operation:'created' (not 'create'). Without
    // an explicit handler mapping, restore's applyEvent returned 'unhandled'
    // and the businesses row was never inserted from the journal — leaving
    // the app in a no-active-business state after restore.
    const { applyEvent } = await import('./eventHandlers');
    const now = new Date().toISOString();
    const businessPayload = {
      id: 'biz_replay',
      name: 'Replayed Biz',
      legal_name: '',
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
      invoice_prefix: 'INV-',
      invoice_next_seq: 1,
      drive_folder_id: null,
      drive_connected_email: null,
      schema_version: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    // Provider-wire SyncOperation is CRUD-only (create/update/…), but journals
    // written in the wild also carry past-tense verbs (created/updated/…) —
    // that's exactly the drift the ':created' handler covers. Cast to exercise
    // that wire shape through applyEvent.
    const result = await applyEvent(
      {
        event_id: 'evt_biz_replay',
        business_id: 'biz_replay',
        device_id: 'dev_1',
        entity_type: 'business',
        entity_id: 'biz_replay',
        operation: 'created' as unknown as SyncEvent['operation'],
        entity_version: 1,
        timestamp: now,
        payload: businessPayload,
        payload_hash: 'x',
        previous_hash: null,
        sync_status: 'SYNCED',
      },
      { db, businessId: 'biz_replay', diagnostics: [] },
    );

    expect(result).toBe('applied');
    const row = await db.businesses.get('biz_replay');
    expect(row).toBeDefined();
    expect(row!.name).toBe('Replayed Biz');
  });

  it('merges partial updates without deleting unchanged fields', async () => {
    const { applyEvent } = await import('./eventHandlers');
    const diagnostics: string[] = [];
    await db.customers.add(cust1);
    await db.invoices.add(inv1 as Invoice);

    const baseEvent: SyncEvent = {
      event_id: 'evt_partial_customer',
      business_id: BID,
      device_id: 'dev_1',
      entity_type: 'customer',
      entity_id: cust1.id,
      operation: 'update',
      entity_version: 2,
      timestamp: NOW,
      payload: { id: cust1.id, name: 'Renamed Customer', entity_version: 2 },
      payload_hash: 'x',
      previous_hash: null,
      sync_status: 'SYNCED',
    };
    await applyEvent(baseEvent, { db, businessId: BID, diagnostics });
    await applyEvent(
      {
        ...baseEvent,
        event_id: 'evt_partial_invoice',
        entity_type: 'invoice',
        entity_id: inv1.id,
        payload: {
          id: inv1.id,
          balance_paise: 1000,
          status: 'partial',
          entity_version: 2,
        },
      },
      { db, businessId: BID, diagnostics },
    );

    expect(await db.customers.get(cust1.id)).toMatchObject({
      business_id: BID,
      name: 'Renamed Customer',
      email: cust1.email,
    });
    expect(await db.invoices.get(inv1.id)).toMatchObject({
      business_id: BID,
      invoice_number: inv1.invoice_number,
      total_paise: inv1.total_paise,
      balance_paise: 1000,
      status: 'partial',
    });
    expect(diagnostics).toEqual([]);
  });

  it('replays sales return records, cancellation updates, and purchase reversals', async () => {
    const { applyEvent } = await import('./eventHandlers');
    const diagnostics: string[] = [];
    const salesReturn: SalesReturn = {
      id: 'sr_replay',
      business_id: BID,
      return_number: 'SR-000001',
      return_date: '2026-08-20',
      original_invoice_id: inv1.id,
      customer_id: cust1.id,
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
      apply_to_balance_paise: 11800,
      customer_credit_paise: 0,
      status: 'posted',
      reason: 'damaged',
      notes: '',
      journal_entry_id: 'je_sr',
      reversed_credit_note_invoice_id: null,
      legacy_migration_classification: null,
      device_id: 'dev_1',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    const salesReturnItem: SalesReturnItem = {
      id: 'sri_replay',
      business_id: BID,
      sales_return_id: salesReturn.id,
      original_invoice_id: inv1.id,
      original_invoice_line_id: inv1_line.id,
      item_id: item.id,
      description: item.name,
      hsn: item.hsn,
      warehouse_id: warehouse.id,
      line_no: 1,
      qty_micros: 1_000_000,
      unit_price_paise: 10000,
      discount_pct_bps: 0,
      discount_paise: 0,
      taxable_paise: 10000,
      tax_rate_bps: 1800,
      cgst_paise: 900,
      sgst_paise: 900,
      igst_paise: 0,
      cess_paise: 0,
      line_total_paise: 11800,
    };
    const purchase: Purchase = {
      id: 'purchase_replay',
      business_id: BID,
      bill_number: 'BILL-001',
      supplier_bill_number: 'SUP-001',
      bill_date: '2026-08-20',
      due_date: null,
      supplier_id: 'supplier_1',
      supplier_state_code: '27',
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
      status: 'received',
      reversed_by_purchase_id: null,
      reverses_purchase_id: null,
      notes: '',
      attachment_id: null,
      journal_entry_id: 'je_purchase',
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    };
    await db.purchases.add(purchase);

    const event = (overrides: Partial<SyncEvent>): SyncEvent => ({
      event_id: 'evt_replay',
      business_id: BID,
      device_id: 'dev_1',
      entity_type: 'sales_return',
      entity_id: salesReturn.id,
      operation: 'create',
      entity_version: 1,
      timestamp: NOW,
      payload: salesReturn as unknown as Readonly<Record<string, unknown>>,
      payload_hash: 'x',
      previous_hash: null,
      sync_status: 'SYNCED',
      ...overrides,
    });
    await applyEvent(event({}), { db, businessId: BID, diagnostics });
    await applyEvent(
      event({
        event_id: 'evt_sri_replay',
        entity_type: 'sales_return_item',
        entity_id: salesReturnItem.id,
        payload: salesReturnItem as unknown as Readonly<Record<string, unknown>>,
      }),
      { db, businessId: BID, diagnostics },
    );
    await applyEvent(
      event({
        event_id: 'evt_sr_cancel',
        operation: 'update',
        entity_version: 2,
        payload: { id: salesReturn.id, status: 'cancelled', entity_version: 2 },
      }),
      { db, businessId: BID, diagnostics },
    );
    await applyEvent(
      event({
        event_id: 'evt_purchase_reverse',
        entity_type: 'purchase',
        entity_id: purchase.id,
        operation: 'reverse',
        entity_version: 2,
        payload: {
          purchase_id: purchase.id,
          reason: 'edit',
          reversal_journal_id: 'je_purchase_reverse',
          renamed_bill_number: 'BILL-001-REV-ABC123',
        },
      }),
      { db, businessId: BID, diagnostics },
    );

    expect(await db.sales_returns.get(salesReturn.id)).toMatchObject({
      status: 'cancelled',
      return_number: salesReturn.return_number,
      total_paise: salesReturn.total_paise,
    });
    expect(await db.sales_return_items.get(salesReturnItem.id)).toEqual(salesReturnItem);
    expect(await db.purchases.get(purchase.id)).toMatchObject({
      status: 'cancelled',
      bill_number: 'BILL-001-REV-ABC123',
      total_paise: purchase.total_paise,
    });
    expect(diagnostics).toEqual([]);
  });

  it('preserves the deletion reversal journal pointer during replay', async () => {
    const { applyEvent } = await import('./eventHandlers');
    await db.invoices.add(inv1 as Invoice);
    await applyEvent(
      {
        event_id: 'evt_delete_pointer',
        business_id: BID,
        device_id: 'dev_1',
        entity_type: 'invoice',
        entity_id: inv1.id,
        operation: 'delete',
        entity_version: 2,
        timestamp: NOW,
        payload: {
          invoice_id: inv1.id,
          deleted_at: NOW,
          reason: 'mistake',
          deletion_reversal_journal_id: 'je_delete_reverse',
        },
        payload_hash: 'x',
        previous_hash: null,
        sync_status: 'SYNCED',
      },
      { db, businessId: BID, diagnostics: [] },
    );

    expect(await db.invoices.get(inv1.id)).toMatchObject({
      deleted_at: NOW,
      deletion_reversal_journal_id: 'je_delete_reverse',
    });
  });

  it('sets current_business_id in meta-DB after successful restore', async () => {
    // The app boots into the business whose id is stored under
    // `current_business_id` in the meta-DB. Without this, a successful restore
    // still drops the user into onboarding because `currentBusinessId()` throws.
    await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
    });

    const row = await metaDb().settings.get('current_business_id');
    expect(row).toBeDefined();
    expect(row!.value).toBe(BID);
  });

  it('clears historical Drive linkage when restoring from a local folder', async () => {
    const files = await makeSnapshotFiles({
      ...business,
      drive_folder_id: 'old-drive-folder',
      drive_connected_email: 'old@example.com',
    });
    await provider.connect({ kind: 'local-folder', rootPath: root });
    await provider.initializeBusiness({
      businessId: BID,
      businessName: 'Acme Traders',
    });
    await provider.writeSnapshot({
      businessId: BID,
      kind: 'daily',
      asOf: '2026-08-19',
      files,
      manifest: {
        schemaVersion: 1,
        counts: files.reduce(
          (acc, f) => ({ ...acc, [f.name]: f.rowCount }),
          {} as Record<string, number>,
        ),
      },
    });
    await rebuildFromDrive(provider, {
      db,
      providerConfig: { kind: 'local-folder', rootPath: root },
      confirmDataLoss: true,
      preConnectedProvider: provider,
    });

    await expect(db.businesses.get(BID)).resolves.toMatchObject({
      drive_folder_id: null,
      drive_connected_email: null,
    });
  });

  it('refuses to wipe local data when the backup folder has no snapshots and no events', async () => {
    // Producer set up: create a business folder but write NEITHER a snapshot
    // NOR any journal events. This is the "onboarded to Drive but never
    // successfully flushed" state that bhawna's testing session hit.
    const emptyRoot = await mktmp();
    const emptyProducer = new LocalFolderStorageProvider();
    await emptyProducer.connect({ kind: 'local-folder', rootPath: emptyRoot });
    await emptyProducer.initializeBusiness({
      businessId: 'biz_empty',
      businessName: 'Empty Business',
    });
    // No writeSnapshot, no writeJournalEvents.

    // Seed the target DB with pre-existing user data so we can verify it
    // survives — this is the whole point of the guard.
    await db.customers.add({
      id: 'cust_precious',
      business_id: 'biz_empty',
      name: 'Do Not Wipe Me',
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
      created_at: NOW,
      updated_at: NOW,
      entity_version: 1,
    });

    const restoreProvider = new LocalFolderStorageProvider();
    let thrown: unknown = null;
    try {
      await rebuildFromDrive(restoreProvider, {
        db,
        providerConfig: { kind: 'local-folder', rootPath: emptyRoot },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EmptyBackupError);
    const err = thrown as EmptyBackupError;
    expect(err.businessId).toBe('biz_empty');
    expect(err.businessName).toBe('Empty Business');

    // The critical assertion: local data was NOT wiped.
    expect(await db.customers.get('cust_precious')).toBeDefined();
    expect(await db.customers.count()).toBe(1);

    await fs.rm(emptyRoot, { recursive: true, force: true });
  });

  it('refuses a journal-only restore when the manifest declares a missing snapshot', async () => {
    const manifestPath = path.join(
      root,
      'BusinessVault - Acme Traders/metadata/manifest.json',
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.currentSnapshot = {
      kind: 'daily',
      asOf: '2026-08-19',
      path: 'snapshots/daily/2026-08-19',
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.rm(
      path.join(root, 'BusinessVault - Acme Traders/snapshots/daily/2026-08-19'),
      { recursive: true, force: true },
    );

    await expect(
      rebuildFromDrive(provider, {
        db,
        providerConfig: { kind: 'local-folder', rootPath: root },
      }),
    ).rejects.toBeInstanceOf(BackupIntegrityError);
    expect(await db.customers.count()).toBe(0);
  });

  it('aborts with "Backup integrity verification failed" on checksum mismatch', async () => {
    // Corrupt one CSV in the snapshot.
    const csvPath = path.join(
      root,
      'BusinessVault - Acme Traders/snapshots/daily/2026-08-19/customers.csv',
    );
    const original = await fs.readFile(csvPath, 'utf8');
    await fs.writeFile(csvPath, original + '\nid,business_id\ntamper,tamper\n');

    await expect(
      rebuildFromDrive(provider, {
        db,
        providerConfig: { kind: 'local-folder', rootPath: root },
      }),
    ).rejects.toThrow(/Backup integrity verification failed/);

    // DB stays empty — nothing partially imported.
    expect(await db.customers.count()).toBe(0);
    expect(await db.invoices.count()).toBe(0);
  });
});
