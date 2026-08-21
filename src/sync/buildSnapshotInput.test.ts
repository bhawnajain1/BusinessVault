import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { ulid } from 'ulid';

import { BusinessVaultDB } from '../db/database';
import { LocalFolderStorageProvider } from '../storage/LocalFolderStorageProvider';
import { buildSnapshotInput } from './buildSnapshotInput';
import type { Business, Customer } from '../db/types';

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
});
