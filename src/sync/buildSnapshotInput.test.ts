import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { ulid } from 'ulid';

import { BusinessVaultDB } from '../db/database';
import { LocalFolderStorageProvider } from '../storage/LocalFolderStorageProvider';
import { buildSnapshotInput, BACKUP_FORMAT_VERSION } from './buildSnapshotInput';
import type {
  Business,
  Customer,
  SalesReturn,
  SalesReturnItem,
  Attachment,
  AuditLogEntry,
} from '../db/types';

(globalThis as unknown as { Blob: typeof NodeBlob }).Blob = NodeBlob;
process.env.NODE_ENV = 'test';

const BID = 'biz_bsi';
const BNAME = 'BSI Traders';

describe('buildSnapshotInput', () => {
  let dbName: string;
  let db: BusinessVaultDB;
  let root: string;

  beforeEach(async () => {
    dbName = `bv_bsi_${ulid()}`;
    db = new BusinessVaultDB(dbName);
    await db.open();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-bsi-'));

    const now = new Date().toISOString();
    const business: Business = {
      id: BID,
      name: BNAME,
      legal_name: 'BSI Traders Pvt Ltd',
      gstin: '29AAECR1234H1Z5',
      pan: 'AAECR1234H',
      address_line1: '',
      address_line2: '',
      city: '',
      state: '',
      state_code: '29',
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
    const customer: Customer = {
      id: ulid(),
      business_id: BID,
      name: 'Acme Corp',
      phone: '',
      email: '',
      gstin: null,
      billing_address: '',
      shipping_address: '',
      state: '',
      state_code: '29',
      opening_balance_paise: 0,
      credit_limit_paise: 0,
      notes: '',
      active: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    await db.businesses.add(business);
    await db.customers.add(customer);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('produces a WriteSnapshotInput that writeSnapshot accepts (sha256s match)', async () => {
    const input = await buildSnapshotInput(db, BID, BNAME, 'ondemand', '2026-08-21');

    expect(input.businessId).toBe(BID);
    expect(input.kind).toBe('ondemand');
    expect(input.asOf).toBe('2026-08-21');
    expect(input.files.length).toBeGreaterThan(0);

    const customersFile = input.files.find((f) => f.name === 'customers.csv');
    expect(customersFile).toBeDefined();
    expect(customersFile!.rowCount).toBe(1);

    const businessesFile = input.files.find((f) => f.name === 'businesses.csv');
    expect(businessesFile!.rowCount).toBe(1);

    const provider = new LocalFolderStorageProvider();
    await provider.connect({ kind: 'local-folder', rootPath: root });
    await provider.initializeBusiness({ businessId: BID, businessName: BNAME });
    const handle = await provider.writeSnapshot(input);
    expect(handle.businessId).toBe(BID);
    expect(handle.kind).toBe('ondemand');
    expect(handle.asOf).toBe('2026-08-21');
  });

  it('§20 manifest carries applicationVersion, schemaVersion, backupFormatVersion', async () => {
    const input = await buildSnapshotInput(db, BID, BNAME, 'ondemand', '2026-08-26');
    expect(input.manifest.schemaVersion).toBeTypeOf('number');
    expect((input.manifest.schemaVersion as number) > 0).toBe(true);
    expect(input.manifest.backupFormatVersion).toBe(BACKUP_FORMAT_VERSION);
    // In test/Node runners __APP_VERSION__ isn't defined, so we get '0.0.0'
    // via the fallback — but the field MUST be present regardless.
    expect(input.manifest.applicationVersion).toBeTypeOf('string');
  });

  it('§20 emits CSVs for the new sales_returns / attachments / audit_log tables', async () => {
    // Seed one row in each new table so we can verify the writer picks them up.
    const now = new Date().toISOString();
    const sr: SalesReturn = {
      id: ulid(),
      business_id: BID,
      return_number: 'SR-000001',
      return_date: '2026-08-26',
      original_invoice_id: 'inv1',
      customer_id: 'cust1',
      subtotal_paise: 10000,
      discount_paise: 0,
      taxable_paise: 10000,
      cgst_paise: 900,
      sgst_paise: 900,
      igst_paise: 0,
      cess_paise: 0,
      round_off_paise: 0,
      round_off_mode: 'auto',
      pre_round_total_paise: 11800,
      total_paise: 11800,
      apply_to_balance_paise: 11800,
      customer_credit_paise: 0,
      status: 'posted',
      reason: 'defective',
      notes: '',
      journal_entry_id: 'je1',
      reversed_credit_note_invoice_id: null,
      legacy_migration_classification: null,
      device_id: 'dev1',
      deleted_at: null,
      deleted_reason: null,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    const sri: SalesReturnItem = {
      id: ulid(),
      business_id: BID,
      sales_return_id: sr.id,
      original_invoice_id: 'inv1',
      original_invoice_line_id: 'line1',
      item_id: 'item1',
      description: 'Widget',
      hsn: '8471',
      warehouse_id: 'wh1',
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
    const att: Attachment = {
      id: ulid(),
      business_id: BID,
      ref_type: 'signature',
      ref_id: BID,
      filename: 'sig.png',
      mime_type: 'image/png',
      size_bytes: 1024,
      checksum: 'abc',
      blob: null,
      drive_file_id: 'gd-file-123',
      logical_path: 'attachments/signature/x.png',
      created_at: now,
      updated_at: now,
    };
    const audit: AuditLogEntry = {
      id: ulid(),
      business_id: BID,
      device_id: 'dev1',
      actor: 'user',
      action: 'invoice.number_changed',
      entity_type: 'invoice',
      entity_id: 'inv1',
      before: { invoice_number: 'INV-1' },
      after: { invoice_number: 'INV-2' },
      at: now,
    };
    await db.sales_returns.add(sr);
    await db.sales_return_items.add(sri);
    await db.attachments.add(att);
    await db.audit_log.add(audit);

    const input = await buildSnapshotInput(db, BID, BNAME, 'ondemand', '2026-08-26');
    const files = new Map(input.files.map((f) => [f.name, f]));
    expect(files.get('sales_returns.csv')?.rowCount).toBe(1);
    expect(files.get('sales_return_items.csv')?.rowCount).toBe(1);
    expect(files.get('attachments.csv')?.rowCount).toBe(1);
    expect(files.get('audit_log.csv')?.rowCount).toBe(1);
    // audit_log's before/after are stringified via the audit_log special-
    // case in buildSnapshotInput — the raw CSV must contain the JSON, not
    // "[object Object]".
    const auditBlob = files.get('audit_log.csv')!.content as unknown as Blob;
    const auditText = await auditBlob.text();
    expect(auditText).toContain('invoice_number');
    expect(auditText).not.toContain('[object Object]');
  });
});
