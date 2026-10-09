import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusinessVaultDB } from '../db/database';
import type { Gstr2bDocument, Purchase, Supplier } from '../db/types';
import { applyEvent } from '../restore/eventHandlers';
import type { SyncEvent } from '../storage/CustomerStorageProvider';
import { Gstr2bReconciliationService, reconcileGstr2bDocuments, type PurchaseRegisterDocument } from './Gstr2bReconciliation';

const BUSINESS_ID = 'gst-match-business';
const SUPPLIER_GSTIN = '27AAAAA0000A1Z0';
const OTHER_GSTIN = '29BBBBB0000B1Z0';
let db: BusinessVaultDB;

function portal(overrides: Partial<Gstr2bDocument> = {}): Gstr2bDocument {
  return {
    id: 'portal-1',
    business_id: BUSINESS_ID,
    gstr2b_import_id: 'import-1',
    source_section: 'B2B',
    supplier_gstin: SUPPLIER_GSTIN,
    supplier_name: 'Supplier',
    document_type: 'INVOICE',
    canonical_document_number: ' INV/00042 ',
    search_normalized_document_number: 'INV00042',
    document_date: '2026-08-10',
    original_document_number: null,
    original_document_date: null,
    filing_period: '2026-08',
    place_of_supply_state_code: '27',
    reverse_charge: 0,
    taxable_paise: 10000,
    igst_paise: 0,
    cgst_paise: 900,
    sgst_paise: 900,
    cess_paise: 0,
    invoice_value_paise: 11800,
    itc_availability: 'AVAILABLE',
    itc_unavailable_reason: null,
    ims_status: null,
    declared_itc_reduction_paise: null,
    ims_remark: null,
    bill_of_entry_number: null,
    bill_of_entry_date: null,
    port_code: null,
    raw_payload_json: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    entity_version: 1,
    ...overrides,
  };
}

function book(overrides: Partial<Purchase> = {}, supplierGstin = SUPPLIER_GSTIN): PurchaseRegisterDocument {
  const purchase = {
    id: 'purchase-1',
    business_id: BUSINESS_ID,
    bill_number: 'BV-00042',
    supplier_bill_number: 'INV-00042',
    bill_date: '2026-08-10',
    due_date: null,
    supplier_id: 'supplier-1',
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
    journal_entry_id: 'journal-1',
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    entity_version: 1,
    ...overrides,
  } satisfies Purchase;
  const supplier: Supplier = {
    id: 'supplier-1',
    business_id: BUSINESS_ID,
    name: 'Supplier',
    phone: '',
    email: '',
    gstin: supplierGstin,
    address: '',
    state: 'Maharashtra',
    state_code: '27',
    opening_balance_paise: 0,
    notes: '',
    active: 1,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    entity_version: 1,
  };
  return { purchase, supplier };
}

describe('reconcileGstr2bDocuments', () => {
  it('normalizes only the matching key and reports an exact match with zero differences', () => {
    const result = reconcileGstr2bDocuments(BUSINESS_ID, [portal()], [book()]);
    expect(result).toEqual([expect.objectContaining({
      gstr2bDocumentId: 'portal-1',
      bookSourceId: 'purchase-1',
      status: 'EXACT_MATCH',
      confidenceBps: 10000,
      taxableDifferencePaise: 0,
      igstDifferencePaise: 0,
      cgstDifferencePaise: 0,
      sgstDifferencePaise: 0,
      cessDifferencePaise: 0,
    })]);
    expect(portal().canonical_document_number).toBe(' INV/00042 ');
  });

  it('distinguishes taxable-value and tax-head mismatches using signed integer paise differences', () => {
    const valueMismatch = reconcileGstr2bDocuments(
      BUSINESS_ID,
      [portal({ taxable_paise: 11000, cgst_paise: 990, sgst_paise: 990, invoice_value_paise: 12980 })],
      [book()],
    )[0];
    expect(valueMismatch.status).toBe('VALUE_MISMATCH');
    expect(valueMismatch.taxableDifferencePaise).toBe(1000);

    const taxHeadMismatch = reconcileGstr2bDocuments(
      BUSINESS_ID,
      [portal({ igst_paise: 1800, cgst_paise: 0, sgst_paise: 0 })],
      [book()],
    )[0];
    expect(taxHeadMismatch.status).toBe('TAX_HEAD_MISMATCH');
    expect(taxHeadMismatch.igstDifferencePaise).toBe(1800);
    expect(taxHeadMismatch.cgstDifferencePaise).toBe(-900);
  });

  it('applies paise tolerance only to classification while retaining exact signed differences', () => {
    const result = reconcileGstr2bDocuments(
      BUSINESS_ID,
      [portal({ taxable_paise: 10050, cgst_paise: 950, sgst_paise: 950, invoice_value_paise: 11900 })],
      [book()],
      { exactAmountTolerancePaise: 50 },
    )[0];
    expect(result.status).toBe('EXACT_MATCH');
    expect(result.taxableDifferencePaise).toBe(50);
    expect(result.cgstDifferencePaise).toBe(50);
  });

  it('proposes a probable near-number match without upgrading its confidence', () => {
    const result = reconcileGstr2bDocuments(
      BUSINESS_ID,
      [portal({ canonical_document_number: 'INV-00043' })],
      [book({ supplier_bill_number: 'INV-00042' })],
    )[0];
    expect(result).toMatchObject({ status: 'PROBABLE_MATCH', confidenceBps: 7500, bookSourceId: 'purchase-1' });
  });

  it('reports duplicates, unmatched documents, and GSTIN mismatches instead of auto-choosing', () => {
    const duplicatePortalRows = [portal(), portal({ id: 'portal-2' })];
    expect(reconcileGstr2bDocuments(BUSINESS_ID, duplicatePortalRows, [book()])
      .filter((row) => row.status === 'DUPLICATE_IN_GSTR2B')).toHaveLength(2);

    expect(reconcileGstr2bDocuments(BUSINESS_ID, [portal()], [book(), book({ id: 'purchase-2' })])[0].status)
      .toBe('DUPLICATE_IN_BOOKS');

    const gstinMismatch = reconcileGstr2bDocuments(BUSINESS_ID, [portal()], [book({}, OTHER_GSTIN)])[0];
    expect(gstinMismatch).toMatchObject({ status: 'GSTIN_MISMATCH', bookSourceId: 'purchase-1' });

    const unmatched = reconcileGstr2bDocuments(BUSINESS_ID, [portal({ supplier_gstin: null })], [book()]);
    expect(unmatched.map((row) => row.status).sort()).toEqual(['BOOKS_ONLY', 'GSTR2B_ONLY']);
  });

  it('does not match across years and identifies duplicate credit notes', () => {
    const oldInvoice = book({ id: 'old-invoice', bill_date: '2025-08-10' });
    const crossYear = reconcileGstr2bDocuments(BUSINESS_ID, [portal()], [oldInvoice]);
    expect(crossYear.map((row) => row.status).sort()).toEqual(['BOOKS_ONLY', 'GSTR2B_ONLY']);

    const creditNote = portal({
      id: 'credit-note',
      document_type: 'CREDIT_NOTE',
      canonical_document_number: 'INV-00042',
      original_document_number: 'INV-00042',
      original_document_date: '2026-08-10',
      taxable_paise: -10000,
      cgst_paise: -900,
      sgst_paise: -900,
      invoice_value_paise: -11800,
    });
    const matchingDebitNote = book({
      id: 'debit-note',
      supplier_bill_number: 'INV-00042',
      taxable_paise: -10000,
      cgst_paise: -900,
      sgst_paise: -900,
      total_paise: -11800,
      pre_round_total_paise: -11800,
      reverses_purchase_id: 'original-purchase',
    });
    const creditMismatch = reconcileGstr2bDocuments(BUSINESS_ID, [creditNote], [{
      ...matchingDebitNote,
      purchase: { ...matchingDebitNote.purchase, supplier_bill_number: 'INV-00042', reverses_purchase_id: 'purchase-1', id: 'debit-note' },
    }, { ...book(), purchase: { ...book().purchase, id: 'purchase-1' } }]);
    expect(creditMismatch).toHaveLength(1);
    expect(creditMismatch[0]).toMatchObject({ status: 'CREDIT_NOTE_MISMATCH', bookSourceId: 'debit-note' });
  });

  it('rejects cross-business rows, unsafe money and invalid matching tolerances', () => {
    expect(() => reconcileGstr2bDocuments(BUSINESS_ID, [portal({ business_id: 'other-business' })], [book()]))
      .toThrow('another business');
    expect(() => reconcileGstr2bDocuments(BUSINESS_ID, [portal({ taxable_paise: Number.MAX_SAFE_INTEGER + 1 })], [book()]))
      .toThrow('safe integer');
    expect(() => reconcileGstr2bDocuments(BUSINESS_ID, [portal()], [book()], { probableAmountTolerancePaise: 0.5 }))
      .toThrow('integer paise');
  });
});

describe('Gstr2bReconciliationService', () => {
  beforeEach(async () => {
    db = new BusinessVaultDB(`bv-gstr2b-reconcile-${Date.now()}-${Math.random()}`);
    await db.open();
    const now = '2026-08-12T00:00:00.000Z';
    await db.gstr2b_imports.add({
      id: 'import-1', business_id: BUSINESS_ID, gstin_snapshot: '27AAECA1234H1Z5',
      tax_period_key: '2026-08', source_type: 'GSTR2B_JSON', original_attachment_id: null,
      sha256: 'source-hash', imported_at: now, portal_generated_at: null, recomputed_at: null,
      schema_adapter_version: 'verified-fixture-adapter', parse_status: 'PARSED', parse_errors_json: null,
      supersedes_import_id: null, is_latest: 1, created_at: now, updated_at: now, entity_version: 1,
    });
    await db.gstr2b_documents.add(portal());
    await db.suppliers.add(book().supplier!);
    await db.purchases.add(book().purchase);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('persists period-scoped proposals atomically and replays replacement of a prior run', async () => {
    const service = new Gstr2bReconciliationService(db);
    const first = await service.reconcileImport({ businessId: BUSINESS_ID, deviceId: 'device-1', importId: 'import-1' });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'EXACT_MATCH', book_source_type: 'purchase', book_source_id: 'purchase-1' });
    const firstEvent = await db.sync_events.where('[business_id+entity_type+entity_id]')
      .equals([BUSINESS_ID, 'gst_match_run', 'import-1']).first();
    expect(firstEvent).toBeDefined();

    await db.gst_matches.add({ ...first[0], id: 'stale-match' });
    const second = await service.reconcileImport({ businessId: BUSINESS_ID, deviceId: 'device-1', importId: 'import-1' });
    expect(second).toHaveLength(1);
    expect(await db.gst_matches.where('gstr2b_import_id').equals('import-1').filter((row) => row.business_id === BUSINESS_ID).count()).toBe(1);
    expect(await db.gst_matches.get('stale-match')).toBeUndefined();
    expect((await db.audit_log.toArray()).filter((row) => row.action === 'gstr2b.reconciled')).toHaveLength(2);

    const replayDb = new BusinessVaultDB(`bv-gstr2b-reconcile-replay-${Date.now()}-${Math.random()}`);
    await replayDb.open();
    try {
      await replayDb.gstr2b_imports.add((await db.gstr2b_imports.get('import-1'))!);
      const event = {
        ...(firstEvent as unknown as SyncEvent),
        event_id: 'replay-match-run',
        entity_id: 'import-1',
        payload: {
          ...(firstEvent!.payload as Record<string, unknown>),
          replace_match_ids: [],
        },
      };
      await applyEvent(event, { db: replayDb, businessId: BUSINESS_ID, diagnostics: [] });
      expect(await replayDb.gst_matches.toArray()).toEqual(first);
      await applyEvent(event, { db: replayDb, businessId: BUSINESS_ID, diagnostics: [] });
      expect(await replayDb.gst_matches.count()).toBe(1);
      expect((await replayDb.audit_log.toArray()).filter((row) => row.action === 'gstr2b.reconciled')).toHaveLength(1);
    } finally {
      replayDb.close();
      await replayDb.delete();
    }
  });

  it('does not leave matches or audit rows after a failed journal write', async () => {
    const original = db.sync_events.add.bind(db.sync_events);
    db.sync_events.add = (async () => { throw new Error('journal write failed'); }) as unknown as typeof db.sync_events.add;
    await expect(new Gstr2bReconciliationService(db).reconcileImport({
      businessId: BUSINESS_ID, deviceId: 'device-1', importId: 'import-1',
    })).rejects.toThrow('journal write failed');
    db.sync_events.add = original;
    expect(await db.gst_matches.count()).toBe(0);
    expect((await db.audit_log.toArray()).filter((row) => row.action === 'gstr2b.reconciled')).toHaveLength(0);
  });

  it('rejects cross-business and superseded imports before writing', async () => {
    const service = new Gstr2bReconciliationService(db);
    await expect(service.reconcileImport({ businessId: 'other-business', deviceId: 'device-1', importId: 'import-1' }))
      .rejects.toThrow('not found for this business');
    await db.gstr2b_imports.update('import-1', { is_latest: 0 });
    await expect(service.reconcileImport({ businessId: BUSINESS_ID, deviceId: 'device-1', importId: 'import-1' }))
      .rejects.toThrow('latest import');
    expect(await db.gst_matches.count()).toBe(0);
  });
});
