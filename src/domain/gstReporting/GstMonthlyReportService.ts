import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../../db/database';
import { GstReportingRepository, GST_SOURCE_TABLES, waitForGstTransaction, normalizeGstSourceRow } from '../../db/repos/gstReporting';
import type { Attachment, GstAato, GstAdjustment, GstDocumentMetadata, GstItcLedgerEntry, GstProfile, GstReportRow, GstReportRun, GstSourceEntityType } from '../../db/types';
import { canonicalJson, sha256Hex } from '../../journal/event';
import { isValidGstin } from '../../lib/gst';
import { appendSyncEvent } from '../syncEventLog';
import { calculateMonthlyGst } from './calculateMonthlyGst';
import { selectedMonthPeriods, validateTaxPeriod } from './periods';
import type { GstMonthlySources, GstTaxPeriod, MonthlyGstCalculation } from './types';

type Editable<T extends { id: string; business_id: string; created_at: string; updated_at: string; entity_version: number }> =
  Omit<T, 'id' | 'created_at' | 'updated_at' | 'entity_version'> & { id?: string; expectedVersion?: number };
export type SaveGstProfileInput = Editable<GstProfile>;
export type SetGstAatoInput = Editable<GstAato>;
export type SaveGstDocumentMetadataInput = Editable<GstDocumentMetadata>;
export type ReviewGstItcInput = Editable<GstItcLedgerEntry>;
export type GstIneligibleReason = 'SECTION_16_4' | 'POS_RESTRICTION' | 'SECTION_17_5' | 'PERMANENT_NON_RECLAIMABLE';
const INELIGIBLE_REASONS: readonly GstIneligibleReason[] = ['SECTION_16_4', 'POS_RESTRICTION', 'SECTION_17_5', 'PERMANENT_NON_RECLAIMABLE'];
export type AddGstAdjustmentInput = Editable<GstAdjustment>;

// Normalize only newly additive optional fields, so an old row and its restored
// CSV representation (which contains nulls) hash identically. Arrays are keyed,
// not insertion-ordered. Monetary source values are never recalculated here.
export function canonicalGstSources(sources: GstMonthlySources): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sources)) {
    if (!Array.isArray(value)) {
      const business = normalizeGstSourceRow('businesses', value);
      // Provider linkage and sequence allocators are operational state, not GST
      // evidence. Disaster recovery deliberately rewrites provider linkage.
      for (const field of ['drive_folder_id', 'drive_connected_email', 'invoice_next_seq', 'sales_return_next_seq', 'schema_version']) delete business[field];
      result[key] = business;
      continue;
    }
    result[key] = value.map((row) => {
      const normalized = normalizeGstSourceRow(GST_SOURCE_STORES[key], row);
      for (const field of GST_HASH_NULL_FIELDS[key] ?? []) normalized[field] ??= null;
      return normalized;
    }).sort((a, b) => String(a.id ?? a.credit_note_invoice_id).localeCompare(String(b.id ?? b.credit_note_invoice_id)));
  }
  return result;
}
const GST_HASH_NULL_FIELDS: Record<string, string[]> = {
  invoiceLines: ['uqc_code', 'goods_or_service', 'taxability', 'cess_rate_bps', 'snapshot_source'],
  purchaseLines: ['uqc_code', 'goods_or_service', 'taxability', 'cess_rate_bps', 'snapshot_source'],
  salesReturnItems: ['uqc_code', 'goods_or_service', 'taxability', 'cess_rate_bps', 'snapshot_source'],
  metadata: ['reporting_period_override', 'original_source_entity_type', 'original_source_entity_id', 'previously_reported_values_json'],
  itcEntries: ['books_tax_paise', 'source_period_key', 'reversal_period_key', 'reclaim_period_key', 'reason', 'reviewed_at', 'reviewed_by_device_id'],
  adjustments: ['tax_period_key', 'report_type', 'adjustment_paise', 'note'],
};
const GST_SOURCE_STORES: Record<string, string> = {
  invoices: 'invoices', invoiceLines: 'invoice_lines', purchases: 'purchases', purchaseLines: 'purchase_lines',
  salesReturns: 'sales_returns', salesReturnItems: 'sales_return_items', originalInvoices: 'invoices',
  customers: 'customers', suppliers: 'suppliers', profiles: 'gst_profiles', aato: 'gst_aato', metadata: 'gst_document_metadata',
  itcEntries: 'gst_itc_ledger', adjustments: 'gst_adjustments', expenses: 'expenses', advances: 'advances', legacyAudits: 'legacy_reversal_audit',
};

export async function hashGstSources(sources: GstMonthlySources, period: GstTaxPeriod, ruleSetVersion: string): Promise<string> {
  return sha256Hex(canonicalJson({ sources: canonicalGstSources(sources), period, ruleSetVersion }));
}

export class GstMonthlyReportService {
  private readonly repository: GstReportingRepository;
  constructor(private readonly db: BusinessVaultDB, private readonly deviceId = 'local',
    private readonly now: () => string = () => new Date().toISOString()) {
    this.repository = new GstReportingRepository(db);
  }

  loadWorkspace(businessId?: string, reviewSourceIds: string[] = []) { return this.repository.loadWorkspace(businessId, reviewSourceIds); }

  async loadSavedReport(businessId: string, runId: string): Promise<MonthlyGstCalculation & { savedReportRunId: string; savedStatus: 'REVIEWED' | 'FINALIZED_WORKING' }> {
    const evidence = await this.db.transaction('r', this.db.gst_report_runs, this.db.gst_report_rows, this.db.attachments, async () => {
      const run = await this.db.gst_report_runs.get(runId);
      if (!run || run.business_id !== businessId || (run.status !== 'REVIEWED' && run.status !== 'FINALIZED_WORKING')) throw new Error('Saved working not found for this business');
      const attachment = run.source_artifact_attachment_id ? await this.db.attachments.get(run.source_artifact_attachment_id) : null;
      if (!attachment || attachment.business_id !== businessId || attachment.ref_id !== runId || attachment.ref_type !== 'gst_report_run' || !attachment.blob) throw new Error('Canonical saved attachment is unavailable; restore the backup before opening');
      const rows = await this.db.gst_report_rows.where('report_run_id').equals(runId).toArray();
      const row = rows.find(value => value.business_id === businessId && value.section_code === 'MONTHLY_GST_PACK');
      if (!row?.payload_json) throw new Error('Saved calculation evidence is missing');
      return { run, attachment, row, savedStatus: run.status };
    });
    const text = await evidence.attachment.blob!.text();
    if (await sha256Hex(text) !== evidence.attachment.checksum) throw new Error('Saved attachment checksum mismatch');
    const envelope = JSON.parse(text);
    const calculation = envelope.calculation as MonthlyGstCalculation;
    if (envelope.schema !== 'businessvault.gst-working.v1' || envelope.status !== evidence.run.status
      || calculation.businessId !== businessId || calculation.period.periodKey !== evidence.run.tax_period_key
      || calculation.sourceDataHash !== evidence.run.source_data_hash || calculation.ruleSetVersion !== evidence.run.rule_set_version
      || canonicalJson(calculation) !== evidence.row.payload_json || canonicalJson(calculation.totals) !== evidence.run.totals_json) throw new Error('Saved working evidence does not match its immutable run');
    return { ...calculation, savedReportRunId: runId, savedStatus: evidence.savedStatus };
  }

  async calculateMonths(businessId: string, periodKeys: string[], filingFrequency: 'MONTHLY' | 'QRMP' = 'MONTHLY'): Promise<MonthlyGstCalculation[]> {
    return this.db.transaction('r', GST_SOURCE_TABLES.map((table) => this.db.table(table)), async (tx) => {
      const business = await this.db.businesses.get(businessId);
      if (!business) throw new Error('Business not found');
      const results: MonthlyGstCalculation[] = [];
      for (const period of selectedMonthPeriods(businessId, business.gstin ?? '', periodKeys, filingFrequency)) {
        const sources = await this.repository.loadMonth(period);
        const result = calculateMonthlyGst(sources, period, this.now());
        result.sourceDataHash = await waitForGstTransaction(hashGstSources(sources, period, result.ruleSetVersion));
        results.push(result);
      }
      return results;
    });
  }

  saveProfile(input: SaveGstProfileInput): Promise<GstProfile> {
    return this.saveSidecar('gst_profile', 'gst_profiles', input, async () => {
      if (input.registration_type !== 'UNREGISTERED' && !isValidGstin(input.gstin)) throw new Error('A valid GSTIN is required');
      if (input.registration_type === 'UNREGISTERED' && input.gstin && !isValidGstin(input.gstin)) throw new Error('Invalid GSTIN');
      const business = await this.db.businesses.get(input.business_id);
      if (input.gstin && business?.gstin !== input.gstin) throw new Error('GSTIN must match this business registration');
      const profiles = await this.db.gst_profiles.where('business_id').equals(input.business_id).toArray();
      if (profiles.some((row) => row.id !== input.id && row.active && input.active &&
          row.effective_from < (input.effective_to ?? '9999-12-31') && input.effective_from < (row.effective_to ?? '9999-12-31'))) throw new Error('Active GST profile periods overlap');
    });
  }

  setAato(input: SetGstAatoInput): Promise<GstAato> {
    return this.saveSidecar('gst_aato', 'gst_aato', input, async () => {
      if (input.aato_paise !== null && (!Number.isSafeInteger(input.aato_paise) || input.aato_paise < 0)) throw new Error('AATO must be nonnegative safe integer paise');
      if (!/^\d{4}-\d{2}$/.test(input.financial_year)) throw new Error('Invalid financial year');
      const duplicates = await this.db.gst_aato.where('[business_id+financial_year]').equals([input.business_id, input.financial_year]).toArray();
      if (duplicates.some((row) => row.id !== input.id)) throw new Error('AATO for this year already exists; update its version');
    });
  }

  saveDocumentMetadata(input: SaveGstDocumentMetadataInput): Promise<GstDocumentMetadata> {
    return this.saveSidecar('gst_document_metadata', 'gst_document_metadata', input, async () => {
      await this.requireSource(input.business_id, input.source_entity_type, input.source_entity_id);
      const duplicates = await this.db.gst_document_metadata.where('[business_id+source_entity_type+source_entity_id]')
        .equals([input.business_id, input.source_entity_type, input.source_entity_id]).toArray();
      if (duplicates.some((row) => row.id !== input.id)) throw new Error('Metadata already exists; update its version');
      if (input.original_source_entity_id) await this.requireSource(input.business_id, input.original_source_entity_type ?? input.source_entity_type, input.original_source_entity_id);
      if (input.ecommerce_operator_gstin && !isValidGstin(input.ecommerce_operator_gstin)) throw new Error('Invalid e-commerce GSTIN');
      if (input.reporting_period_override) selectedMonthPeriods(input.business_id, '', [input.reporting_period_override]);
      if (input.previously_reported_values_json) JSON.parse(input.previously_reported_values_json);
    });
  }

  reviewItc(input: ReviewGstItcInput): Promise<GstItcLedgerEntry> {
    return this.saveSidecar('gst_itc_ledger', 'gst_itc_ledger', input, async () => {
      const source = await this.requireSource(input.business_id, input.source_entity_type, input.source_entity_id);
      selectedMonthPeriods(input.business_id, '', [input.tax_period_key]);
      if (['UNREVIEWED', 'PENDING_REVIEW'].includes(input.status)) throw new Error('Unreviewed tax is implicit; no ledger write is needed');
      for (const key of [input.source_period_key, input.reversal_period_key, input.reclaim_period_key]) {
        if (key) selectedMonthPeriods(input.business_id, '', [key]);
      }
      const existingReviews = await this.db.gst_itc_ledger.where('[business_id+source_entity_type+source_entity_id]')
        .equals([input.business_id, input.source_entity_type, input.source_entity_id]).toArray();
      const samePeriod = existingReviews.filter((row) => row.tax_head === input.tax_head && row.tax_period_key === input.tax_period_key);
      const superseded = new Set(samePeriod.map((row) => row.related_prior_entry_id).filter(Boolean));
      const active = samePeriod.filter((row) => !superseded.has(row.id));
      if (active.length) {
        if (active.length !== 1 || active[0].id !== input.related_prior_entry_id ||
            !['UNREVIEWED', 'PENDING_REVIEW'].includes(active[0].status)) throw new Error('Duplicate ITC review for source, tax head and period');
      } else if (input.related_prior_entry_id && input.status !== 'RECLAIMED') {
        throw new Error('Review supersession must link the unreviewed entry in the same source, head and period');
      }
      for (const [key, value] of Object.entries(input)) {
        if (key.endsWith('_paise') && value != null && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new Error(`${key} must be nonnegative safe integer paise`);
      }
      const reviewed = !['UNREVIEWED', 'PENDING_REVIEW'].includes(input.status);
      if (reviewed) {
        if (!input.category) throw new Error('Reviewed ITC requires an explicit category');
        if (!['PURCHASE', 'PURCHASE_RETURN'].includes(input.source_entity_type)) throw new Error('This source lacks detailed purchase GST evidence');
        const metadata = await this.db.gst_document_metadata.where('[business_id+source_entity_type+source_entity_id]')
          .anyOf([[input.business_id, 'PURCHASE', input.source_entity_id], [input.business_id, 'PURCHASE_RETURN', input.source_entity_id]]).toArray();
        const sourceMeta = metadata.find((row) => row.source_entity_type === 'PURCHASE') ?? metadata[0];
        if (input.category === 'RCM' && sourceMeta?.reverse_charge !== 1 || sourceMeta?.reverse_charge === 1 && input.category !== 'RCM') {
          throw new Error('RCM ITC category must match explicit reverse-charge source metadata');
        }
        if (input.status === 'INELIGIBLE' && !INELIGIBLE_REASONS.some((reason) => reason === input.reason_code)) {
          throw new Error('Ineligible ITC requires a supported legal reason');
        }
        const supplier = await this.db.suppliers.get(String(source.supplier_id));
        if (!supplier || supplier.business_id !== input.business_id || !isValidGstin(supplier.gstin ?? '')) throw new Error('Reviewed ITC requires a valid supplier GSTIN');
        if (source.status === 'draft' || source.status === 'cancelled' || source.replaced_by_purchase_id) throw new Error('Reviewed ITC requires a live posted purchase');
        const booksAmount = Math.abs(Number(source[`${input.tax_head.toLowerCase()}_paise`]));
        if (!Number.isSafeInteger(booksAmount)) throw new Error('Purchase tax is not safe integer paise');
        if (input.status !== 'RECLAIMED' && input.books_tax_paise != null && Math.abs(input.books_tax_paise) !== booksAmount) throw new Error('ITC books tax must match the source tax head');
        for (const value of input.status === 'RECLAIMED' ? [] : [input.original_eligible_paise, input.temporarily_reversed_paise, input.permanently_reversed_paise, input.reclaimable_paise]) {
          if (value != null && value > booksAmount) throw new Error('ITC amount exceeds source tax head');
        }
        const headHistory = existingReviews.filter((row) => row.tax_head === input.tax_head && !['UNREVIEWED', 'PENDING_REVIEW'].includes(row.status));
        const claims = headHistory.filter((row) => ['ELIGIBLE', 'ELIGIBLE_IN_BOOKS'].includes(row.status))
          .reduce((sum, row) => sum + (row.original_eligible_paise ?? row.books_tax_paise ?? 0), 0);
        const reversalHistory = headHistory.filter((row) => ['TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED'].includes(row.status))
          .sort((a, b) => a.tax_period_key.localeCompare(b.tax_period_key) || a.id.localeCompare(b.id));
        // A first reversal may record eligibility and reversal together. Later
        // reversals are movements against that same entitlement, not new claims.
        const entitlement = claims || (reversalHistory[0]?.original_eligible_paise ?? 0);
        const reversed = reversalHistory.reduce((sum, row) => sum + (row.temporarily_reversed_paise ?? 0) + (row.permanently_reversed_paise ?? 0), 0);
        const reclaimed = headHistory.filter((row) => row.status === 'RECLAIMED').reduce((sum, row) => sum + (row.reclaimed_paise ?? 0), 0);
        if (![entitlement, reversed, reclaimed].every((amount) => Number.isSafeInteger(amount) && amount >= 0)) throw new Error('Invalid cumulative ITC history');
        const claimPeriod = input.status === 'RECLAIMED' ? input.reclaim_period_key ?? input.tax_period_key :
          input.reversal_period_key ?? input.tax_period_key;
        const throughPeriod = selectedMonthPeriods(input.business_id, '', [claimPeriod])[0];
        const notes = source.reverses_purchase_id ? [] : await this.db.purchases.where('[business_id+reverses_purchase_id]')
          .equals([input.business_id, input.source_entity_id])
          .filter((row) => row.bill_date < throughPeriod.nextPeriodStart && ['received', 'partial', 'paid'].includes(row.status)).toArray();
        const taxKey = `${input.tax_head.toLowerCase()}_paise` as 'igst_paise' | 'cgst_paise' | 'sgst_paise' | 'cess_paise';
        const returnedTax = notes.reduce((sum, row) => sum + Math.abs(row[taxKey]), 0);
        const noteReviews = notes.length ? await this.db.gst_itc_ledger.where('[business_id+source_entity_type+source_entity_id]')
          .anyOf(notes.flatMap((row) => [[input.business_id, 'PURCHASE', row.id], [input.business_id, 'PURCHASE_RETURN', row.id]])).toArray() : [];
        const approvedReturns = noteReviews.filter((row) => row.tax_head === input.tax_head && row.tax_period_key <= claimPeriod
          && ['ELIGIBLE', 'ELIGIBLE_IN_BOOKS'].includes(row.status) && row.category && (row.reviewed_at || row.user_confirmation === 1))
          .reduce((sum, row) => sum + (row.original_eligible_paise ?? row.books_tax_paise ?? 0), 0);
        if (![returnedTax, approvedReturns].every((amount) => Number.isSafeInteger(amount) && amount >= 0) || returnedTax > booksAmount) throw new Error('Invalid cumulative purchase-return ITC history');
        const ceiling = Math.max(0, booksAmount - returnedTax);
        const available = Math.max(0, Math.min(ceiling, entitlement - reversed + reclaimed - approvedReturns));
        if (['ELIGIBLE', 'ELIGIBLE_IN_BOOKS'].includes(input.status) && entitlement + (input.original_eligible_paise ?? booksAmount) > ceiling) {
          throw new Error('Cumulative ITC claim exceeds remaining source entitlement');
        }
        if (['TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED'].includes(input.status)) {
          const reversalAvailable = entitlement ? available : Math.max(0, Math.min(ceiling, (input.original_eligible_paise ?? booksAmount) - reversed + reclaimed - approvedReturns));
          const movement = (input.temporarily_reversed_paise ?? 0) + (input.permanently_reversed_paise ?? 0);
          if (movement <= 0 || movement > reversalAvailable) throw new Error('Cumulative ITC reversal exceeds remaining claimed entitlement');
        }
        if (input.status === 'RECLAIMED' && returnedTax > 0) {
          let returnedReversal = Math.max(0, entitlement - ceiling);
          let priorRemaining = 0;
          for (const reversal of reversalHistory) {
            if (reversal.status !== 'TEMPORARILY_REVERSED') continue;
            const priorReclaims = headHistory.filter((row) => row.status === 'RECLAIMED' && row.related_prior_entry_id === reversal.id)
              .reduce((sum, row) => sum + (row.reclaimed_paise ?? 0), 0);
            const outstanding = Math.max(0, (reversal.temporarily_reversed_paise ?? 0) - priorReclaims);
            const consumed = Math.min(returnedReversal, outstanding);
            returnedReversal -= consumed;
            if (reversal.id === input.related_prior_entry_id) {
              priorRemaining = Math.max(0, outstanding - consumed);
            }
          }
          if ((input.reclaimed_paise ?? 0) > Math.min(priorRemaining, Math.max(0, ceiling - available))) {
            throw new Error('Reclaim exceeds remaining balance after purchase returns');
          }
        }
      }
      if (input.status === 'RECLAIMED') {
        if (!input.related_prior_entry_id || input.id === input.related_prior_entry_id) throw new Error('Reclaim requires a prior temporary reversal');
        const prior = await this.db.gst_itc_ledger.get(input.related_prior_entry_id);
        if (!prior || prior.business_id !== input.business_id || prior.tax_head !== input.tax_head ||
            prior.source_entity_type !== input.source_entity_type || prior.source_entity_id !== input.source_entity_id ||
            prior.status !== 'TEMPORARILY_REVERSED' || (prior.reversal_period_key ?? prior.tax_period_key) >= (input.reclaim_period_key ?? input.tax_period_key)) throw new Error('Reclaim must link an earlier temporary reversal of the same tax head and source');
        const entries = await this.db.gst_itc_ledger.where('[business_id+source_entity_type+source_entity_id]')
          .equals([input.business_id, input.source_entity_type, input.source_entity_id]).toArray();
        const already = entries.filter((row) => row.id !== input.id && row.status === 'RECLAIMED' && row.related_prior_entry_id === prior.id)
          .reduce((sum, row) => sum + (row.reclaimed_paise ?? 0), 0);
        if (!Number.isSafeInteger(prior.temporarily_reversed_paise) || (prior.temporarily_reversed_paise ?? 0) < 0 ||
            (prior.reclaimable_paise != null && (!Number.isSafeInteger(prior.reclaimable_paise) || prior.reclaimable_paise < 0))) throw new Error('Prior reversal amount is invalid');
        const remaining = Math.min(prior.temporarily_reversed_paise ?? 0, prior.reclaimable_paise ?? prior.temporarily_reversed_paise ?? 0) - already;
        if (!Number.isSafeInteger(already) || (input.reclaimed_paise ?? 0) <= 0 || (input.reclaimed_paise ?? 0) > remaining) throw new Error('Reclaim exceeds remaining balance');
      }
    }, ['purchases', 'expenses', 'advances', 'invoices', 'sales_returns', 'suppliers', 'gst_document_metadata'], true);
  }

  addAdjustment(input: AddGstAdjustmentInput): Promise<GstAdjustment> {
    return this.saveSidecar('gst_adjustment', 'gst_adjustments', input, async () => {
      if (!input.tax_period_key) throw new Error('Adjustment tax period is required');
      selectedMonthPeriods(input.business_id, '', [input.tax_period_key]);
      if (!Number.isSafeInteger(input.adjustment_paise) || !input.reason.trim()) throw new Error('Adjustment requires safe integer paise and a reason');
      if (input.report_run_id) {
        const run = await this.db.gst_report_runs.get(input.report_run_id);
        if (!run || run.business_id !== input.business_id || ['REVIEWED', 'FINALIZED_WORKING', 'FINALIZED'].includes(run.status)) throw new Error('Saved reviewed/finalized working is immutable');
        if (run.tax_period_key !== input.tax_period_key) throw new Error('Adjustment period differs from report');
      }
      if (input.supporting_attachment_id) {
        const attachment = await this.db.attachments.get(input.supporting_attachment_id);
        if (!attachment || attachment.business_id !== input.business_id) throw new Error('Supporting attachment belongs to another business');
      }
      const business = (await this.db.businesses.get(input.business_id))!;
      const profiles = await this.db.gst_profiles.where('[business_id+active]').equals([input.business_id, 1]).toArray();
      const frequency = profiles.find((row) => row.effective_from <= `${input.tax_period_key}-01` &&
        (!row.effective_to || row.effective_to > `${input.tax_period_key}-01`))?.filing_frequency ?? 'MONTHLY';
      const period = selectedMonthPeriods(input.business_id, business.gstin ?? '', [input.tax_period_key], frequency)[0];
      const live = calculateMonthlyGst(await this.repository.loadMonth(period), period, this.now());
      const measure = `${input.tax_head.toLowerCase()}_paise`;
      const target = live.gstr3bSections.fields.find((row) => row.table_code === input.table_code && row.measure === measure);
      if (input.report_type !== 'GSTR3B_DRAFT' || !target) throw new Error('Unsupported adjustment report/table/tax-head pair');
      if (!Number.isSafeInteger(target.ca_adjustment_paise + input.adjustment_paise!) ||
          !Number.isSafeInteger((target.final_working_paise ?? 0) + input.adjustment_paise!)) throw new Error('Adjustment exceeds safe working amount');
    }, [...GST_SOURCE_TABLES, 'gst_report_runs', 'attachments'], true);
  }

  async saveReport(calculation: MonthlyGstCalculation, status: 'REVIEWED' | 'FINALIZED_WORKING'): Promise<GstReportRun> {
    if (!['REVIEWED', 'FINALIZED_WORKING'].includes(status)) throw new Error('Invalid working status');
    const period = calculation.period;
    if (!validateTaxPeriod(period) || calculation.businessId !== period.businessId) throw new Error('Invalid GST tax period');
    const tables = [...GST_SOURCE_TABLES, 'gst_report_runs', 'gst_report_rows', 'attachments', 'audit_log', 'sync_events', 'sync_queue'];
    return this.db.transaction('rw', tables.map((table) => this.db.table(table)), async (tx) => {
      const sources = await this.repository.loadMonth(period);
      if (sources.business.gstin !== period.gstinSnapshot || !isValidGstin(period.gstinSnapshot)) throw new Error('Invalid or changed business GSTIN');
      const live = calculateMonthlyGst(sources, period, calculation.generatedAt);
      live.sourceDataHash = await waitForGstTransaction(hashGstSources(sources, period, live.ruleSetVersion));
      if (live.sourceDataHash !== calculation.sourceDataHash || live.ruleSetVersion !== calculation.ruleSetVersion) throw new Error('GST sources changed; recalculate before saving');
      if (live.issues.some((issue) => issue.severity === 'BLOCKING_ERROR') || live.reconciliations.some((row) => row.status === 'ERROR' || Object.values(row.variance).some((value) => value !== 0))) throw new Error('Blocking GST issues or reconciliation prevent review/finalization');
      if (live.status !== 'READY_FOR_CA_REVIEW') throw new Error('GST working is not READY_FOR_CA_REVIEW; nil periods require explicit completeness confirmation');
      const now = this.now();
      const id = ulid();
      const attachmentId = ulid();
      const json = canonicalJson({ schema: 'businessvault.gst-working.v1', disclaimer: 'Books-based working only. Not proof of filing or a GSTN upload file.', status, calculation: live });
      const checksum = await waitForGstTransaction(sha256Hex(json));
      const blob = new Blob([json], { type: 'application/json' });
      const attachment: Attachment = { id: attachmentId, business_id: period.businessId, ref_type: 'gst_report_run', ref_id: id,
        filename: 'working.json', mime_type: 'application/json', size_bytes: blob.size, checksum, blob, drive_file_id: null,
        logical_path: `attachments/gst/report-runs/${id}/working.json`, created_at: now, updated_at: now };
      const prior = await this.db.gst_report_runs.where('[business_id+report_type+tax_period_key]').equals([period.businessId, 'MONTHLY_GST_PACK', period.periodKey]).toArray();
      const run: GstReportRun = { id, business_id: period.businessId, gstin_snapshot: live.gstinSnapshot,
        report_type: 'MONTHLY_GST_PACK', financial_year: period.financialYear, tax_period_key: period.periodKey,
        period_start: period.periodStart, period_end: new Date(Date.parse(`${period.nextPeriodStart}T00:00:00Z`) - 86400000).toISOString().slice(0, 10),
        next_period_start: period.nextPeriodStart, period_type: period.periodType, report_schema_version: live.schemaVersion,
        filing_frequency: period.filingFrequency, rule_set_version: live.ruleSetVersion, status, generated_at: live.generatedAt,
        generated_by_device_id: this.deviceId, source_data_hash: live.sourceDataHash, source_artifact_attachment_id: attachmentId,
        imported_file_hash: null, totals_json: canonicalJson(live.totals), reviewed_at: now,
        finalized_at: status === 'FINALIZED_WORKING' ? now : null, filed_at: null, arn: null, filing_acknowledgment_attachment_id: null,
        supersedes_report_run_id: prior.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.id ?? null,
        created_at: now, updated_at: now, entity_version: 1 };
      const rows: GstReportRow[] = [{ id: ulid(), business_id: period.businessId, report_run_id: id,
        section_code: 'MONTHLY_GST_PACK', row_key: period.periodKey, source_entity_type: null, source_entity_id: null,
        source_entity_version: null, classification_reason: null, taxable_paise: null, igst_paise: null, cgst_paise: null,
        sgst_paise: null, cess_paise: null, invoice_value_paise: null, quantity_micros: null,
        payload_json: canonicalJson(live), created_at: now, updated_at: now, entity_version: 1 }];
      const audit = this.audit('gst_report_run', run, null, now);
      await this.db.gst_report_runs.add(run);
      await this.db.gst_report_rows.bulkAdd(rows);
      await this.db.attachments.add(attachment);
      await this.db.audit_log.add(audit);
      await this.db.sync_queue.add({ id: ulid(), business_id: period.businessId, kind: 'attachment_upload', payload: { attachmentId },
        status: 'pending', attempts: 0, max_attempts: 12, next_attempt_at: now, last_error: null, created_at: now, updated_at: now });
      await appendSyncEvent(this.db, { businessId: period.businessId, deviceId: this.deviceId, entityType: 'gst_report_run', entityId: id,
        operation: 'created', entityVersion: 1, timestamp: now, payload: { row: run, rows, audit, attachment: { ...attachment, blob: null } } });
      return run;
    });
  }

  private async requireSource(businessId: string, type: GstSourceEntityType, id: string): Promise<Record<string, unknown>> {
    const store = { INVOICE: 'invoices', SALES_RETURN: 'sales_returns', PURCHASE: 'purchases', PURCHASE_RETURN: 'purchases', EXPENSE: 'expenses', ADVANCE: 'advances', GST_NOTE: '' }[type];
    if (!store) throw new Error('Unsupported GST source');
    const row = await this.db.table(store).get(id);
    if (!row || row.business_id !== businessId) throw new Error('GST source belongs to another business or is missing');
    return row;
  }

  private audit(type: string, row: { id: string; business_id: string }, before: unknown, now: string) {
    return { id: ulid(), business_id: row.business_id, device_id: this.deviceId, actor: `device:${this.deviceId}`,
      action: `${type}.saved`, entity_type: type, entity_id: row.id, before, after: row, at: now };
  }

  private async saveSidecar<T extends { id: string; business_id: string; created_at: string; updated_at: string; entity_version: number }>(
    type: string, store: string, input: Editable<T>, validate: () => Promise<void>, extra: string[] = [], immutable = false,
  ): Promise<T> {
    const tables = [...new Set(['businesses', store, 'audit_log', 'sync_events', ...extra,
      ...(type === 'gst_document_metadata' ? ['invoices', 'purchases', 'sales_returns', 'expenses', 'advances'] : [])])];
    return this.db.transaction('rw', tables.map((table) => this.db.table(table)), async () => {
      if (!await this.db.businesses.get(input.business_id)) throw new Error('Business not found');
      const table = this.db.table(store);
      const previous = input.id ? await table.get(input.id) : undefined;
      if (input.id && !previous) throw new Error('GST row not found');
      if (previous && (previous.business_id !== input.business_id || immutable)) throw new Error('GST row is immutable or belongs to another business');
      if (previous && input.expectedVersion !== previous.entity_version) throw new Error('Stale GST entity version');
      await validate();
      const { expectedVersion: _expected, ...values } = input;
      const now = this.now();
      const row = { ...values, id: input.id ?? ulid(), created_at: previous?.created_at ?? now, updated_at: now,
        entity_version: (previous?.entity_version ?? 0) + 1,
        ...(type === 'gst_itc_ledger' ? { reviewed_at: now, reviewed_by_device_id: this.deviceId } : {}) } as T;
      await table.put(row);
      const audit = this.audit(type, row, previous ?? null, now);
      await this.db.audit_log.add(audit);
      await appendSyncEvent(this.db, { businessId: input.business_id, deviceId: this.deviceId, entityType: type, entityId: row.id,
        operation: previous ? 'updated' : 'created', entityVersion: row.entity_version, timestamp: now, payload: { row, audit } });
      return row;
    });
  }
}
