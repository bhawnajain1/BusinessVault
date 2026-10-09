import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import ExcelJS from 'exceljs';
import { BusinessVaultDB } from '../../db/database';
import type { Attachment, Business, GstDocumentMetadata, GstItcLedgerEntry, GstReportRun, Purchase, Supplier } from '../../db/types';
import { GstMonthlyReportService } from './GstMonthlyReportService';
import { applyEvent } from '../../restore/eventHandlers';
import type { SyncEvent } from '../../storage/CustomerStorageProvider';
import { TABLE_SPECS, coerceRow } from '../../restore/tableSchema';
import { buildSnapshotInput } from '../../sync/buildSnapshotInput';
import { LocalFolderStorageProvider } from '../../storage/LocalFolderStorageProvider';
import { rebuildFromDrive } from '../../restore/rebuildFromDrive';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Dexie from 'dexie';
import { STORES_V14 } from '../../db/schema';
import { migrateSnapshot } from '../../db/migrations/index';
import { canonicalJson } from '../../journal/event';
import { buildMonthlyGstWorkbook, GST_WORKBOOK_SHEETS } from './exports';
import type { MonthlyGstCalculation } from './types';

globalThis.Blob = NodeBlob as unknown as typeof Blob;
const now = '2026-08-20T10:00:00.000Z';
const gstin = '27AAPFU0939F1ZV';
const audit = { created_at: now, updated_at: now, entity_version: 1 };
const business: Business = {
  id: 'gst-business', name: 'Synthetic GST Business', legal_name: 'Synthetic GST Business', gstin, pan: null,
  address_line1: '', address_line2: '', city: '', state: 'Maharashtra', state_code: '27', pincode: '', country: 'IN',
  phone: '', email: '', financial_year_start_month: 4, current_financial_year: '2026-27', currency: 'INR', logo_ref: null,
  invoice_prefix: 'INV', invoice_next_seq: 1, drive_folder_id: null, drive_connected_email: null, schema_version: 15,
  ...audit,
};
let db: BusinessVaultDB;
let service: GstMonthlyReportService;
beforeEach(async () => {
  db = new BusinessVaultDB(`gst-report-test-${Math.random()}`);
  await db.businesses.add(business);
  service = new GstMonthlyReportService(db, 'test-device', () => now);
});
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); });

async function setupProfile() {
  await service.saveProfile({ business_id: business.id, gstin, legal_name: business.legal_name, state_code: '27',
    registration_type: 'REGULAR', registration_start_date: null, registration_end_date: null, filing_frequency: 'MONTHLY',
    gst_reporting_enabled: 1, effective_from: '2026-04-01', effective_to: null, active: 1 });
  await service.setAato({ business_id: business.id, financial_year: '2025-26', aato_paise: 10_000_000, source: 'USER_CONFIRMED', confirmed_at: now, notes: '' });
}

async function seedPurchase() {
  await db.suppliers.add({ id: 'supplier', business_id: business.id, name: 'Synthetic Supplier', phone: '', email: '', gstin,
    address: '', state: 'Maharashtra', state_code: '27', opening_balance_paise: 0, notes: '', active: 1, ...audit } satisfies Supplier);
  await db.purchases.add({ id: 'purchase', business_id: business.id, bill_number: 'B-0001', supplier_bill_number: 'S-0001',
    bill_date: '2026-08-01', due_date: null, supplier_id: 'supplier', supplier_state_code: '27', is_interstate: 0,
    financial_year: '2026-27', subtotal_paise: 1000, discount_paise: 0, taxable_paise: 1000, cgst_paise: 90,
    sgst_paise: 90, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 1180,
    total_paise: 1180, paid_paise: 0, balance_paise: 1180, status: 'received', reversed_by_purchase_id: null,
    reverses_purchase_id: null, notes: '', attachment_id: null, journal_entry_id: '', ...audit } satisfies Purchase);
  await db.purchase_lines.add({ id: 'purchase-line', business_id: business.id, purchase_id: 'purchase', line_no: 1,
    item_id: 'item', description: 'Historical product', hsn: '12345678', warehouse_id: '', qty_micros: 1_000_000,
    unit_cost_paise: 1000, discount_paise: 0, taxable_paise: 1000, tax_rate_bps: 1800, cgst_paise: 90, sgst_paise: 90,
    igst_paise: 0, cess_paise: 0, line_total_paise: 1180, uqc_code: 'NOS', goods_or_service: 'GOODS',
    taxability: 'TAXABLE', cess_rate_bps: 0, snapshot_source: 'NATIVE' });
}

function itc<S extends GstItcLedgerEntry['status']>(status: S, period: string, head: GstItcLedgerEntry['tax_head'] = 'CGST') {
  return { business_id: business.id, source_entity_type: 'PURCHASE' as const, source_entity_id: 'purchase', tax_period_key: period,
    category: 'OTHER_ITC' as const, tax_head: head, books_tax_paise: 90, original_eligible_paise: 90,
    temporarily_reversed_paise: status === 'TEMPORARILY_REVERSED' ? 90 : 0, permanently_reversed_paise: 0,
    reclaimable_paise: 90, reclaimed_paise: status === 'RECLAIMED' ? 60 : 0, status, reason_code: 'CA_REVIEW',
    reason: 'Synthetic review', related_prior_entry_id: null, user_confirmation: 1 as const };
}

async function workbookRows(calculation: MonthlyGstCalculation) {
  const built = await buildMonthlyGstWorkbook([calculation]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(built.xlsxBuffer);
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(GST_WORKBOOK_SHEETS);
  return Object.fromEntries(workbook.worksheets.map(sheet => {
    const headers = sheet.getRow(1).values as ExcelJS.CellValue[];
    const rows: Record<string, ExcelJS.CellValue>[] = [];
    for (let index = 2; index <= sheet.rowCount; index++) {
      const row: Record<string, ExcelJS.CellValue> = {};
      sheet.getRow(index).eachCell({ includeEmpty: true }, (cell, column) => { row[String(headers[column])] = cell.value; });
      rows.push(row);
    }
    return [sheet.name, rows];
  }));
}

describe('GST monthly persistence', () => {
  it('binds nil confirmation to current source hash, emits one event and replays idempotently', async () => {
    await setupProfile();
    const [nil] = await service.calculateMonths(business.id, ['2026-08']);
    const before = await db.sync_events.count();
    const confirmation = await service.confirmNilPeriod(business.id, '2026-08', nil.sourceDataHash);
    expect(await db.sync_events.count()).toBe(before + 1);
    expect((await service.calculateMonths(business.id, ['2026-08']))[0].status).toBe('READY_FOR_CA_REVIEW');
    const event = (await db.sync_events.toArray()).find(row => row.entity_type === 'gst_nil_confirmation')!;
    const target = new BusinessVaultDB(`nil-replay-${Math.random()}`);
    try {
      await target.businesses.add(business);
      await target.transaction('rw', target.tables, async () => {
        await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
        await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
      });
      expect(await target.gst_nil_confirmations.get(confirmation.id)).toEqual(confirmation);
      const snapshot = await buildSnapshotInput(db, business.id, business.name, 'daily', '2026-08-20');
      expect(await snapshot.files.find(file => file.name === 'gst_nil_confirmations.csv')!.content.text()).toContain(confirmation.source_data_hash);
    } finally { await target.delete(); }
    await db.businesses.update(business.id, { name: 'Changed source' });
    expect((await service.calculateMonths(business.id, ['2026-08']))[0].status).toBe('DRAFT');
    await expect(service.confirmNilPeriod(business.id, '2026-08', nil.sourceDataHash)).rejects.toThrow('unchanged');
  });
  it('atomically saves a supporting file with adjustment, one event and upload job', async () => {
    await setupProfile();
    const before = await db.sync_events.count();
    const input = { business_id: business.id, report_run_id: null, tax_period_key: '2026-08', report_type: 'GSTR3B_DRAFT' as const,
      table_code: '3.1(a)', tax_head: 'CGST' as const, measure: 'taxable_paise' as const, original_paise: null, adjusted_paise: null,
      adjustment_paise: 100, reason: 'CA confirmed taxable difference', supporting_attachment_id: null, source: 'USER' as const,
      actor_id: null, device_id: 'test-device', supportingFile: { filename: 'support.txt', mimeType: 'text/plain', blob: new Blob(['evidence']) } };
    const adjustment = await service.addAdjustment(input);
    expect(await db.sync_events.count()).toBe(before + 1);
    expect(await db.sync_queue.count()).toBe(1);
    expect((await db.attachments.get(adjustment.supporting_attachment_id!))?.ref_id).toBe(adjustment.id);
    const event = (await db.sync_events.toArray()).find(row => row.entity_type === 'gst_adjustment')!;
    const target = new BusinessVaultDB(`attachment-replay-${Math.random()}`);
    try {
      await target.businesses.add(business);
      await target.transaction('rw', target.tables, async () => {
        await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
        await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
      });
      expect(await target.gst_adjustments.get(adjustment.id)).toEqual(adjustment);
      expect((await target.attachments.get(adjustment.supporting_attachment_id!))?.checksum).toHaveLength(64);
    } finally { await target.delete(); }
    await expect(service.addAdjustment({ ...input, supportingFile: { ...input.supportingFile, filename: '' } })).rejects.toThrow('Supporting file');
    expect(await db.gst_adjustments.count()).toBe(1);
    expect(await db.attachments.count()).toBe(1);
    expect(await db.sync_events.count()).toBe(before + 1);
  });
  it('saves delinked notes with one event and CSV/replay preservation', async () => {
    await seedPurchase();
    const line = (await db.purchase_lines.toArray())[0];
    const note = await service.saveNote({ business_id: business.id, direction: 'INWARD', note_type: 'DEBIT_NOTE', note_number: 'DN-0001',
      note_date: '2026-08-10', party_id: 'supplier', place_of_supply: '27', supplier_state_code: '27', is_interstate: 0,
      taxable_paise: 1000, igst_paise: 0, cgst_paise: 90, sgst_paise: 90, cess_paise: 0, pre_round_total_paise: 1180,
      round_off_paise: 0, total_paise: 1180, lines: [line] });
    expect(await db.sync_events.count()).toBe(1);
    const snapshot = await buildSnapshotInput(db, business.id, business.name, 'daily', '2026-08-20');
    expect(await snapshot.files.find(file => file.name === 'gst_notes.csv')!.content.text()).toContain('DN-0001');
    const target = new BusinessVaultDB(`note-replay-${Math.random()}`);
    try {
      await target.businesses.add(business);
      const event = (await db.sync_events.toArray())[0];
      await target.transaction('rw', target.tables, async () => {
        await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
        await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
      });
      expect(await target.gst_notes.get(note.id)).toEqual(note);
    } finally { await target.delete(); }
  });
  it('restores new records, metadata and supporting file from provider-only CSV backup', async () => {
    await setupProfile();
    const [nil] = await service.calculateMonths(business.id, ['2026-07']);
    const confirmation = await service.confirmNilPeriod(business.id, '2026-07', nil.sourceDataHash);
    await seedPurchase();
    const line = (await db.purchase_lines.toArray())[0];
    const note = await service.saveNote({ business_id: business.id, direction: 'INWARD', note_type: 'CREDIT_NOTE', note_number: 'CN-0001',
      note_date: '2026-08-10', party_id: 'supplier', place_of_supply: '27', supplier_state_code: '27', is_interstate: 0,
      taxable_paise: 1000, igst_paise: 0, cgst_paise: 90, sgst_paise: 90, cess_paise: 0, pre_round_total_paise: 1180,
      round_off_paise: 0, total_paise: 1180, lines: [line] });
    const adjustment = await service.addAdjustment({ business_id: business.id, report_run_id: null, tax_period_key: '2026-08', report_type: 'GSTR3B_DRAFT',
      table_code: '5.1.INTEREST', tax_head: 'CGST', original_paise: null, adjusted_paise: null, adjustment_paise: 1,
      reason: 'CA external value', supporting_attachment_id: null, source: 'USER', actor_id: null, device_id: 'test-device',
      supportingFile: { filename: 'support.txt', mimeType: 'text/plain', blob: new Blob(['synthetic support']) } });
    const meta = await service.saveDocumentMetadata({ business_id: business.id, source_entity_type: 'GST_NOTE', source_entity_id: note.id,
      document_type: 'CREDIT_NOTE', supply_category: 'DOMESTIC', recipient_category: 'REGISTERED', place_of_supply_state_code: '27', reverse_charge: 0,
      ecommerce_operator_gstin: null, ecommerce_reporting_type: null, section_9_5_role: 'NONE', section_52_tcs: 0,
      shipping_bill_number: null, shipping_bill_date: null, port_code: null, original_document_number: null, original_document_date: null,
      original_return_period: null, amendment_kind: null, tax_on_advance_applicable: 0, classification_source: 'USER_CAPTURED',
      iff_reported_period: null, advance_gst_json: null, advance_adjustments_json: null, recipient_uin: null,
      recipient_identity_reviewed_at: null, recipient_identity_review_reason: null });
    const [before] = await service.calculateMonths(business.id, ['2026-08']);
    const root = await mkdtemp(join(tmpdir(), 'gst-new-records-'));
    const target = new BusinessVaultDB(`gst-new-records-${Math.random()}`);
    try {
      const provider = new LocalFolderStorageProvider();
      await provider.connect({ kind: 'local-folder', rootPath: root });
      await provider.initializeBusiness({ businessId: business.id, businessName: business.name });
      for (const attachment of await db.attachments.toArray()) await provider.uploadAttachment({ path: attachment.logical_path, blob: attachment.blob!, mimeType: attachment.mime_type });
      await provider.writeSnapshot(await buildSnapshotInput(db, business.id, business.name, 'ondemand', now));
      const report = await rebuildFromDrive(new LocalFolderStorageProvider(), { db: target, providerConfig: { kind: 'local-folder', rootPath: root } });
      expect(report.countReconciliation.exact).toBe(true);
      expect(await target.gst_notes.get(note.id)).toMatchObject(note);
      expect(await target.gst_nil_confirmations.get(confirmation.id)).toEqual(confirmation);
      expect(await target.gst_adjustments.get(adjustment.id)).toMatchObject(adjustment);
      expect(await target.gst_document_metadata.get(meta.id)).toMatchObject(meta);
      expect(await (await target.attachments.get(adjustment.supporting_attachment_id!))!.blob!.text()).toBe('synthetic support');
      const [after] = await new GstMonthlyReportService(target).calculateMonths(business.id, ['2026-08']);
      expect(after.sourceDataHash).toBe(before.sourceDataHash);
      expect(after.totals).toEqual(before.totals);
    } finally { await target.delete(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['REVIEWED', 'FINALIZED_WORKING'] as const)('loads the original %s working unchanged despite live source edits', async status => {
    await setupProfile();
    await seedPurchase();
    const [original] = await service.calculateMonths(business.id, ['2026-08']);
    const run = await service.saveReport(original, status);
    const expected = { ...original, savedReportRunId: run.id, savedStatus: status };
    expect(await service.loadSavedReport(business.id, run.id)).toEqual(expected);

    await db.businesses.update(business.id, { name: 'Edited business' });
    await db.suppliers.update('supplier', { name: 'Edited supplier' });
    await db.purchases.update('purchase', { taxable_paise: 2000, cgst_paise: 180, sgst_paise: 180, subtotal_paise: 2000,
      pre_round_total_paise: 2360, total_paise: 2360, balance_paise: 2360, entity_version: 2 });
    await db.purchase_lines.update('purchase-line', { description: 'Edited product', taxable_paise: 2000,
      unit_cost_paise: 2000, cgst_paise: 180, sgst_paise: 180, line_total_paise: 2360 });
    const [live] = await service.calculateMonths(business.id, ['2026-08']);
    expect(live.sourceDataHash).not.toBe(original.sourceDataHash);
    expect(live.totals.inwardNet.taxable_paise).toBe(2000);
    expect(live.totals).not.toEqual(original.totals);
    const events = await db.sync_events.toArray();
    const audits = await db.audit_log.toArray();
    const loaded = await service.loadSavedReport(business.id, run.id);
    expect(loaded).toEqual(expected);
    expect(loaded.totals.inwardNet).toMatchObject({ taxable_paise: 1000, cgst_paise: 90, sgst_paise: 90, total_paise: 1180 });
    expect(loaded.inwardHsnRows[0].description).toBe('Historical product');
    expect(await db.sync_events.toArray()).toEqual(events);
    expect(await db.audit_log.toArray()).toEqual(audits);
  });

  it.each(['cross-business', 'foreign-attachment', 'corrupt-bytes', 'mismatched-child'] as const)(
    'rejects %s saved report evidence', async kind => {
      await setupProfile();
      await seedPurchase();
      const [calculation] = await service.calculateMonths(business.id, ['2026-08']);
      const run = await service.saveReport(calculation, 'REVIEWED');
      expect(await service.loadSavedReport(business.id, run.id)).toMatchObject({ savedReportRunId: run.id });
      let requestedBusiness = business.id;
      let error = 'Saved working not found for this business';
      if (kind === 'cross-business') {
        requestedBusiness = 'other-business';
        await db.businesses.add({ ...business, id: requestedBusiness });
      } else if (kind === 'foreign-attachment') {
        await db.attachments.update(run.source_artifact_attachment_id!, { business_id: 'other-business' });
        error = 'Canonical saved attachment is unavailable';
      } else if (kind === 'corrupt-bytes') {
        const attachment = (await db.attachments.get(run.source_artifact_attachment_id!))!;
        await db.attachments.update(attachment.id, { blob: new Blob([`${await attachment.blob!.text()} `], { type: 'application/json' }) });
        error = 'Saved attachment checksum mismatch';
      } else {
        const child = (await db.gst_report_rows.where('report_run_id').equals(run.id).toArray())[0];
        await db.gst_report_rows.update(child.id, { payload_json: canonicalJson({ ...calculation, businessName: 'Mismatched child' }) });
        error = 'Saved working evidence does not match its immutable run';
      }
      await expect(service.loadSavedReport(requestedBusiness, run.id)).rejects.toThrow(error);
      expect(await db.gst_report_runs.get(run.id)).toEqual(run);
    },
  );

  it.each(['create', 'update'] as const)('rolls back the sidecar, audit and event on a late event insertion failure during %s', async operation => {
    await setupProfile();
    const existing = (await db.gst_aato.toArray())[0];
    const sidecars = await db.gst_aato.toArray();
    const audits = await db.audit_log.toArray();
    const events = await db.sync_events.toArray();
    const input = { business_id: business.id, financial_year: operation === 'create' ? '2026-27' : existing.financial_year,
      aato_paise: 20_000_000, source: 'USER_CONFIRMED' as const, confirmed_at: now, notes: 'Updated AATO',
      ...(operation === 'update' ? { id: existing.id, expectedVersion: existing.entity_version } : {}) };
    const addEvent = db.sync_events.add.bind(db.sync_events);
    const failure = vi.spyOn(db.sync_events, 'add').mockImplementationOnce(row => Dexie.Promise.resolve().then(async () => {
      expect(await db.gst_aato.where('[business_id+financial_year]').equals([business.id, input.financial_year]).first())
        .toMatchObject({ aato_paise: input.aato_paise, entity_version: operation === 'update' ? 2 : 1 });
      expect(await db.audit_log.count()).toBe(audits.length + 1);
      await addEvent(row);
      expect(await db.sync_events.count()).toBe(events.length + 1);
      throw new Error('Injected late event insertion failure');
    }));
    await expect(service.setAato(input)).rejects.toThrow('Injected late event insertion failure');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(await db.gst_aato.toArray()).toEqual(sidecars);
    expect(await db.audit_log.toArray()).toEqual(audits);
    expect(await db.sync_events.toArray()).toEqual(events);
    failure.mockRestore();
    const saved = await service.setAato(input);
    expect(saved.entity_version).toBe(operation === 'update' ? 2 : 1);
    expect(await db.gst_aato.count()).toBe(sidecars.length + (operation === 'create' ? 1 : 0));
    expect(await db.audit_log.count()).toBe(audits.length + 1);
    expect(await db.sync_events.count()).toBe(events.length + 1);
  });

  it('guards flat legacy replay ownership, equal-version conflicts and finalized children', async () => {
    const context = { db, businessId: business.id, diagnostics: [] as string[] };
    const event = (type: string, row: Record<string, unknown>, version = 1, operation = 'create') => ({ event_id: `flat-${type}-${version}`, business_id: business.id,
      device_id: 'legacy', entity_type: type, entity_id: String(row.id), operation, entity_version: version, timestamp: now,
      payload: row, payload_hash: 'legacy', previous_hash: null, sync_status: 'SYNCED' } as unknown as SyncEvent);
    const foreign = { id: 'foreign-row', business_id: 'foreign', report_run_id: 'foreign-parent', entity_version: 1 };
    await db.table('gst_report_rows').put(foreign);
    await expect(applyEvent(event('gst_report_row', { ...foreign, business_id: business.id }, 2), context)).rejects.toThrow('ownership');
    await setupProfile();
    await seedPurchase();
    const [calculation] = await service.calculateMonths(business.id, ['2026-08']);
    const run = await service.saveReport(calculation, 'FINALIZED_WORKING');
    const child = (await db.gst_report_rows.toArray()).find((row) => row.report_run_id === run.id)!;
    await applyEvent(event('gst_report_run', run as unknown as Record<string, unknown>), context);
    await expect(applyEvent(event('gst_report_run', { id: run.id, totals_json: '{"changed":true}' }, 2, 'update'), context)).rejects.toThrow('immutable');
    await expect(applyEvent(event('gst_report_row', { ...child, payload_json: 'changed' }, 1), context)).rejects.toThrow('equal-version');
    await expect(applyEvent(event('gst_report_row', { id: child.id, payload_json: 'changed' }, 2, 'update'), context)).rejects.toThrow('immutable');
    await expect(applyEvent(event('gst_report_row', { ...child, report_run_id: 'different' }, 2), context)).rejects.toThrow('parent');
    expect((await db.gst_report_rows.get(child.id))?.payload_json).toBe(child.payload_json);
  });

  it('future reclaim cannot change prior hash and outstanding reversal carries into a no-movement month', async () => {
    await setupProfile();
    await seedPurchase();
    await db.purchases.update('purchase', { bill_date: '2026-06-01' });
    const reversal = await service.reviewItc(itc('TEMPORARILY_REVERSED', '2026-07'));
    const [before] = await service.calculateMonths(business.id, ['2026-07']);
    await service.reviewItc({ ...itc('RECLAIMED', '2026-09'), reclaimed_paise: 30, related_prior_entry_id: reversal.id });
    const [after] = await service.calculateMonths(business.id, ['2026-07']);
    expect(after.sourceDataHash).toBe(before.sourceDataHash);
    expect(after.totals).toEqual(before.totals);
    const { GstReportingRepository } = await import('../../db/repos/gstReporting');
    const { monthPeriod } = await import('./periods');
    const sources = await new GstReportingRepository(db).loadMonth(monthPeriod(business.id, gstin, '2026-08'));
    expect(sources.itcEntries.map((row) => row.id)).toEqual([reversal.id]);
    expect(sources.purchases.map((row) => row.id)).toEqual(['purchase']);
    expect((await service.loadWorkspace(business.id, ['purchase'])).itcEntries).toHaveLength(2);
  });

  it('blocks repeated claims and reversals across tax periods', async () => {
    await seedPurchase();
    await service.reviewItc(itc('ELIGIBLE_IN_BOOKS', '2026-04'));
    await expect(service.reviewItc(itc('ELIGIBLE_IN_BOOKS', '2026-05'))).rejects.toThrow('Cumulative ITC claim');
    await service.reviewItc(itc('TEMPORARILY_REVERSED', '2026-05'));
    await expect(service.reviewItc(itc('TEMPORARILY_REVERSED', '2026-06'))).rejects.toThrow('Cumulative ITC reversal');
    expect(await db.sync_events.count()).toBe(2);
  });

  it('loads the original purchase and its reviewed history for a native purchase return', async () => {
    await seedPurchase();
    await db.purchases.update('purchase', { bill_date: '2026-04-01' });
    const reviewed = await service.reviewItc(itc('ELIGIBLE_IN_BOOKS', '2026-04'));
    const original = (await db.purchases.get('purchase'))!;
    await db.purchases.add({ ...original, id: 'native-return', bill_date: '2026-08-01', reverses_purchase_id: original.id });
    const { GstReportingRepository } = await import('../../db/repos/gstReporting');
    const { monthPeriod } = await import('./periods');
    const sources = await new GstReportingRepository(db).loadMonth(monthPeriod(business.id, gstin, '2026-08'));
    expect(sources.purchases.map((row) => row.id).sort()).toEqual(['native-return', 'purchase']);
    expect(sources.itcEntries.map((row) => row.id)).toEqual([reviewed.id]);
  });
  it('upgrades an actual Dexie17 database through v20 while preserving pure nullable v15 defaults', async () => {
    const name = `gst-real-upgrade-${Math.random()}`;
    const old = new Dexie(name);
    old.version(17).stores(STORES_V14);
    await old.table('businesses').add(business);
    const tables = { invoice_lines: [{ id: 'old-line', business_id: business.id, invoice_id: 'old-invoice', description: 'Frozen', hsn: '01234567', taxable_paise: 123, tax_rate_bps: 1800 }],
      gst_document_metadata: [{ id: 'old-meta', business_id: business.id, entity_version: 7 }],
      gst_itc_ledger: [{ id: 'old-itc', business_id: business.id, status: 'ELIGIBLE', original_eligible_paise: 9, entity_version: 8 }] };
    const frozen = canonicalJson(tables);
    for (const [table, rows] of Object.entries(tables)) await old.table(table).bulkAdd(rows);
    old.close();
    const upgraded = new BusinessVaultDB(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(20);
      const snapshot = migrateSnapshot(tables, 14).tables;
      for (const [table, rows] of Object.entries(snapshot)) expect(await upgraded.table(table).toArray()).toEqual(rows);
      expect(canonicalJson(tables)).toBe(frozen);
      expect(await upgraded.invoice_lines.get('old-line')).toMatchObject({ taxable_paise: 123, description: 'Frozen', hsn: '01234567', uqc_code: null, snapshot_source: null });
      expect(await upgraded.gst_itc_ledger.get('old-itc')).toMatchObject({ status: 'ELIGIBLE', entity_version: 8, books_tax_paise: null });
    } finally { await upgraded.delete(); }
  });

  it('rejects review/finalization for a live DRAFT nil period', async () => {
    await setupProfile();
    const [nil] = await service.calculateMonths(business.id, ['2026-08']);
    expect(nil.status).toBe('DRAFT');
    await expect(service.saveReport(nil, 'REVIEWED')).rejects.toThrow('READY_FOR_CA_REVIEW');
    await expect(service.saveReport(nil, 'FINALIZED_WORKING')).rejects.toThrow('READY_FOR_CA_REVIEW');
    expect(await db.gst_report_runs.count()).toBe(0);
    expect(await db.sync_events.count()).toBe(2);
  });

  it('uses implicit UNREVIEWED and allows only linked legacy unreviewed supersession', async () => {
    await seedPurchase();
    await expect(service.reviewItc(itc('UNREVIEWED', '2026-08'))).rejects.toThrow('implicit');
    expect(await db.sync_events.count()).toBe(0);
    await db.gst_itc_ledger.add({ ...itc('UNREVIEWED', '2026-08'), id: 'legacy-unreviewed', ...audit });
    await expect(service.reviewItc(itc('ELIGIBLE_IN_BOOKS', '2026-08'))).rejects.toThrow('Duplicate');
    const reviewed = await service.reviewItc({ ...itc('ELIGIBLE_IN_BOOKS', '2026-08'), related_prior_entry_id: 'legacy-unreviewed' });
    expect(reviewed.original_eligible_paise).toBe(90);
    expect(reviewed.related_prior_entry_id).toBe('legacy-unreviewed');
    expect(await db.sync_events.count()).toBe(1);
    await expect(service.reviewItc({ ...itc('ELIGIBLE_IN_BOOKS', '2026-08'), related_prior_entry_id: reviewed.id })).rejects.toThrow('Duplicate');
    await expect(service.reviewItc({ ...itc('ELIGIBLE_IN_BOOKS', '2026-08', 'SGST'), related_prior_entry_id: 'legacy-unreviewed' })).rejects.toThrow('same source');
  });

  it('rejects unsupported adjustment table/head pairs before durable writes', async () => {
    await setupProfile();
    await seedPurchase();
    const input = { business_id: business.id, report_run_id: null, tax_period_key: '2026-08', report_type: 'GSTR3B_DRAFT' as const,
      table_code: '5.INTERSTATE', tax_head: 'CGST' as const, original_paise: null, adjusted_paise: null, adjustment_paise: 1,
      reason: 'Synthetic reason', supporting_attachment_id: null, source: 'USER' as const, actor_id: null, device_id: 'test-device' };
    await expect(service.addAdjustment(input)).rejects.toThrow('Unsupported adjustment');
    await expect(service.addAdjustment({ ...input, table_code: 'no-table' })).rejects.toThrow('Unsupported adjustment');
    await expect(service.addAdjustment({ ...input, table_code: '5.1', report_type: 'MONTHLY_GST_PACK' })).rejects.toThrow('Unsupported adjustment');
    expect(await db.gst_adjustments.count()).toBe(0);
    expect(await db.sync_events.count()).toBe(2);
    await service.addAdjustment({ ...input, table_code: '5.1' });
    expect(await db.gst_adjustments.count()).toBe(1);
    expect(await db.sync_events.count()).toBe(3);
  });

  it('unrelated historical metadata, ITC and legacy audits do not enter month sources or change its hash', async () => {
    await setupProfile();
    await seedPurchase();
    const [before] = await service.calculateMonths(business.id, ['2026-08']);
    await db.gst_document_metadata.put({ id: 'unrelated-meta', business_id: business.id, source_entity_type: 'PURCHASE', source_entity_id: 'unrelated', reporting_period_override: '2020-01' } as GstDocumentMetadata);
    await db.gst_itc_ledger.put({ ...itc('ELIGIBLE_IN_BOOKS', '2020-01'), id: 'unrelated-itc', source_entity_id: 'unrelated', ...audit });
    await db.legacy_reversal_audit.put({ credit_note_invoice_id: 'unrelated-cn', business_id: business.id, original_invoice_id: 'unrelated-invoice', classification: 'UNKNOWN', materialized_sales_return_id: null,
      evidence: { journal_entry_number: null, journal_narration: null, journal_ref_type: null, credit_note_invoice_number: null, stock_movement_types: [], original_lines_present: false, original_lines_count: 0 }, examined_at: now, migration_version: 1 });
    const { GstReportingRepository } = await import('../../db/repos/gstReporting');
    const repository = new GstReportingRepository(db);
    const sources = await repository.loadMonth(before.period);
    expect(sources.metadata).toEqual([]);
    expect(sources.itcEntries).toEqual([]);
    expect(sources.legacyAudits).toEqual([]);
    const [after] = await service.calculateMonths(business.id, ['2026-08']);
    expect(after.sourceDataHash).toBe(before.sourceDataHash);
    const workspace = await service.loadWorkspace(business.id, ['purchase']);
    expect(workspace.reviewPurchases.map((row) => row!.id)).toEqual(['purchase']);
  });
  it('test112: preserves saved working and independent workbook totals across provider-only recovery on logical16/Dexie20', async () => {
    expect(db.verno).toBe(20);
    await setupProfile();
    await seedPurchase();
    const metadata = { business_id: business.id, source_entity_type: 'PURCHASE', source_entity_id: 'purchase',
      document_type: 'TAX_INVOICE', supply_category: 'DOMESTIC', recipient_category: 'REGISTERED',
      place_of_supply_state_code: '27', reverse_charge: 0, ecommerce_operator_gstin: null, ecommerce_reporting_type: null,
      section_9_5_role: 'NONE', section_52_tcs: 0, shipping_bill_number: null, shipping_bill_date: null, port_code: null,
      original_document_number: null, original_document_date: null, original_return_period: null, amendment_kind: null,
      tax_on_advance_applicable: 0, classification_source: 'USER_CAPTURED', reporting_period_override: null,
      original_source_entity_type: null, original_source_entity_id: null, previously_reported_values_json: null } as const;
    await service.saveDocumentMetadata(metadata);
    await service.reviewItc(itc('ELIGIBLE_IN_BOOKS', '2026-08'));
    await service.addAdjustment({ business_id: business.id, report_run_id: null, tax_period_key: '2026-08', report_type: 'GSTR3B_DRAFT',
      table_code: '5.1', tax_head: 'CGST', original_paise: null, adjusted_paise: null, adjustment_paise: 1,
      reason: 'Synthetic external interest', note: 'External manual working', supporting_attachment_id: null, source: 'USER', actor_id: null, device_id: 'test-device' });
    const [before] = await service.calculateMonths(business.id, ['2026-08']);
    expect(before.issues.filter((row) => row.severity === 'BLOCKING_ERROR')).toEqual([]);
    expect(before.reconciliations.filter((row) => row.status === 'ERROR')).toEqual([]);
    const run = await service.saveReport(before, 'REVIEWED');
    const savedBefore = await service.loadSavedReport(business.id, run.id);
    expect(savedBefore).toEqual({ ...before, savedReportRunId: run.id, savedStatus: 'REVIEWED' });
    const workbookBefore = await workbookRows(savedBefore);
    const root = await mkdtemp(join(tmpdir(), 'gst-full-recovery-'));
    const target = new BusinessVaultDB(`gst-provider-recovery-${Math.random()}`);
    try {
      const provider = new LocalFolderStorageProvider();
      await provider.connect({ kind: 'local-folder', rootPath: root });
      await provider.initializeBusiness({ businessId: business.id, businessName: business.name });
      for (const attachment of await db.attachments.toArray()) {
        await provider.uploadAttachment({ path: attachment.logical_path, blob: attachment.blob!, mimeType: attachment.mime_type });
      }
      const snapshot = await buildSnapshotInput(db, business.id, business.name, 'ondemand', now);
      await provider.writeSnapshot(snapshot);
      const report = await rebuildFromDrive(new LocalFolderStorageProvider(), { db: target, providerConfig: { kind: 'local-folder', rootPath: root } });
      expect(report.countReconciliation.exact).toBe(true);
      expect(await target.gst_profiles.count()).toBe(1);
      expect(await target.gst_document_metadata.count()).toBe(1);
      expect(await target.gst_itc_ledger.count()).toBe(1);
      expect(await target.gst_adjustments.count()).toBe(1);
      expect((await target.gst_report_runs.get(run.id))?.source_data_hash).toBe(before.sourceDataHash);
      const restored = await target.attachments.get(run.source_artifact_attachment_id!);
      expect(JSON.parse(await restored!.blob!.text()).calculation.sourceDataHash).toBe(before.sourceDataHash);
      const restoredService = new GstMonthlyReportService(target, 'restored', () => now);
      const savedAfter = await restoredService.loadSavedReport(business.id, run.id);
      expect(savedAfter).toEqual(savedBefore);
      const workbookAfter = await workbookRows(savedAfter);
      expect(workbookAfter).toEqual(workbookBefore);
      for (const workbook of [workbookBefore, workbookAfter]) {
        const net = workbook['Monthly Summary'].find(row => row.section === 'inwardNet')!;
        expect(net).toMatchObject({ document_count: 1, 'taxable (INR)': 10, 'cgst (INR)': 0.9, 'sgst (INR)': 0.9, 'total (INR)': 11.8 });
        // Sum reopened detail cells in paise against the seeded bill, not just
        // another engine result or the exporter's own reconciliation verdict.
        for (const kind of ['DOCUMENT', 'RATE', 'HSN']) {
          const rows = workbook['Purchase Register'].filter(row => row.row_kind === kind);
          expect(rows).toHaveLength(1);
          for (const [column, paise] of [['taxable (INR)', 1000], ['cgst (INR)', 90], ['sgst (INR)', 90], ['igst (INR)', 0], ['cess (INR)', 0]] as const) {
            const total = rows.reduce((sum, row) => sum + Math.round(Number(row[column]) * 100), 0);
            expect(total).toBe(paise);
            expect(total).toBe(Math.round(Number(net[column]) * 100));
          }
        }
        for (const [head, approved] of [['CGST', 90], ['SGST', 0]] as const) {
          const rows = workbook['Books ITC'].filter(row => row.tax_head === head);
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.reduce((sum, row) => sum + Math.round(Number(row['books_tax (INR)']) * 100), 0)).toBe(90);
          expect(rows.reduce((sum, row) => sum + Math.round(Number(row['approved (INR)']) * 100), 0)).toBe(approved);
        }
        expect(workbook['GSTR3B Working'].find(row => row.table_code === '5.1' && row.measure === 'cgst_paise'))
          .toMatchObject({ 'ca_adjustment (INR)': 0.01, 'final_working (INR)': 0.01 });
        expect(workbook.Metadata[0]).toMatchObject({ saved_report_run_id: run.id, saved_status: 'REVIEWED',
          source_data_hash: before.sourceDataHash, export_status: 'REVIEWED' });
      }
      const [after] = await restoredService.calculateMonths(business.id, ['2026-08']);
      expect(after.sourceDataHash).toBe(before.sourceDataHash);
      expect(after.totals).toEqual(before.totals);
    } finally {
      await target.delete();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('indexes month boundaries and loads only targeted older source and cancellation evidence', async () => {
    await seedPurchase();
    const original = (await db.purchases.get('purchase'))!;
    await db.purchases.bulkAdd([
      { ...original, id: 'old', bill_date: '2026-07-01' },
      { ...original, id: 'next', bill_date: '2026-09-01' },
      { ...original, id: 'unrelated-old', bill_date: '2020-01-01' },
      { ...original, id: 'other-business', business_id: 'other' },
    ]);
    await db.gst_itc_ledger.add({ ...itc('TEMPORARILY_REVERSED', '2026-08'), id: 'old-source-review', source_entity_id: 'old', ...audit });
    const { GstReportingRepository } = await import('../../db/repos/gstReporting');
    const { monthPeriod } = await import('./periods');
    const sources = await new GstReportingRepository(db).loadMonth(monthPeriod(business.id, gstin, '2026-08'));
    expect(sources.purchases.map((row) => row.id).sort()).toEqual(['old', 'purchase']);
    expect(sources.purchaseLines.map((row) => row.id)).toEqual(['purchase-line']);
  });
  it('read-only previews are ordered, reject duplicates and emit no events', async () => {
    await setupProfile();
    const count = await db.sync_events.count();
    const results = await service.calculateMonths(business.id, ['2026-09', '2026-08'], 'QRMP');
    expect(results.map((row) => row.period.periodKey)).toEqual(['2026-08', '2026-09']);
    expect(await db.sync_events.count()).toBe(count);
    await expect(service.calculateMonths(business.id, ['2026-08', '2026-08'])).rejects.toThrow('Duplicate');
  });

  it('durable profile/AATO changes each emit one event and replay audit idempotently with restored versions', async () => {
    await setupProfile();
    expect(await db.sync_events.count()).toBe(2);
    expect(await db.audit_log.count()).toBe(2);
    const target = new BusinessVaultDB(`gst-replay-${Math.random()}`);
    await target.businesses.add(business);
    const events = await db.sync_events.toArray();
    for (const event of [...events, ...events]) await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
    expect(await target.audit_log.count()).toBe(2);
    expect(await target.gst_profiles.count()).toBe(1);
    const profile = (await target.gst_profiles.toArray())[0];
    await target.gst_profiles.put({ ...profile, entity_version: 9 });
    const targetService = new GstMonthlyReportService(target, 'restored');
    await targetService.saveProfile({ ...profile, expectedVersion: 9, legal_name: 'Updated after recovery' });
    expect((await target.sync_events.toArray())[0].entity_version).toBe(10);
    await expect(targetService.saveProfile({ ...profile, expectedVersion: 9 })).rejects.toThrow('Stale');
    await target.delete();
  });

  it('reclaim validation is per source/head and remaining balance inside the write transaction', async () => {
    await seedPurchase();
    const reversal = await service.reviewItc(itc('TEMPORARILY_REVERSED', '2026-07'));
    const reclaim = await service.reviewItc({ ...itc('RECLAIMED', '2026-08'), related_prior_entry_id: reversal.id });
    expect(reclaim.reviewed_by_device_id).toBe('test-device');
    expect(await db.sync_events.count()).toBe(2);
    await expect(service.reviewItc({ ...itc('RECLAIMED', '2026-09'), related_prior_entry_id: reversal.id })).rejects.toThrow('balance');
    await expect(service.reviewItc({ ...itc('RECLAIMED', '2026-08', 'IGST'), related_prior_entry_id: reversal.id })).rejects.toThrow('tax head');
    await db.suppliers.update('supplier', { gstin: 'INVALID' });
    await expect(service.reviewItc(itc('ELIGIBLE_IN_BOOKS', '2026-10'))).rejects.toThrow('valid supplier GSTIN');
    expect(await db.sync_events.count()).toBe(2);
  });

  it('loads linked prior reversal and all relevant reclaims without unrelated history', async () => {
    await seedPurchase();
    await db.purchases.update('purchase', { bill_date: '2026-06-01' });
    const reversal = await service.reviewItc(itc('TEMPORARILY_REVERSED', '2026-07'));
    await service.reviewItc({ ...itc('RECLAIMED', '2026-08'), reclaimed_paise: 30, related_prior_entry_id: reversal.id });
    await service.reviewItc({ ...itc('RECLAIMED', '2026-09'), reclaimed_paise: 30, related_prior_entry_id: reversal.id });
    await db.gst_itc_ledger.add({ ...itc('ELIGIBLE_IN_BOOKS', '2021-01'), id: 'unrelated-history', source_entity_id: 'unrelated', ...audit });
    const { GstReportingRepository } = await import('../../db/repos/gstReporting');
    const { monthPeriod } = await import('./periods');
    const sources = await new GstReportingRepository(db).loadMonth(monthPeriod(business.id, gstin, '2026-09'));
    expect(sources.purchases.map((row) => row.id)).toEqual(['purchase']);
    expect(sources.itcEntries).toHaveLength(3);
    expect(sources.itcEntries.some((row) => row.id === reversal.id)).toBe(true);
    expect(sources.itcEntries.some((row) => row.id === 'unrelated-history')).toBe(false);
    await expect(service.reviewItc({ ...itc('RECLAIMED', '2026-10'), reclaimed_paise: 31, related_prior_entry_id: reversal.id })).rejects.toThrow('balance');
    expect((await service.loadWorkspace(business.id, ['purchase'])).reviewPurchases[0]?.bill_date).toBe('2026-06-01');
  });

  it('saves live recalculated canonical working, one event/upload job and idempotent child replay', async () => {
    await setupProfile();
    await seedPurchase();
    const [calculation] = await service.calculateMonths(business.id, ['2026-08']);
    expect(calculation.issues.filter((row) => row.severity === 'BLOCKING_ERROR')).toEqual([]);
    const baseline = await db.sync_events.count();
    const run = await service.saveReport(calculation, 'FINALIZED_WORKING');
    expect(await db.sync_events.count()).toBe(baseline + 1);
    expect(await db.sync_queue.count()).toBe(1);
    const attachment = (await db.attachments.toArray())[0];
    expect(attachment.logical_path).toBe(`attachments/gst/report-runs/${run.id}/working.json`);
    expect(JSON.parse(await attachment.blob!.text()).calculation.sourceDataHash).toBe(calculation.sourceDataHash);
    const event = (await db.sync_events.toArray()).find((row) => row.entity_type === 'gst_report_run')!;
    expect((event.payload as { attachment: Attachment }).attachment.blob).toBeNull();
    const target = new BusinessVaultDB(`gst-run-replay-${Math.random()}`);
    await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
    await applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] });
    expect(await target.gst_report_runs.count()).toBe(1);
    expect(await target.gst_report_rows.count()).toBe(1);
    expect(await target.audit_log.count()).toBe(1);
    const context = { db: target, businessId: business.id, diagnostics: [] as string[] };
    const aggregate = event.payload as { row: GstReportRun; rows: Array<Record<string, unknown>>; audit: Record<string, unknown>; attachment: Attachment };
    const savedBlob = new Blob(['immutable locally downloaded JSON']);
    await target.attachments.update(attachment.id, { blob: savedBlob, drive_file_id: 'uploaded-id', updated_at: '2026-08-21T00:00:00Z' });
    await applyEvent(event as unknown as SyncEvent, context);
    expect(await (await target.attachments.get(attachment.id))!.blob!.text()).toBe('immutable locally downloaded JSON');
    await expect(applyEvent({ ...event, payload: { ...aggregate, rows: [{ ...aggregate.rows[0], payload_json: '{"tampered":true}' }] } } as unknown as SyncEvent, context)).rejects.toThrow('equal-version');
    await expect(applyEvent({ ...event, payload: { ...aggregate, attachment: { ...aggregate.attachment, checksum: 'changed' } } } as unknown as SyncEvent, context)).rejects.toThrow('checksum conflict');
    await target.gst_report_runs.update(run.id, { entity_version: 2 });
    await applyEvent({ ...event, payload: { ...aggregate, rows: [{ ...aggregate.rows[0], payload_json: '{"stale":true}' }] } } as unknown as SyncEvent, context);
    expect((await target.gst_report_rows.toArray())[0].payload_json).not.toContain('stale');
    await expect(service.addAdjustment({ business_id: business.id, report_run_id: run.id, tax_period_key: '2026-08', report_type: 'MONTHLY_GST_PACK', table_code: '3.1(a)', tax_head: 'CGST',
      original_paise: 90, adjusted_paise: 91, adjustment_paise: 1, reason: 'CA review', supporting_attachment_id: null, source: 'USER', actor_id: null, device_id: 'test-device' })).rejects.toThrow('immutable');
    await db.purchase_lines.update('purchase-line', { description: 'Source changed' });
    await expect(service.saveReport(calculation, 'REVIEWED')).rejects.toThrow('sources changed');
    await target.delete();
  });

  it('aggregate replay rejects existing foreign child/audit/attachment ids before writing the parent', async () => {
    await setupProfile();
    await seedPurchase();
    const [calculation] = await service.calculateMonths(business.id, ['2026-08']);
    await service.saveReport(calculation, 'REVIEWED');
    const event = (await db.sync_events.toArray()).find((row) => row.entity_type === 'gst_report_run')!;
    const aggregate = event.payload as { row: GstReportRun; rows: Array<Record<string, unknown>>; audit: Record<string, unknown>; attachment: Attachment };
    for (const kind of ['child', 'audit', 'attachment', 'same-business-other-parent'] as const) {
      const target = new BusinessVaultDB(`gst-foreign-replay-${kind}-${Math.random()}`);
      try {
        if (kind === 'child' || kind === 'same-business-other-parent') await target.table('gst_report_rows').put({ ...aggregate.rows[0], business_id: kind === 'child' ? 'foreign' : business.id, report_run_id: 'foreign-run' });
        if (kind === 'audit') await target.table('audit_log').put({ ...aggregate.audit, business_id: 'foreign' });
        if (kind === 'attachment') await target.attachments.put({ ...aggregate.attachment, business_id: 'foreign', blob: null });
        await expect(applyEvent(event as unknown as SyncEvent, { db: target, businessId: business.id, diagnostics: [] })).rejects.toThrow(/ownership|parent/);
        expect(await target.gst_report_runs.count()).toBe(0);
        if (kind === 'child') expect((await target.gst_report_rows.toArray())[0].business_id).toBe('foreign');
      } finally { await target.delete(); }
    }
  });

  it('CSV coercion preserves source hashes and saved payloads', async () => {
    await setupProfile();
    await seedPurchase();
    const [before] = await service.calculateMonths(business.id, ['2026-08']);
    const target = new BusinessVaultDB(`gst-csv-roundtrip-${Math.random()}`);
    for (const spec of TABLE_SPECS) {
      const rows = await db.table(spec.store).toArray();
      for (const row of rows) {
        const raw: Record<string, string> = {};
        for (const column of spec.columns) {
          const value = row[column.name];
          raw[column.name] = value == null ? '' : column.type === 'json' ? JSON.stringify(value) : String(value);
        }
        await target.table(spec.store).put(coerceRow(raw, spec));
      }
    }
    const [after] = await new GstMonthlyReportService(target, 'after').calculateMonths(business.id, ['2026-08']);
    expect(after.sourceDataHash).toBe(before.sourceDataHash);
    expect(after.totals).toEqual(before.totals);
    await target.businesses.update(business.id, { drive_folder_id: 'new-recovery-folder', drive_connected_email: 'reconnected@example.test' });
    const [reconnected] = await new GstMonthlyReportService(target, 'after').calculateMonths(business.id, ['2026-08']);
    expect(reconnected.sourceDataHash).toBe(before.sourceDataHash);
    await target.delete();
  });
});
