import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../db/database';
import type { Account, Business, Customer, Item, ItemStock, Warehouse } from '../db/types';
import {
  BusinessProfileService,
  SignatureValidationError,
} from './BusinessProfileService';
import { InvoiceService } from './InvoiceService';

let db: BusinessVaultDB;
let profileSvc: BusinessProfileService;
let invoiceSvc: InvoiceService;

const businessId = '01BUSINESSPROF';
const deviceId = '01DEVICEPROF';
const customerId = '01CUSTPROF';
const warehouseId = '01WHPROF';
const itemId = '01ITEMPROF';

// jsdom does not implement createImageBitmap. Every uploadSignature() call
// needs it — override with a stub that returns dimensions from a size marker
// in the blob header (see makeImageBlob below). Tests can override
// dimensions per-call by adjusting the marker.
type DimTuple = { width: number; height: number };
const DEFAULT_DIMS: DimTuple = { width: 400, height: 200 };
let nextDims: DimTuple = { ...DEFAULT_DIMS };

async function makeImageBlob(
  mime: string,
  sizeBytes: number,
  dims: DimTuple = { ...DEFAULT_DIMS },
): Promise<File> {
  nextDims = dims;
  const bytes = new Uint8Array(sizeBytes);
  bytes.fill(0x89);
  return new File([bytes], `signature.${mime.split('/')[1]}`, { type: mime });
}

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
    name: 'Shop',
    legal_name: 'Shop Pvt Ltd',
    gstin: '29AABCS1234A1Z5',
    pan: 'AABCS1234A',
    address_line1: 'x',
    address_line2: '',
    city: 'BLR',
    state: 'Karnataka',
    state_code: '29',
    pincode: '560001',
    country: 'IN',
    phone: '999',
    email: '',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 8,
    signature_ref: null,
    show_signature_on_invoice: 0,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.businesses.add(business);

  const customer: Customer = {
    id: customerId,
    business_id: businessId,
    name: 'Ravi',
    phone: '900',
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
    sku: 'SKU',
    name: 'W',
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

  for (const a of [
    accRow('1200', 'AR', 'asset'),
    accRow('1400', 'Inventory', 'asset'),
    accRow('4000', 'Sales', 'income'),
    accRow('2210', 'CGST', 'liability'),
    accRow('2220', 'SGST', 'liability'),
    accRow('2230', 'IGST', 'liability'),
    accRow('2240', 'Cess', 'liability'),
    accRow('4900', 'Round Off', 'income'),
    accRow('5020', 'COGS', 'expense'),
  ])
    await db.accounts.add(a);
}

beforeEach(async () => {
  db = new BusinessVaultDB('bv-profile-' + Math.random().toString(36).slice(2));
  await db.open();
  await seed();
  profileSvc = new BusinessProfileService(db);
  invoiceSvc = new InvoiceService(db);

  // Stub createImageBitmap. Route through nextDims so each test can dictate
  // returned dimensions via makeImageBlob(). close() is called by the service
  // — provide a no-op to match the ImageBitmap shape enough.
  (globalThis as unknown as {
    createImageBitmap: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
  }).createImageBitmap = async () => ({
    width: nextDims.width,
    height: nextDims.height,
    close: () => {},
  });
});

afterEach(() => {
  nextDims = { ...DEFAULT_DIMS };
});

describe('BusinessProfileService.uploadSignature', () => {
  it('writes an attachment and sets signature_ref + toggle on first upload', async () => {
    const file = await makeImageBlob('image/png', 1024);
    const { attachment, business } = await profileSvc.uploadSignature(businessId, file);

    expect(attachment.ref_type).toBe('signature');
    expect(attachment.ref_id).toBe(businessId);
    expect(attachment.business_id).toBe(businessId);
    expect(attachment.mime_type).toBe('image/png');
    expect(attachment.blob).toBeInstanceOf(Blob);
    expect(attachment.checksum.length).toBe(64); // sha-256 hex

    expect(business.signature_ref).toBe(attachment.id);
    expect(business.show_signature_on_invoice).toBe(1);

    const stored = await db.businesses.get(businessId);
    expect(stored?.signature_ref).toBe(attachment.id);

    const atts = await db.attachments
      .where('[business_id+ref_type+ref_id]')
      .equals([businessId, 'signature', businessId])
      .toArray();
    expect(atts).toHaveLength(1);
  });

  it('creates a fresh attachment on replace and keeps the old row intact', async () => {
    const v1 = await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/png', 512),
    );
    const v2 = await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/jpeg', 700),
    );

    expect(v2.attachment.id).not.toBe(v1.attachment.id);
    // Both signature rows survive so historical invoices can resolve v1.
    const atts = await db.attachments
      .where('[business_id+ref_type+ref_id]')
      .equals([businessId, 'signature', businessId])
      .toArray();
    expect(atts.map((a) => a.id).sort()).toEqual(
      [v1.attachment.id, v2.attachment.id].sort(),
    );
    const biz = await db.businesses.get(businessId);
    expect(biz?.signature_ref).toBe(v2.attachment.id);
  });

  it('rejects unsupported mime types', async () => {
    await expect(
      profileSvc.uploadSignature(
        businessId,
        await makeImageBlob('image/gif', 1024),
      ),
    ).rejects.toBeInstanceOf(SignatureValidationError);
    const biz = await db.businesses.get(businessId);
    expect(biz?.signature_ref).toBeNull();
  });

  it('rejects blobs larger than 2 MB', async () => {
    await expect(
      profileSvc.uploadSignature(
        businessId,
        await makeImageBlob('image/png', 3 * 1024 * 1024),
      ),
    ).rejects.toBeInstanceOf(SignatureValidationError);
    expect(await db.attachments.count()).toBe(0);
  });

  it('rejects images whose dimensions exceed 2000 px', async () => {
    await expect(
      profileSvc.uploadSignature(
        businessId,
        await makeImageBlob('image/png', 1024, { width: 3000, height: 500 }),
      ),
    ).rejects.toBeInstanceOf(SignatureValidationError);
    expect(await db.attachments.count()).toBe(0);
  });
});

describe('BusinessProfileService signature snapshot on invoices', () => {
  it('pins the current signature onto a new invoice at creation time', async () => {
    const { attachment } = await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/png', 1024),
    );

    const inv = await invoiceSvc.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [
        {
          item_id: itemId,
          description: 'W',
          hsn: '8471',
          warehouse_id: warehouseId,
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
        },
      ],
    });

    expect(inv.signature_attachment_id).toBe(attachment.id);
  });

  it('does NOT change the pinned signature on an existing invoice after replace', async () => {
    const v1 = await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/png', 512),
    );
    const inv1 = await invoiceSvc.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [
        {
          item_id: itemId,
          description: 'W',
          hsn: '8471',
          warehouse_id: warehouseId,
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
        },
      ],
    });
    expect(inv1.signature_attachment_id).toBe(v1.attachment.id);

    const v2 = await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/png', 800),
    );

    const inv2 = await invoiceSvc.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000002',
      invoice_date: '2026-08-20',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [
        {
          item_id: itemId,
          description: 'W',
          hsn: '8471',
          warehouse_id: warehouseId,
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
        },
      ],
    });

    // Invoice 2 pins the new signature.
    expect(inv2.signature_attachment_id).toBe(v2.attachment.id);
    // Invoice 1 unchanged — still points at v1.
    const reloaded1 = await db.invoices.get(inv1.id);
    expect(reloaded1?.signature_attachment_id).toBe(v1.attachment.id);
  });

  it('pins null when the toggle is off, even if signature_ref is set', async () => {
    await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/png', 512),
    );
    await profileSvc.setShowSignatureOnInvoice(businessId, false);

    const inv = await invoiceSvc.createInvoice({
      business_id: businessId,
      device_id: deviceId,
      invoice_number: 'INV-000001',
      invoice_date: '2026-08-19',
      customer_id: customerId,
      customer_state_code: '29',
      place_of_supply: '29',
      is_interstate: false,
      financial_year: '2026-27',
      lines: [
        {
          item_id: itemId,
          description: 'W',
          hsn: '8471',
          warehouse_id: warehouseId,
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
        },
      ],
    });
    expect(inv.signature_attachment_id).toBeNull();
  });
});

describe('BusinessProfileService.removeSignature', () => {
  it('clears signature_ref and toggle but leaves the attachment intact', async () => {
    const { attachment } = await profileSvc.uploadSignature(
      businessId,
      await makeImageBlob('image/png', 512),
    );

    const patched = await profileSvc.removeSignature(businessId);
    expect(patched.signature_ref).toBeNull();
    expect(patched.show_signature_on_invoice).toBe(0);

    const stillThere = await db.attachments.get(attachment.id);
    expect(stillThere).toBeDefined();
    // Note: fake-indexeddb roundtrips a Blob to a plain object that loses
    // its instanceof identity, so we assert on the persisted bytes/size instead.
    expect(stillThere?.size_bytes).toBe(attachment.size_bytes);
    expect(stillThere?.checksum).toBe(attachment.checksum);
  });
});
