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
  EmptyBackupError,
  UnshippedEventsError,
} from './rebuildFromDrive';
import { metaDb, __resetMetaDbForTests } from '../lib/device';
import { writeCsv } from '../csv/csvCodec';
import { TABLE_SPECS } from './tableSchema';

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

async function makeSnapshotFiles() {
  const byStore: Record<string, Record<string, unknown>[]> = {
    businesses: [business],
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
    payments: [],
    expenses: [],
    stock_movements: [mvOpening, mvSale],
    accounts,
    journal_entries: [je1],
    journal_lines: je1_lines,
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
    payload: payment1,
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

    // Validation flags.
    expect(report.checksumsOk).toBe(true);
    expect(report.accountingBalanced).toBe(true);
    expect(report.inventoryConsistent).toBe(true);
    expect(report.gstReconciled).toBe(true);
    expect(report.diagnostics.ok).toBe(true);

    // Derived rebuild: invoice paid/balance recomputed from payment replay.
    const inv = await db.invoices.get('inv_1');
    expect(inv).toBeDefined();
    expect(inv!.paid_paise).toBe(10000);
    expect(inv!.balance_paise).toBe(13600);
    expect(inv!.status).toBe('partial');
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

  it('aborts with "Backup integrity verification failed" on checksum mismatch', async () => {
    // Corrupt one CSV in the snapshot.
    const csvPath = path.join(
      root,
      'BusinessVault/Acme Traders/snapshots/daily/2026-08-19/customers.csv',
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
