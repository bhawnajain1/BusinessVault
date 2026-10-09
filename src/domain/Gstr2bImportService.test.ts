import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { BusinessVaultDB } from '../db/database';
import { computeGstinCheckChar } from '../lib/gst';
import { Gstr2bImportService, type Gstr2bDocumentInput } from './Gstr2bImportService';
import type { Gstr2bAdapter, Gstr2bAdapterIssue } from './Gstr2bAdapters';

const BUSINESS_ID = 'gst-import-business';
const DEVICE_ID = 'gst-import-device';
const GSTIN_PREFIX = '27AAECA1234H1Z';
const GSTIN = GSTIN_PREFIX + computeGstinCheckChar(GSTIN_PREFIX);

let db: BusinessVaultDB;

function document(taxablePaise: number | null = 10000): Gstr2bDocumentInput {
  return {
    source_section: 'B2B',
    supplier_gstin: '29AABCS1234A1ZX',
    supplier_name: 'Supplier',
    document_type: 'INVOICE',
    canonical_document_number: 'INV/001',
    search_normalized_document_number: 'INV001',
    document_date: '2026-08-01',
    original_document_number: null,
    original_document_date: null,
    filing_period: '082026',
    place_of_supply_state_code: '27',
    reverse_charge: 0,
    taxable_paise: taxablePaise,
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
    raw_payload_json: '{"source":"fixture"}',
  };
}

function input(file: string, documents = [document()]) {
  return {
    businessId: BUSINESS_ID,
    deviceId: DEVICE_ID,
    gstin: GSTIN,
    taxPeriodKey: '2026-08',
    sourceType: 'GSTR2B_JSON' as const,
    fileName: 'gstr2b.json',
    file: new NodeBlob([file], { type: 'application/json' }),
    schemaAdapterVersion: 'unverified-fixture-interface-v1',
    documents,
  };
}

function importThroughFixtureAdapter(
  service: Gstr2bImportService,
  source: ReturnType<typeof input>,
  parseErrors: Gstr2bAdapterIssue[] = [],
) {
  return service.importFile({
    businessId: source.businessId,
    deviceId: source.deviceId,
    gstin: source.gstin,
    taxPeriodKey: source.taxPeriodKey,
    sourceType: source.sourceType,
    fileName: source.fileName,
    file: source.file,
  }, [{
    sourceType: source.sourceType,
    version: 'redacted-fixture-test-v1',
    detect: () => true,
    parse: async () => ({
      gstin: source.gstin,
      taxPeriodKey: source.taxPeriodKey,
      documents: source.documents,
      parseErrors,
    }),
  }]);
}

beforeEach(async () => {
  db = new BusinessVaultDB(`bv-gstr2b-import-${Date.now()}-${Math.random()}`);
  await db.open();
  await db.gst_profiles.add({
    id: 'gst-profile',
    business_id: BUSINESS_ID,
    gstin: GSTIN,
    legal_name: 'Acme Traders',
    state_code: '27',
    registration_type: 'REGULAR',
    registration_start_date: null,
    registration_end_date: null,
    filing_frequency: 'MONTHLY',
    gst_reporting_enabled: 1,
    effective_from: '2020-04-01',
    effective_to: null,
    active: 1,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    entity_version: 1,
  });
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('Gstr2bImportService', () => {
  it('atomically stores source bytes, normalized rows, audit data, one event, and an upload job', async () => {
    const result = await importThroughFixtureAdapter(
      new Gstr2bImportService(db),
      input('{"records":[]}'),
    );
    const attachment = await db.attachments.get(result.imported.original_attachment_id!);
    const event = await db.sync_events
      .where('[business_id+entity_type+entity_id]')
      .between([BUSINESS_ID, 'gstr2b_import', ''], [BUSINESS_ID, 'gstr2b_import', '\uffff'])
      .first();
    const uploadJob = await db.sync_queue.where('kind').equals('attachment_upload').first();

    expect(result.imported).toMatchObject({ parse_status: 'PARSED', is_latest: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(result.documents).toHaveLength(1);
    expect(attachment).toMatchObject({
      ref_type: 'gstr2b_import',
      ref_id: result.imported.id,
      logical_path: `attachments/gstr2b/${result.imported.id}-gstr2b.json`,
      checksum: result.imported.sha256,
    });
    expect(await (attachment!.blob as NodeBlob).text()).toBe('{"records":[]}');
    expect(event).toMatchObject({ operation: 'created', entity_id: result.imported.id });
    expect((event!.payload as { attachment: { blob: unknown } }).attachment.blob).toBeNull();
    expect((event!.payload as { documents: unknown[] }).documents).toHaveLength(1);
    expect(uploadJob).toMatchObject({ payload: { attachmentId: attachment!.id }, status: 'pending' });
    expect((await db.audit_log.toArray()).filter((row) => row.entity_id === result.imported.id)).toHaveLength(1);
  });

  it('rejects duplicate source hashes and unsafe paise values without partial writes', async () => {
    const service = new Gstr2bImportService(db);
    await importThroughFixtureAdapter(service, input('same bytes'));
    await expect(importThroughFixtureAdapter(service, input('same bytes'))).rejects.toThrow(/already imported/);
    await expect(importThroughFixtureAdapter(service, input('bad amount', [document(Number.MAX_SAFE_INTEGER + 1)])))
      .rejects.toThrow(/safe integer paise/);
    expect(await db.gstr2b_imports.count()).toBe(1);
    expect(await db.gstr2b_documents.count()).toBe(1);
    expect(await db.attachments.count()).toBe(1);
    expect(await db.sync_events
      .where('[business_id+entity_type+entity_id]')
      .between([BUSINESS_ID, 'gstr2b_import', ''], [BUSINESS_ID, 'gstr2b_import', '\uffff'])
      .count()).toBe(1);
  });

  it('keeps corrected parse failures as source evidence without promoting them to latest', async () => {
    const service = new Gstr2bImportService(db);
    const result = await importThroughFixtureAdapter(service, input('malformed', []), [
      { code: 'STRUCTURE_UNRECOGNIZED', message: 'Fixture structure is unrecognized.' },
    ]);

    expect(result.imported).toMatchObject({ parse_status: 'FAILED', is_latest: 0 });
    expect(await db.gstr2b_documents.count()).toBe(0);
    expect(await db.attachments.get(result.imported.original_attachment_id!)).toMatchObject({ blob: expect.any(NodeBlob) });
    expect((await db.audit_log.toArray()).filter((row) => row.action === 'gstr2b.import_parse_failed')).toHaveLength(1);
  });

  it('imports through the versioned adapter and keeps GSTIN or period mismatches as failed evidence', async () => {
    const service = new Gstr2bImportService(db);
    const source = input('adapter-backed-source');
    const adapter: Gstr2bAdapter = {
      sourceType: 'GSTR2B_JSON',
      version: 'official-fixture-interface-v1',
      detect: () => true,
      parse: async () => ({
        gstin: GSTIN,
        taxPeriodKey: '2026-08',
        documents: [document()],
        parseErrors: [],
      }),
    };
    const { businessId, deviceId, gstin, taxPeriodKey, sourceType, fileName, file } = source;
    const imported = await service.importFile(
      { businessId, deviceId, gstin, taxPeriodKey, sourceType, fileName, file },
      [adapter],
    );
    expect(imported.imported).toMatchObject({
      schema_adapter_version: 'official-fixture-interface-v1',
      parse_status: 'PARSED',
    });
    expect(imported.documents).toHaveLength(1);

    const mismatch = input('period-mismatch-source');
    const mismatched = await service.importFile(
      {
        businessId: mismatch.businessId,
        deviceId: mismatch.deviceId,
        gstin: mismatch.gstin,
        taxPeriodKey: mismatch.taxPeriodKey,
        sourceType: mismatch.sourceType,
        fileName: mismatch.fileName,
        file: mismatch.file,
      },
      [{
        ...adapter,
        version: 'official-fixture-interface-v1',
        parse: async () => ({
          gstin: GSTIN,
          taxPeriodKey: '2026-07',
          documents: [document()],
          parseErrors: [],
        }),
      }],
    );
    expect(mismatched.imported).toMatchObject({ parse_status: 'FAILED', is_latest: 0 });
    expect(mismatched.imported.parse_errors_json).toContain('PERIOD_MISMATCH');
    expect(mismatched.documents).toHaveLength(0);
    expect(await db.gstr2b_documents.count()).toBe(1);
  });
});
