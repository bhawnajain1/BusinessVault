/**
 * End-to-end sanity check: does creating an invoice actually land files in
 * the user's local backup folder? Uses the Node fallback of
 * LocalFolderStorageProvider (NODE_ENV=test) rooted at a real path on disk.
 *
 * NOT a hermetic unit test — it writes into a real directory owned by the
 * user. Runs only when RUN_LOCAL_FOLDER_E2E=1 in the env.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { db } from '../db';
import type { Account, Business, Customer, Item, ItemStock, Warehouse } from '../db/types';
import { InvoiceService } from '../domain/InvoiceService';
import { LocalFolderStorageProvider } from '../storage/LocalFolderStorageProvider';
import { startSyncWorker } from './syncWorker';

const ROOT = '/Users/bbacchhawat/Documents/Analysis/BussinessVault';

const RUN = process.env.RUN_LOCAL_FOLDER_E2E === '1';

async function seed(businessId: string): Promise<void> {
  const now = new Date().toISOString();
  const business: Business = {
    id: businessId,
    name: 'Tiger Marketing',
    legal_name: 'Tiger Marketing Pvt Ltd',
    gstin: '29AABCT1234A1Z5',
    pan: 'AABCT1234A',
    address_line1: '1 MG Road',
    address_line2: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    state_code: '29',
    pincode: '560001',
    country: 'IN',
    phone: '9999999999',
    email: 'owner@tiger.example',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 2,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.businesses.add(business);

  const cust: Customer = {
    id: '01CUSTE2E',
    business_id: businessId,
    name: 'E2E Customer',
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
  await db.customers.add(cust);

  const wh: Warehouse = {
    id: '01WHE2E',
    business_id: businessId,
    name: 'Main',
    address: '',
    is_default: 1,
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.warehouses.add(wh);

  const item: Item = {
    id: '01ITEME2E',
    business_id: businessId,
    sku: 'SKU-E2E',
    name: 'E2E Widget',
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
    item_id: item.id,
    warehouse_id: wh.id,
    qty_micros: 100_000_000,
    avg_cost_paise: 8000,
    updated_at: now,
  };
  await db.item_stock.add(stock);

  const accs: Array<[string, string, Account['type']]> = [
    ['1200', 'Accounts Receivable', 'asset'],
    ['1400', 'Inventory', 'asset'],
    ['4000', 'Sales Revenue', 'income'],
    ['2210', 'Output CGST', 'liability'],
    ['2220', 'Output SGST', 'liability'],
    ['2230', 'Output IGST', 'liability'],
    ['2240', 'Output Cess', 'liability'],
    ['4900', 'Round Off', 'income'],
    ['5020', 'Cost of Goods Sold', 'expense'],
  ];
  for (const [code, name, type] of accs) {
    await db.accounts.add({
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
    });
  }
}

describe.runIf(RUN)('E2E: local folder receives invoice writes', () => {
  it('creates invoice → journal file appears on disk', async () => {
    await db.open();
    const businessId = '01BUSE2E';
    await seed(businessId);

    // Connect the provider to the real folder
    const provider = new LocalFolderStorageProvider();
    await provider.connect({ kind: 'local-folder', rootPath: ROOT });
    await provider.initializeBusiness({
      businessId,
      businessName: 'Tiger Marketing',
    });

    // Start the worker; poll it via tick()
    const worker = startSyncWorker({
      businessId,
      provider,
      onStateChange: () => {},
      autoStart: false,
      isOnline: () => true,
      tickIntervalMs: 100,
    });

    // Create an invoice — this writes sync_events as LOCAL_ONLY
    const svc = new InvoiceService();
    const invoice = await svc.createInvoice({
      business_id: businessId,
      device_id: '01DEVE2E',
      invoice_number: `INV-E2E-${Date.now()}`,
      invoice_date: '2026-08-20',
      customer_id: '01CUSTE2E',
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [
        {
          item_id: '01ITEME2E',
          hsn: '8471',
          warehouse_id: '01WHE2E',
          qty_micros: 2_000_000,
          unit_price_paise: 10000,
          taxable_paise: 20000,
          tax_rate_bps: 1800,
          cgst_paise: 1800,
          sgst_paise: 1800,
          igst_paise: 0,
          line_total_paise: 23600,
        },
      ],
    });
    expect(invoice.total_paise).toBe(23600);

    // Confirm events written as LOCAL_ONLY
    const beforePromote = await db.sync_events
      .where('business_id')
      .equals(businessId)
      .toArray();
    expect(beforePromote.length).toBeGreaterThan(0);
    console.log(`[E2E] wrote ${beforePromote.length} sync_events`);

    // Tick the worker — should promote LOCAL_ONLY→QUEUED then flush→SYNCED
    await worker.tick();
    await worker.tick();
    await worker.tick();

    const afterSync = await db.sync_events
      .where('business_id')
      .equals(businessId)
      .toArray();
    const syncedCount = afterSync.filter((e) => e.sync_status === 'SYNCED').length;
    console.log(
      `[E2E] statuses:`,
      afterSync.reduce((acc, e) => {
        acc[e.sync_status] = (acc[e.sync_status] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    );

    // Verify files on disk
    const businessRoot = path.join(ROOT, 'BusinessVault', 'Tiger Marketing');
    const journalDir = path.join(businessRoot, 'journal');
    const journalYearDir = path.join(journalDir, '2026');
    let journalFiles: string[] = [];
    try {
      journalFiles = await fsp.readdir(journalYearDir);
    } catch {
      journalFiles = [];
    }
    console.log(`[E2E] journal files at ${journalYearDir}:`, journalFiles);

    let currentFiles: string[] = [];
    try {
      currentFiles = await fsp.readdir(path.join(businessRoot, 'current'));
    } catch {
      currentFiles = [];
    }
    console.log(`[E2E] current files:`, currentFiles);

    worker.stop();

    expect(syncedCount).toBeGreaterThan(0);
    expect(journalFiles.length).toBeGreaterThan(0);
  }, 30_000);
});
