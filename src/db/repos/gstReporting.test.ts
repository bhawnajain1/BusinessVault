import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusinessVaultDB } from '../database';
import type { Business, GstDocumentMetadata, GstItcLedgerEntry, Purchase, PurchaseLine, Supplier } from '../types';
import { GstReportingRepository } from './gstReporting';
import { GstMonthlyReportService, hashGstSources, type ReviewGstItcInput } from '../../domain/gstReporting/GstMonthlyReportService';
import { monthPeriod } from '../../domain/gstReporting/periods';
import { calculateMonthlyGst } from '../../domain/gstReporting/calculateMonthlyGst';

const now = '2026-06-20T10:00:00.000Z';
const stamp = { created_at: now, updated_at: now, entity_version: 1 };
const gstin = '27AAPFU0939F1ZV';
let db: BusinessVaultDB;
let service: GstMonthlyReportService;
let repository: GstReportingRepository;
const purchase: Purchase = {
  id: 'original', business_id: 'business', bill_number: 'B-1', supplier_bill_number: 'S-1', bill_date: '2026-04-01',
  due_date: null, supplier_id: 'supplier', supplier_state_code: '27', is_interstate: 0, financial_year: '2026-27',
  subtotal_paise: 1000, discount_paise: 0, taxable_paise: 1000, cgst_paise: 90, sgst_paise: 90, igst_paise: 0,
  cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 1180, total_paise: 1180,
  paid_paise: 0, balance_paise: 1180, status: 'received', reversed_by_purchase_id: null, reverses_purchase_id: null,
  notes: '', attachment_id: null, journal_entry_id: '', ...stamp,
};
function review(status: GstItcLedgerEntry['status'], period: string, values: Partial<ReviewGstItcInput> = {}): ReviewGstItcInput {
  return { business_id: 'business', source_entity_type: 'PURCHASE', source_entity_id: 'original', tax_period_key: period,
    category: 'OTHER_ITC', tax_head: 'CGST', books_tax_paise: 90, original_eligible_paise: 90,
    temporarily_reversed_paise: status === 'TEMPORARILY_REVERSED' ? 90 : 0, permanently_reversed_paise: 0,
    reclaimable_paise: 90, reclaimed_paise: status === 'RECLAIMED' ? 90 : 0, status, reason_code: null,
    related_prior_entry_id: null, user_confirmation: 1, ...values };
}
beforeEach(async () => {
  db = new BusinessVaultDB(`gst-repo-${Math.random()}`);
  service = new GstMonthlyReportService(db, 'test', () => now);
  repository = new GstReportingRepository(db);
  await db.businesses.add({ id: 'business', name: 'Synthetic', gstin, state_code: '27', ...stamp } as Business);
  await db.suppliers.add({ id: 'supplier', business_id: 'business', name: 'Synthetic Supplier', gstin, state_code: '27', ...stamp } as Supplier);
  await db.purchases.add(purchase);
  await db.purchase_lines.add({ id: 'original-line', business_id: 'business', purchase_id: purchase.id, line_no: 1,
    item_id: 'item', description: 'Synthetic item', hsn: '12345678', warehouse_id: '', qty_micros: 1_000_000,
    unit_cost_paise: 1000, discount_paise: 0, taxable_paise: 1000, tax_rate_bps: 1800, cgst_paise: 90,
    sgst_paise: 90, igst_paise: 0, cess_paise: 0, line_total_paise: 1180, uqc_code: 'NOS', goods_or_service: 'GOODS',
    taxability: 'TAXABLE', cess_rate_bps: 0, snapshot_source: 'NATIVE' } satisfies PurchaseLine);
});
afterEach(async () => { await db.delete(); });

describe('GST purchase-return evidence and save guards', () => {
  it('loads May returns, lines and reviewed heads for a June reclaim, with their original dates', async () => {
    const reversal = await service.reviewItc(review('TEMPORARILY_REVERSED', '2026-04'));
    await db.purchases.add({ ...purchase, id: 'may-return', bill_number: 'B-2', supplier_bill_number: 'S-2', bill_date: '2026-05-01', reverses_purchase_id: purchase.id });
    await db.purchase_lines.put({ id: 'note-line', business_id: 'business', purchase_id: 'may-return', cgst_paise: 90 } as PurchaseLine);
    await db.gst_document_metadata.put({ id: 'note-meta', business_id: 'business', source_entity_type: 'PURCHASE_RETURN', source_entity_id: 'may-return', reverse_charge: 0, ...stamp } as GstDocumentMetadata);
    await db.gst_itc_ledger.add({ ...review('INELIGIBLE', '2026-05', { source_entity_type: 'PURCHASE_RETURN', source_entity_id: 'may-return', reason_code: 'SECTION_17_5' }), id: 'note-review', ...stamp });
    // A restored invalid reclaim must still be caught by the engine, not hidden by the repository.
    await db.gst_itc_ledger.add({ ...review('RECLAIMED', '2026-06', { source_period_key: '2026-04', related_prior_entry_id: reversal.id }), id: 'restored-reclaim', ...stamp });
    const period = monthPeriod('business', gstin, '2026-06');
    const sources = await repository.loadMonth(period);
    expect(sources.purchases.map((row) => row.id).sort()).toEqual(['may-return', 'original']);
    expect(sources.purchases.find((row) => row.id === 'may-return')?.bill_date).toBe('2026-05-01');
    expect(sources.purchaseLines.map((row) => row.id)).toContain('note-line');
    expect(sources.metadata.map((row) => row.id)).toContain('note-meta');
    expect(sources.itcEntries.map((row) => row.id)).toContain('note-review');
    const result = calculateMonthlyGst(sources, period, now);
    expect(result.inwardNotes.filter((row) => row.included)).toEqual([]);
    expect(result.issues.map((row) => row.code)).toContain('ITC_CUMULATIVE_BALANCE_INVALID');
    expect(result.booksItcRows.find((row) => row.ledger_entry_id === 'restored-reclaim')?.approved_paise).toBe(0);
    const hash = await hashGstSources(sources, period, result.ruleSetVersion);
    await db.purchases.update('may-return', { notes: 'Changed historical evidence' });
    expect(await hashGstSources(await repository.loadMonth(period), period, result.ruleSetVersion)).not.toBe(hash);
  });

  it('excludes future, foreign and unrelated linked returns from period context', async () => {
    await service.reviewItc(review('TEMPORARILY_REVERSED', '2026-04'));
    const period = monthPeriod('business', gstin, '2026-06');
    const before = await repository.loadMonth(period);
    await db.purchases.bulkAdd([
      { ...purchase, id: 'future', bill_date: '2026-07-01', reverses_purchase_id: purchase.id },
      { ...purchase, id: 'foreign', business_id: 'foreign', bill_date: '2026-05-01', reverses_purchase_id: purchase.id },
      { ...purchase, id: 'unrelated', bill_date: '2026-05-01', reverses_purchase_id: 'other-original' },
    ]);
    const after = await repository.loadMonth(period);
    expect(after.purchases.map((row) => row.id)).toEqual(['original']);
    // Full-FY duplicate identity evidence is independent of month entitlement evidence.
    expect(after.itcEntries).toEqual(before.itcEntries);
    expect(await hashGstSources({ ...after, documentIdentityEvidence: [] }, period, 'test')).toBe(
      await hashGstSources({ ...before, documentIdentityEvidence: [] }, period, 'test'));
  });

  it('rejects a reclaim after a full native return without requiring a reviewed return', async () => {
    const reversal = await service.reviewItc(review('TEMPORARILY_REVERSED', '2026-04'));
    await db.purchases.add({ ...purchase, id: 'return', bill_date: '2026-05-01', reverses_purchase_id: purchase.id });
    await expect(service.reviewItc(review('RECLAIMED', '2026-06', { related_prior_entry_id: reversal.id }))).rejects.toThrow('purchase returns');
    expect(await db.gst_itc_ledger.count()).toBe(1);
  });

  it('allows only the non-returned partial reclaim and ignores later returns', async () => {
    const reversal = await service.reviewItc(review('TEMPORARILY_REVERSED', '2026-04'));
    await db.purchases.bulkAdd([
      { ...purchase, id: 'partial-return', cgst_paise: 30, bill_date: '2026-05-01', reverses_purchase_id: purchase.id },
      { ...purchase, id: 'future-return', cgst_paise: 60, bill_date: '2026-07-01', reverses_purchase_id: purchase.id },
    ]);
    await expect(service.reviewItc(review('RECLAIMED', '2026-06', { reclaimed_paise: 61, related_prior_entry_id: reversal.id }))).rejects.toThrow('purchase returns');
    await service.reviewItc(review('RECLAIMED', '2026-06', { reclaimed_paise: 60, related_prior_entry_id: reversal.id }));
    await expect(service.reviewItc(review('RECLAIMED', '2026-07', { reclaimed_paise: 1, related_prior_entry_id: reversal.id }))).rejects.toThrow('purchase returns');
  });

  it('subtracts reviewed negative return claims before validating another reversal', async () => {
    await service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-04'));
    await db.purchases.add({ ...purchase, id: 'return', cgst_paise: 30, bill_date: '2026-05-01', reverses_purchase_id: purchase.id });
    await service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-05', { source_entity_type: 'PURCHASE_RETURN', source_entity_id: 'return', books_tax_paise: 30, original_eligible_paise: 30, reclaimable_paise: 0 }));
    await expect(service.reviewItc(review('TEMPORARILY_REVERSED', '2026-06', { temporarily_reversed_paise: 61 }))).rejects.toThrow('Cumulative ITC reversal');
    await service.reviewItc(review('TEMPORARILY_REVERSED', '2026-06', { temporarily_reversed_paise: 60 }));
  });

  it('does not let a partial claim exceed the remaining nonnegative return ceiling', async () => {
    await service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-04', { original_eligible_paise: 30 }));
    await db.purchases.add({ ...purchase, id: 'return', cgst_paise: 60, bill_date: '2026-05-01', reverses_purchase_id: purchase.id });
    await expect(service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-06', { original_eligible_paise: 1 }))).rejects.toThrow('Cumulative ITC claim');
  });

  it('requires explicit matching reverse-charge metadata for RCM reviews', async () => {
    await expect(service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-04', { category: 'RCM' }))).rejects.toThrow('reverse-charge');
    await db.gst_document_metadata.put({ id: 'meta', business_id: 'business', source_entity_type: 'PURCHASE', source_entity_id: purchase.id, reverse_charge: 1, ...stamp } as GstDocumentMetadata);
    await expect(service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-04'))).rejects.toThrow('reverse-charge');
    await service.reviewItc(review('ELIGIBLE_IN_BOOKS', '2026-04', { category: 'RCM' }));
  });

  it.each(['SECTION_16_4', 'POS_RESTRICTION', 'SECTION_17_5', 'PERMANENT_NON_RECLAIMABLE'])('accepts engine legal reason %s', async (reason_code) => {
    await service.reviewItc(review('INELIGIBLE', '2026-04', { reason_code }));
  });
  it.each([null, 'CA_REVIEW', 'SECTION16_4', 'SECTION17_5'])('rejects unsupported ineligible reason %s', async (reason_code) => {
    await expect(service.reviewItc(review('INELIGIBLE', '2026-04', { reason_code }))).rejects.toThrow('legal reason');
  });
});
