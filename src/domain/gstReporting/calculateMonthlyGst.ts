import type { GstDocumentMetadata, GstNote, GstNoteLine, Invoice, InvoiceLine, Purchase, PurchaseLine, SalesReturn, SalesReturnItem } from '../../db/types';
import { isValidGstin, isValidStateCode } from '../../lib/gst';
import { inwardNoteEvidence } from '../../db/repos/gstReporting';
import { buildDocumentSeries } from './documentSeries';
import { dateInPeriod, financialYearForDate, isDateOnly, monthPeriod, precedingFinancialYear, validateTaxPeriod } from './periods';
import { GST_RULE_SET_VERSION, minimumHsnDigits, rulesForDate } from './rules';
import type {
  BooksItcRow, BooksItcStatus, GstAmountKey, GstAmounts, GstClassification,
  GstMonthlySources, GstReconciliationResult, GstSourceManifestEntry, GstSummary,
  GstTaxHead, GstTaxPeriod, GstValidationIssue, Gstr3bWorkingField,
  MonthlyGstCalculation, NormalizedGstDocument, NormalizedGstRateRow, NormalizedHsnRow,
  GstPreviouslyReportedValues,
  GstB2csAggregate,
  GstAdvanceOffset,
} from './types';

export type { GstMonthlySources } from './types';

const amountKeys: GstAmountKey[] = ['taxable_paise', 'igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise', 'pre_round_total_paise', 'round_off_paise', 'total_paise'];
const taxKeys = ['igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise'] as const;
const taxHeads: GstTaxHead[] = ['IGST', 'CGST', 'SGST', 'CESS'];
const statuses: BooksItcStatus[] = ['UNREVIEWED', 'ELIGIBLE_IN_BOOKS', 'INELIGIBLE', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED', 'RECLAIMABLE', 'RECLAIMED'];
const unclassified = (category: GstClassification) => category.startsWith('UNCLASSIFIED');
const emptyAmounts = (): GstAmounts => ({ taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0, pre_round_total_paise: 0, round_off_paise: 0, total_paise: 0 });
type Header = Invoice | Purchase | SalesReturn | GstNote;
type Line = InvoiceLine | PurchaseLine | SalesReturnItem | GstNoteLine;

/** Synchronous, local-only calculation. The service hashes sourceManifest with rules/period. */
export function calculateMonthlyGst(sources: GstMonthlySources, period: GstTaxPeriod, generatedAt: string): MonthlyGstCalculation {
  const issues: GstValidationIssue[] = [];
  const manifest = new Map<string, GstSourceManifestEntry>();
  const businessId = period.businessId;
  const periodContainsKey = (key: string) => key >= period.periodStart.slice(0, 7) && key < period.nextPeriodStart.slice(0, 7);
  const throughPeriodKey = period.periodType === 'MONTH' ? period.periodKey : (() => {
    const end = new Date(`${period.nextPeriodStart}T00:00:00Z`); end.setUTCDate(0); return end.toISOString().slice(0, 7);
  })();
  function issue(code: string, severity: GstValidationIssue['severity'], type: string, id: string,
    message: string, field: string | null = null, number: string | null = null, impact: Partial<GstAmounts> | null = null) {
    issues.push({ code, severity, tax_period_key: period.periodKey, source_entity_type: type,
      source_entity_id: id, document_number: number, field, message,
      recommended_correction: severity === 'INFORMATION' ? 'No correction required.' : 'Review the source snapshot or capture explicit GST metadata; recalculate before CA review.', amount_impact: impact });
  }
  function remember(type: string, id: string, content: unknown, version = 0, date: string | null = null,
    effect: GstSourceManifestEntry['report_effect'] = 'CONTEXT', metadataVersion: number | null = null) {
    manifest.set(`${type}:${id}`, { entity_type: type, entity_id: id, entity_version: version,
      document_date: date, report_effect: effect, metadata_version: metadataVersion, content: structuredClone(content) });
  }
  function add(target: GstAmounts, value: Partial<GstAmounts>, context = 'AGGREGATE') {
    for (const key of amountKeys) {
      const sum = target[key] + (value[key] ?? 0);
      if (!Number.isSafeInteger(sum)) {
        issue('UNSAFE_AGGREGATE', 'BLOCKING_ERROR', 'REPORT', context, `Unsafe integer aggregate for ${key}.`, key);
        // Never emit a plausible zero after an unsafe calculation failure.
        target[key] = Number.NaN;
      } else target[key] = sum;
    }
  }
  function sum(rows: Partial<GstAmounts>[]): GstAmounts {
    const result = emptyAmounts();
    for (const row of rows) add(result, row);
    return result;
  }
  function indexed<T extends { id: string; business_id: string }>(rows: T[], type: string): Map<string, T> {
    const result = new Map<string, T>();
    for (const row of rows) {
      if ('business_id' in row && row.business_id !== businessId) continue;
      if (result.has(row.id)) issue('DUPLICATE_SOURCE_ID', 'BLOCKING_ERROR', type, row.id, 'Duplicate source identity supplied.');
      else result.set(row.id, row);
    }
    return result;
  }
  function lineIndex(rows: Line[], parent: 'invoice_id' | 'purchase_id' | 'sales_return_id') {
    const result = new Map<string, Line[]>();
    const ids = new Set<string>();
    for (const row of rows) {
      if ('business_id' in row && row.business_id !== businessId) continue;
      const id = (row as unknown as Record<string, string>)[parent];
      if (ids.has(row.id)) { issue('DUPLICATE_LINE_ID', 'BLOCKING_ERROR', parent, row.id, 'Duplicate line excluded.'); continue; }
      ids.add(row.id);
      const lines = result.get(id) ?? [];
      lines.push(row); result.set(id, lines);
    }
    for (const lines of result.values()) lines.sort((a, b) => a.line_no - b.line_no || a.id.localeCompare(b.id));
    return result;
  }
  remember('BUSINESS', sources.business.id, sources.business, sources.business.entity_version);
  if (sources.business.id !== businessId || !validateTaxPeriod(period)) {
    issue('INVALID_PERIOD_SCOPE', 'BLOCKING_ERROR', 'BUSINESS', businessId, 'Business or canonical tax period is inconsistent.');
  }
  if (!isValidGstin(period.gstinSnapshot) || period.gstinSnapshot.toUpperCase() !== sources.business.gstin?.toUpperCase()) {
    issue('INVALID_BUSINESS_GSTIN', 'BLOCKING_ERROR', 'BUSINESS', businessId, 'GSTIN is invalid or does not match the selected registration.');
  }
  const profiles = sources.profiles.filter(p => p.business_id === businessId && p.active && p.effective_from < period.nextPeriodStart && (!p.effective_to || p.effective_to > period.periodStart));
  for (const profile of profiles) remember('GST_PROFILE', profile.id, profile, profile.entity_version);
  if (profiles.length !== 1 || profiles[0].registration_type !== 'REGULAR' || !profiles[0].gst_reporting_enabled
    || profiles[0].gstin.toUpperCase() !== period.gstinSnapshot.toUpperCase()
    || profiles[0].filing_frequency !== period.filingFrequency
    || profiles[0].effective_from > period.periodStart || (profiles[0].effective_to && profiles[0].effective_to < period.nextPeriodStart)
    || (profiles[0].registration_start_date && profiles[0].registration_start_date > period.periodStart)
    || (profiles[0].registration_end_date && profiles[0].registration_end_date < period.nextPeriodStart)) {
    issue('GST_PROFILE_NOT_READY', 'BLOCKING_ERROR', 'BUSINESS', businessId, 'One enabled regular GST profile must cover the complete period and match the GSTIN/frequency.');
  }
  let previousYear = '';
  try { previousYear = precedingFinancialYear(period.financialYear); } catch { /* Invalid period is already blocking. */ }
  const aatoRows = sources.aato.filter(a => a.business_id === businessId && a.financial_year === previousYear);
  for (const row of aatoRows) remember('GST_AATO', row.id, row, row.entity_version);
  const hsnMinimum = aatoRows.length === 1 && aatoRows[0].confirmed_at ? minimumHsnDigits(aatoRows[0].aato_paise, period.periodStart) : null;
  if (hsnMinimum === null) issue('AATO_UNKNOWN', 'BLOCKING_ERROR', 'BUSINESS', businessId, 'Confirmed preceding-financial-year AATO is required; no HSN minimum has been guessed.');
  if (period.periodStart < '2021-04-01') issue('HISTORICAL_HSN_RULE_UNSUPPORTED', 'BLOCKING_ERROR', 'REPORT', period.periodKey, 'Pre-April-2021 HSN requirements are not modeled; the later minimum is not applied retroactively.');
  if (hsnMinimum !== null && aatoRows[0]?.source === 'USER_CONFIRMED') issue('AATO_USER_CONFIRMED', 'WARNING', 'GST_AATO', aatoRows[0].id, 'AATO is user-confirmed, not independently verified.');
  const rules = rulesForDate(period.periodStart);
  if (!rules) issue('RULE_NOT_AVAILABLE', 'BLOCKING_ERROR', 'REPORT', period.periodKey, 'No rule set covers this period.');
  issue('RULE_SET', 'INFORMATION', 'REPORT', period.periodKey, GST_RULE_SET_VERSION);

  const customers = indexed(sources.customers, 'CUSTOMER');
  const currentItems = new Map((sources.currentItems ?? []).filter(row => row.business_id === businessId).map(row => [row.id, row]));
  const currentUnits = new Map((sources.currentUnits ?? []).filter(row => row.business_id === businessId).map(row => [row.id, row]));
  const suppliers = indexed(sources.suppliers, 'SUPPLIER');
  const invoices = indexed(sources.invoices, 'INVOICE');
  const originals = indexed(sources.originalInvoices, 'INVOICE');
  for (const [id, invoice] of invoices) originals.set(id, invoice);
  const purchases = indexed(sources.purchases, 'PURCHASE');
  const returns = indexed(sources.salesReturns, 'SALES_RETURN');
  const invoiceLines = lineIndex(sources.invoiceLines, 'invoice_id');
  const purchaseLines = lineIndex(sources.purchaseLines, 'purchase_id');
  const returnLines = lineIndex(sources.salesReturnItems, 'sales_return_id');
  const metadata = new Map<string, GstDocumentMetadata>();
  for (const row of sources.metadata) {
    if (row.business_id !== businessId) continue;
    const key = `${row.source_entity_type}:${row.source_entity_id}`;
    if (metadata.has(key)) issue('DUPLICATE_METADATA', 'BLOCKING_ERROR', row.source_entity_type, row.source_entity_id, 'Multiple metadata rows for one source.');
    else metadata.set(key, row);
  }
  const auditMap = new Map(sources.legacyAudits.filter(a => a.business_id === businessId).map(a => [a.credit_note_invoice_id, a]));
  // Full native-return cancellation is a stock/settlement state, not a GST void.
  const returnedQuantities = new Map<string, Map<string, number>>();
  const returnEvidence = new Map<string, SalesReturn[]>();
  for (const row of returns.values()) {
    if (row.status !== 'posted' || row.deleted_at || row.legacy_migration_classification) continue;
    const quantities = returnedQuantities.get(row.original_invoice_id) ?? new Map<string, number>();
    for (const line of returnLines.get(row.id) ?? []) {
      const item = line as SalesReturnItem;
      if (Number.isSafeInteger(item.qty_micros) && item.qty_micros > 0) quantities.set(item.original_invoice_line_id, (quantities.get(item.original_invoice_line_id) ?? 0) + item.qty_micros);
    }
    returnedQuantities.set(row.original_invoice_id, quantities);
    const evidence = returnEvidence.get(row.original_invoice_id) ?? [];
    evidence.push(row); returnEvidence.set(row.original_invoice_id, evidence);
  }
  const outwardDocuments: NormalizedGstDocument[] = [], inwardDocuments: NormalizedGstDocument[] = [];
  const outwardRateRows: NormalizedGstRateRow[] = [], inwardRateRows: NormalizedGstRateRow[] = [];
  const outwardHsn = new Map<string, NormalizedHsnRow>(), inwardHsn = new Map<string, NormalizedHsnRow>();
  const hsnSources = new Map<NormalizedHsnRow, Set<string>>();
  const hsnLineContributions: Array<{ document: NormalizedGstDocument; source: Line; amounts: GstAmounts; taxability: string; quantity: number }> = [];
  const duplicateKeys = new Map<string, NormalizedGstDocument[]>();

  function normalize(header: Header, type: NormalizedGstDocument['source_entity_type'], lines: Line[],
    date: string, number: string, partyId: string, pos: string, interstate: number,
    sign: 1 | -1, exclusion: string | null, cancelled: boolean, original: Invoice | Purchase | null = null) {
    const outward = type === 'INVOICE' || type === 'SALES_RETURN' || type === 'ADVANCE' || type === 'GST_NOTE' && 'direction' in header && header.direction === 'OUTWARD';
    const ownMeta = metadata.get(`${type}:${header.id}`) ?? (type === 'PURCHASE_RETURN' ? metadata.get(`PURCHASE:${header.id}`) : undefined);
    const originalMeta = original && type === 'SALES_RETURN' ? metadata.get(`INVOICE:${original.id}`) : undefined;
    // Inherit only classification evidence, never the original invoice's identity or reporting period.
    const meta = originalMeta ? { ...originalMeta, ...ownMeta,
      document_type: ownMeta?.document_type ?? 'CREDIT_NOTE',
      reporting_period_override: ownMeta?.reporting_period_override ?? null,
      amendment_kind: ownMeta?.amendment_kind ?? null,
      previously_reported_values_json: ownMeta?.previously_reported_values_json ?? null,
      original_return_period: ownMeta?.original_return_period ?? null,
      original_document_number: ownMeta?.original_document_number ?? null,
      original_source_entity_id: ownMeta?.original_source_entity_id ?? original!.id,
    } : ownMeta;
    const reportingOverride = meta?.reporting_period_override;
    if (!isDateOnly(date)) {
      issue('INVALID_DOCUMENT_DATE', 'BLOCKING_ERROR', type, header.id, 'Source date must be a valid date-only YYYY-MM-DD.', 'document_date', number);
      return;
    }
    if (reportingOverride) {
      try { monthPeriod(businessId, period.gstinSnapshot, reportingOverride); }
      catch { issue('INVALID_REPORTING_PERIOD', 'BLOCKING_ERROR', type, header.id, 'Reporting-period override must be a valid YYYY-MM tax month.'); return; }
      if (!periodContainsKey(reportingOverride)) return;
    } else if (!dateInPeriod(date, period)) return;
    const party = outward ? customers.get(partyId) : suppliers.get(partyId);
    if (party) remember(outward ? 'CUSTOMER' : 'SUPPLIER', party.id, party, party.entity_version);
    if (original) remember(outward ? 'ORIGINAL_INVOICE' : 'ORIGINAL_PURCHASE', original.id, original, original.entity_version);
    if (ownMeta) remember('GST_DOCUMENT_METADATA', ownMeta.id, ownMeta, ownMeta.entity_version);
    if (originalMeta) remember('GST_DOCUMENT_METADATA', originalMeta.id, originalMeta, originalMeta.entity_version);
    const gstin = meta?.recipient_category === 'UIN' ? meta.recipient_uin?.trim().toUpperCase() ?? '' : party?.gstin?.trim().toUpperCase() ?? '';
    const position = meta?.place_of_supply_state_code ?? pos;
    const document: NormalizedGstDocument = { ...emptyAmounts(), source_entity_type: type, source_entity_id: header.id,
      source_entity_version: header.entity_version, tax_period_key: period.periodKey,
      document_type: meta?.document_type ?? (sign < 0 ? 'CREDIT_NOTE' : 'TAX_INVOICE'),
      document_number: number, document_date: date, party_id: partyId, party_name: party?.name ?? '', party_gstin: gstin,
      recipient_category: meta?.recipient_category ?? (gstin ? 'REGISTERED' : 'UNREGISTERED'), place_of_supply: position,
      is_interstate: interstate === 1, classification: 'UNCLASSIFIED', effect_sign: sign,
      included: exclusion === null, exclusion_reason: exclusion, cancelled,
      original_source_entity_id: meta?.original_source_entity_id ?? original?.id ?? null,
      original_document_number: meta?.original_document_number ?? (original && ('invoice_number' in original ? original.invoice_number : original.bill_number)) ?? null,
      original_period_key: meta?.original_return_period ?? (original ? ('invoice_date' in original ? original.invoice_date : original.bill_date).slice(0, 7) : null),
      amendment_kind: meta?.amendment_kind ?? null, ecommerce_operator_gstin: meta?.ecommerce_operator_gstin ?? null,
      reverse_charge: meta?.reverse_charge === 1, line_count: lines.length };
    document.direction = outward ? 'OUTWARD' : 'INWARD';
    document.iff_reported_period = meta?.iff_reported_period ?? null;
    if ('original_source_entity_id' in header) document.original_source_entity_id ??= header.original_source_entity_id ?? null;
    if (type === 'GST_NOTE' && 'note_type' in header) document.document_type = header.note_type;
    Object.assign(document, { shipping_bill_number: meta?.shipping_bill_number ?? null, shipping_bill_date: meta?.shipping_bill_date ?? null,
      port_code: meta?.port_code ?? null, section_9_5_role: meta?.section_9_5_role ?? null,
      section_52_tcs: meta?.section_52_tcs ?? null, ecommerce_reporting_type: meta?.ecommerce_reporting_type ?? null });
    (outward ? outwardDocuments : inwardDocuments).push(document);
    remember(type, header.id, { header, lines, metadata: meta ?? null }, header.entity_version, date,
      exclusion ? 'EXCLUDED' : 'INCLUDED', meta?.entity_version ?? null);
    if (exclusion) return;
    if (!party) issue('MISSING_PARTY', 'BLOCKING_ERROR', type, header.id, 'Counterparty record is missing or belongs to another business.', 'party_id', number);
    if (!number) issue('MISSING_DOCUMENT_NUMBER', 'BLOCKING_ERROR', type, header.id, 'Canonical document number is required.', 'document_number');
    if (!lines.length) issue('MISSING_LINE_DATA', 'BLOCKING_ERROR', type, header.id, 'Rate/HSN allocation cannot be inferred from a document header.', null, number);
    let unsafe = false;
    let invalidAmounts = false;
    for (const key of amountKeys) {
      const value = header[key];
      if (!Number.isSafeInteger(value)) { unsafe = true; issue('UNSAFE_MONEY', 'BLOCKING_ERROR', type, header.id, `Invalid integer paise: ${key}.`, key, number); continue; }
      if (key !== 'round_off_paise' && value < 0 && sign > 0) {
        invalidAmounts = true;
        issue('UNEXPECTED_NEGATIVE_AMOUNT', 'BLOCKING_ERROR', type, header.id, 'Positive document has a negative monetary component.', key, number);
      }
      // Credit/debit notes carry their own historic sign in some legacy rows.
      // Only positive documents are forbidden from repairing a negative value.
      document[key] = key === 'round_off_paise'
        ? sign * (header.total_paise < 0 ? -value : value)
        : sign < 0 ? sign * Math.abs(value) : value;
    }
    if (sign < 0 && header.total_paise < 0) issue('LEGACY_NEGATIVE_NOTE', 'WARNING', type, header.id, 'Negative legacy note normalized once by document meaning.', null, number);
    if (unsafe || invalidAmounts) { document.included = false; document.exclusion_reason = unsafe ? 'UNSAFE_MONEY' : 'INVALID_POSITIVE_AMOUNT'; return; }
    const rawTaxSum = header.taxable_paise + header.igst_paise + header.cgst_paise + header.sgst_paise + header.cess_paise;
    if (rawTaxSum !== header.pre_round_total_paise || header.pre_round_total_paise + header.round_off_paise !== header.total_paise) {
      issue('HEADER_TOTAL_MISMATCH', 'BLOCKING_ERROR', type, header.id, 'Persisted pre-round or total/round-off invariant does not match.', null, number);
      document.included = false; document.exclusion_reason = 'HEADER_TOTAL_MISMATCH';
    }
    if (gstin && document.recipient_category !== 'UIN' && !isValidGstin(gstin)) {
      document.classification = 'UNCLASSIFIED_INVALID_GSTIN';
      issue('INVALID_PARTY_GSTIN', 'BLOCKING_ERROR', type, header.id, 'Non-empty invalid GSTIN cannot be treated as unregistered or approved for ITC.', 'party_gstin', number);
    }
    const special = meta?.supply_category;
    const overseas = special === 'EXPORT_WITH_PAYMENT' || special === 'EXPORT_WITHOUT_PAYMENT';
    const sez = special === 'SEZ_WITH_PAYMENT' || special === 'SEZ_WITHOUT_PAYMENT';
    let classification: GstClassification = gstin ? 'B2B' : 'B2CS';
    let unsupported = false;
    if (type === 'GST_NOTE' && outward && sign < 0 && gstin && document.recipient_category !== 'UIN' && gstin === period.gstinSnapshot.toUpperCase()) {
      unsupported = true;
      issue('POSSIBLE_SELF_GSTIN_TRANSACTION', 'BLOCKING_ERROR', type, header.id, 'Counterparty GSTIN matches the selected business GSTIN; review the party assignment or source mapping.', 'party_gstin', number);
    }
    const compatibleType = type === 'ADVANCE' ? ['RECEIPT_VOUCHER', 'ADVANCE_ADJUSTMENT'].includes(document.document_type) : type === 'SALES_RETURN' || type === 'PURCHASE_RETURN'
      ? document.document_type === 'CREDIT_NOTE'
      : ['TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(document.document_type);
    if (!compatibleType || document.document_type === 'CREDIT_NOTE' && sign !== -1) {
      unsupported = true; issue('UNSUPPORTED_DOCUMENT_TYPE', 'BLOCKING_ERROR', type, header.id, 'Document type is incompatible with this source and cannot be classified as an ordinary invoice.', 'document_type', number);
    }
    if (meta?.recipient_category === 'SEZ' && !sez) {
      unsupported = true; issue('SEZ_CLASSIFICATION_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'SEZ recipient requires explicit SEZ with/without-payment supply classification.', null, number);
    }
    if (originalMeta && ownMeta && (
      ownMeta.supply_category != null && ownMeta.supply_category !== originalMeta.supply_category
      || ownMeta.section_9_5_role != null && ownMeta.section_9_5_role !== originalMeta.section_9_5_role)) {
      unsupported = true; issue('RETURN_CLASSIFICATION_CONFLICT', 'BLOCKING_ERROR', type, header.id, 'Return classification conflicts with original supply evidence.', null, number);
    }
    if ((!overseas && !isValidStateCode(position)) || (interstate !== 0 && interstate !== 1)) {
      unsupported = true; issue('MISSING_PLACE_OF_SUPPLY', 'BLOCKING_ERROR', type, header.id, 'Explicit valid place of supply and supply type are required.', 'place_of_supply', number);
      if (sign < 0) issue('CREDIT_NOTE_CLASSIFICATION_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'Credit/debit note requires valid place-of-supply and classification evidence before it can enter a statutory section.', 'place_of_supply', number);
    }
    const supplierLocation = 'supplier_state_code' in header ? header.supplier_state_code ?? '' : '';
    const supplyOrigin = outward ? period.gstinSnapshot.slice(0, 2) : supplierLocation;
    if (!outward && !isValidStateCode(supplierLocation)) { unsupported = true; issue('SUPPLIER_STATE_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'Persisted supplier state is required to establish inward supply type.'); }
    if (!overseas && !sez && isValidStateCode(position) && (position !== supplyOrigin) !== document.is_interstate) {
      unsupported = true; issue('SUPPLY_TYPE_CONFLICT', 'BLOCKING_ERROR', type, header.id, 'Place of supply conflicts with persisted interstate/intrastate flag.', null, number);
    }
    if ((document.is_interstate && (document.cgst_paise || document.sgst_paise))
      || (!document.is_interstate && document.igst_paise && !overseas && !sez)) {
      unsupported = true; issue('TAX_HEAD_CONFLICT', 'BLOCKING_ERROR', type, header.id, 'Tax heads conflict with the supply type.', null, number);
    }
    if (meta?.recipient_category === 'UIN' && (!outward || !gstin || !/^[A-Z0-9]{2,32}$/.test(gstin)
      || !meta.recipient_identity_reviewed_at || !Number.isFinite(Date.parse(meta.recipient_identity_reviewed_at)) || !meta.recipient_identity_review_reason?.trim())) {
      unsupported = true; issue('UIN_IDENTITY_REVIEW_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'UIN requires a separately captured identity and a dated reasoned review; GSTIN checksum rules are not used.', 'recipient_uin', number);
    }
    if (meta?.recipient_category === 'UNKNOWN'
      || (meta?.recipient_category === 'UNREGISTERED' && gstin)
      || (['REGISTERED', 'COMPOSITION', 'SEZ'].includes(meta?.recipient_category ?? '') && !gstin)) {
      unsupported = true; issue('UNSUPPORTED_RECIPIENT', 'BLOCKING_ERROR', type, header.id, 'Recipient metadata is unsupported or conflicts with the captured identifier.', null, number);
    }
    if (overseas || sez || special === 'DEEMED_EXPORT') {
      classification = special!;
      if ((!outward) || (sez && (!gstin || !document.is_interstate || meta?.recipient_category !== 'SEZ')) || (special === 'DEEMED_EXPORT' && !gstin)
        || (overseas && meta?.recipient_category !== 'OVERSEAS')) {
        unsupported = true; issue('SPECIAL_SUPPLY_METADATA_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'Special supply requires explicit recipient, shipping/export or SEZ evidence.', null, number);
      }
      if (overseas) {
        const servicesOnly = lines.length > 0 && lines.every(line => line.goods_or_service === 'SERVICE');
        if (!servicesOnly && (!meta?.shipping_bill_number || !meta.port_code || !isDateOnly(meta.shipping_bill_date ?? ''))) {
          issue('EXPORT_SHIPPING_DETAIL_PENDING', 'WARNING', type, header.id, 'Goods export shipping details are pending; GST Portal permits later shipping-bill updates. Explicit export classification is retained.', null, number);
        }
        if (meta?.shipping_bill_date && !isDateOnly(meta.shipping_bill_date)) { unsupported = true; issue('INVALID_SHIPPING_DATE', 'BLOCKING_ERROR', type, header.id, 'Captured shipping bill date is invalid.', 'shipping_bill_date', number); }
      }
      if ((special === 'EXPORT_WITHOUT_PAYMENT' || special === 'SEZ_WITHOUT_PAYMENT') && taxKeys.some(key => document[key] !== 0)) {
        unsupported = true; issue('WITHOUT_PAYMENT_HAS_TAX', 'BLOCKING_ERROR', type, header.id, 'Without-payment supply contains tax liability.', null, number);
      }
    } else if (special && special !== 'DOMESTIC') {
      if (['NIL_RATED', 'EXEMPT', 'NON_GST'].includes(special)) classification = special;
      else unsupported = true;
    } else if (!gstin && document.is_interstate) {
      const ruleDate = original && sign < 0 && 'invoice_date' in original ? original.invoice_date : meta?.original_document_date ?? date;
      const effectiveRule = rulesForDate(ruleDate);
      if (!effectiveRule) unsupported = true;
      else if (Math.abs(original?.total_paise ?? header.total_paise) > effectiveRule.b2clThresholdPaise) classification = 'B2CL';
    }
    if (meta?.reverse_charge === 1) {
      if (!outward) classification = 'RCM';
      else if (!gstin || meta?.recipient_category === 'UIN' || special && special !== 'DOMESTIC') {
        unsupported = true; issue('OUTWARD_RCM_METADATA_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'Outward RCM requires an explicitly registered domestic recipient.', null, number);
      }
    }
    if (meta?.section_9_5_role && meta.section_9_5_role !== 'NONE') {
      if (!outward || !isValidGstin(meta.ecommerce_operator_gstin ?? '') || meta.ecommerce_reporting_type !== 'SECTION_9_5'
        || meta.section_52_tcs === 1 || special && special !== 'DOMESTIC') unsupported = true;
      else classification = meta.section_9_5_role === 'SUPPLIER' ? 'ECO_9_5_SUPPLIER' : 'ECO_9_5_LIABLE';
    } else if (meta?.ecommerce_operator_gstin || meta?.section_52_tcs || meta?.ecommerce_reporting_type) {
      // Ordinary ECO dimensions require explicit ordinary-supply classification.
      if (!isValidGstin(meta.ecommerce_operator_gstin ?? '') || meta.ecommerce_reporting_type !== 'ORDINARY') unsupported = true;
    }
    if (reportingOverride && !meta?.amendment_kind) unsupported = true;
    if (meta?.amendment_kind && !['OLDER_PERIOD_AMENDMENT', 'SAME_PERIOD_GSTR1A', 'INTERNAL_UNFILED_EDIT'].includes(meta.amendment_kind)) unsupported = true;
    if (sign < 0 && !document.original_source_entity_id) issue('MISSING_ORIGINAL_NOTE_LINK', 'WARNING', type, header.id, 'Original-note linkage is optional legally but missing for audit drill-down.', null, number);
    const lineTotals = emptyAmounts();
    const normalizedLines: Array<{ source: Line; amounts: GstAmounts; taxability: string; quantity?: number; dimensions?: NormalizedGstDocument }> = [];
    for (const line of lines) {
      const amounts = emptyAmounts();
      if (!line || typeof line !== 'object') {
        unsupported = true; issue('INVALID_LINE_SNAPSHOT', 'BLOCKING_ERROR', type, header.id, 'Historical line snapshot is not an object.', null, number); continue;
      }
      let invalid = false;
      for (const key of ['taxable_paise', ...taxKeys, 'line_total_paise', 'qty_micros', 'tax_rate_bps'] as const) {
        if (!Number.isSafeInteger(line[key])) { invalid = true; issue('UNSAFE_LINE_VALUE', 'BLOCKING_ERROR', type, header.id, `Invalid fixed-point ${key} on line ${line.id}.`, key, number); }
      }
      if (invalid) { unsupported = true; continue; }
      if (line.tax_rate_bps < 0 || (sign > 0 && (line.qty_micros < 0 || line.taxable_paise < 0 || taxKeys.some(key => line[key] < 0)))) {
        issue('INVALID_LINE_SIGN', 'BLOCKING_ERROR', type, header.id, 'Invalid line rate or amount sign.', null, number);
        unsupported = true;
        continue;
      }
      for (const key of ['taxable_paise', ...taxKeys] as const) amounts[key] = sign < 0 ? sign * Math.abs(line[key]) : line[key];
      amounts.total_paise = amounts.pre_round_total_paise = sign < 0 ? sign * Math.abs(line.line_total_paise) : line.line_total_paise;
      if (amounts.taxable_paise + taxKeys.reduce((total, key) => total + amounts[key], 0) !== amounts.total_paise) {
        issue('LINE_TOTAL_MISMATCH', 'BLOCKING_ERROR', type, header.id, `Line ${line.id} total differs from taxable plus tax heads.`, null, number);
        unsupported = true;
      }
      add(lineTotals, amounts, header.id);
      const explicitTaxability = line.taxability ?? (['NIL_RATED', 'EXEMPT', 'NON_GST'].includes(special ?? '') ? special : overseas || sez ? 'ZERO_RATED' : null);
      const taxability = explicitTaxability ?? (line.tax_rate_bps > 0 ? 'TAXABLE' : 'UNKNOWN');
      if (taxability === 'UNKNOWN') { unsupported = true; issue('UNKNOWN_TAXABILITY', 'BLOCKING_ERROR', type, header.id, 'A zero rate does not establish nil, exempt, non-GST or zero-rated classification.', 'taxability', number); }
      if (!['TAXABLE', 'ZERO_RATED', 'NIL_RATED', 'EXEMPT', 'NON_GST', 'UNKNOWN'].includes(taxability)
        || (['NIL_RATED', 'EXEMPT', 'NON_GST'].includes(special ?? '') && (taxability !== special || line.tax_rate_bps !== 0 || taxKeys.some(key => line[key] !== 0)))
        || (document.document_type === 'BILL_OF_SUPPLY' && (taxability === 'TAXABLE' || taxKeys.some(key => line[key] !== 0)))
        || (['NIL_RATED', 'EXEMPT', 'NON_GST'].includes(taxability) && (line.tax_rate_bps !== 0 || taxKeys.some(key => line[key] !== 0)))
        || (taxability === 'ZERO_RATED' && !overseas && !sez)) {
        unsupported = true; issue('TAXABILITY_CONFLICT', 'BLOCKING_ERROR', type, header.id, 'Explicit taxability conflicts with the supply or monetary snapshot.', 'taxability', number);
      }
      if (!/^\d{4,8}$/.test(line.hsn) || (hsnMinimum !== null && line.hsn.length < hsnMinimum)) issue('INVALID_HSN', 'BLOCKING_ERROR', type, header.id, `Line ${line.id} HSN/SAC is missing or below the known minimum.`, 'hsn', number);
      if (!line.uqc_code) issue('MISSING_UQC', 'BLOCKING_ERROR', type, header.id, `Line ${line.id} has no historical UQC snapshot; current masters are not used.`, 'uqc_code', number);
      if (!line.description.trim()) issue('MISSING_HSN_DESCRIPTION', 'BLOCKING_ERROR', type, header.id, `Line ${line.id} has no historical description snapshot; current masters are not used.`, 'description', number);
      if (line.snapshot_source === 'LEGACY_INFERRED' || !line.taxability && taxability === 'TAXABLE') issue('INFERRED_LINE_SNAPSHOT', 'WARNING', type, header.id, `Line ${line.id} includes legacy/inferred snapshot fields.`, null, number);
      const item = 'item_id' in line ? currentItems.get(line.item_id) : undefined;
      const unit = item && currentUnits.get(item.unit_id);
      if (item && (item.name !== line.description || item.hsn !== line.hsn || item.tax_rate_bps !== line.tax_rate_bps
        || unit && line.uqc_code && unit.code !== line.uqc_code)) issue('MASTER_HISTORY_DIFFERENCE', 'WARNING', type, header.id,
        `Current master differs from historical line ${line.id}; the persisted snapshot is retained.`, null, number);
      normalizedLines.push({ source: line, amounts, taxability });
    }
    for (const key of ['taxable_paise', ...taxKeys] as const) {
      if (lineTotals[key] !== document[key]) {
        issue('LINE_HEADER_MISMATCH', 'BLOCKING_ERROR', type, header.id, `Line sum differs from header ${key}.`, key, number, { [key]: document[key] - lineTotals[key] });
        unsupported = true;
      }
    }
    if (unsupported) { document.included = false; document.exclusion_reason ??= 'INVALID_LINE_OR_HEADER_EVIDENCE'; }
    const taxabilities = new Set(normalizedLines.map(line => line.taxability));
    if (taxabilities.size === 1 && ['NIL_RATED', 'EXEMPT', 'NON_GST'].includes([...taxabilities][0])) classification = [...taxabilities][0] as GstClassification;
    // Explicit historical taxability allocates mixed documents by line, not header.
    // Amendments require previous line snapshots, not a guessed header allocation.
    if (meta?.amendment_kind && meta.amendment_kind !== 'INTERNAL_UNFILED_EDIT') {
      try {
        const previous = JSON.parse(meta.previously_reported_values_json ?? '') as GstPreviouslyReportedValues;
        const originalPeriod = monthPeriod(businessId, period.gstinSnapshot, meta.original_return_period ?? '');
        const reportingMonth = reportingOverride ?? date.slice(0, 7);
        if (meta.amendment_kind === 'SAME_PERIOD_GSTR1A' ? originalPeriod.periodKey !== reportingMonth : originalPeriod.periodKey >= reportingMonth) throw new Error('Invalid amendment period');
        if (!meta.original_return_period || !meta.original_document_number || !Array.isArray(previous.lines)
          || !previous.lines.length || amountKeys.some(key => !Number.isSafeInteger(previous[key]))) throw new Error('Missing previous snapshots');
        const priorLines = new Map(previous.lines.map(line => [line.source_line_id, line]));
        if (priorLines.size !== previous.lines.length || previous.pre_round_total_paise !== previous.taxable_paise + taxKeys.reduce((total, key) => total + previous[key], 0)
          || previous.total_paise !== previous.pre_round_total_paise + previous.round_off_paise) throw new Error('Invalid previous header');
        const previousSum = emptyAmounts();
        for (const line of previous.lines) add(previousSum, line);
        if ((['taxable_paise', ...taxKeys] as const).some(key => previousSum[key] !== previous[key])) throw new Error('Previous header/lines differ');
        let attributeChanged = previous.lines.length !== normalizedLines.length || normalizedLines.some(line => !priorLines.has(line.source.id));
        for (const prior of previous.lines) {
          if (amountKeys.some(key => !Number.isSafeInteger(prior[key])) || !Number.isSafeInteger(prior.quantity_micros)
            || !Number.isSafeInteger(prior.tax_rate_bps) || prior.tax_rate_bps < 0 || !/^[0-9]{4,8}$/.test(prior.hsn) || !prior.uqc_code
            || !['TAXABLE', 'ZERO_RATED', 'NIL_RATED', 'EXEMPT', 'NON_GST'].includes(prior.taxability)
            || prior.pre_round_total_paise !== prior.taxable_paise + taxKeys.reduce((total, key) => total + prior[key], 0)
            || prior.round_off_paise !== 0 || prior.total_paise !== prior.pre_round_total_paise) throw new Error('Invalid prior line evidence');
        }
        for (const line of normalizedLines) {
          const prior = priorLines.get(line.source.id);
          if (!prior) continue;
          if (prior.tax_rate_bps !== line.source.tax_rate_bps || prior.hsn !== line.source.hsn || prior.description !== line.source.description
            || prior.uqc_code !== (line.source.uqc_code ?? null) || prior.goods_or_service !== (line.source.goods_or_service ?? null)
            || prior.taxability !== line.taxability) attributeChanged = true;
          if (!Number.isSafeInteger(prior.tax_rate_bps) || prior.tax_rate_bps < 0 || !/^\d{4,8}$/.test(prior.hsn) || !prior.uqc_code
            || !['TAXABLE', 'ZERO_RATED', 'NIL_RATED', 'EXEMPT', 'NON_GST'].includes(prior.taxability)) throw new Error('Incomplete prior grouping');
          if (prior.pre_round_total_paise !== prior.taxable_paise + taxKeys.reduce((total, key) => total + prior[key], 0)
            || prior.round_off_paise !== 0 || prior.total_paise !== prior.pre_round_total_paise
            || amountKeys.some(key => !Number.isSafeInteger(line.amounts[key] - prior[key]))) throw new Error('Invalid previous line totals or unsafe differential');
        }
        const expectedGroup = rules?.splitHsnByRecipient ? gstin ? 'B2B' : 'B2C' : 'COMBINED';
        const dimensionsChanged = previous.classification != null && previous.classification !== classification
          || previous.recipient_group != null && previous.recipient_group !== expectedGroup
          || previous.place_of_supply != null && previous.place_of_supply !== position
          || previous.is_interstate != null && previous.is_interstate !== document.is_interstate
          || previous.ecommerce_operator_gstin !== undefined && previous.ecommerce_operator_gstin !== document.ecommerce_operator_gstin
          || previous.party_gstin !== undefined && previous.party_gstin !== gstin
          || previous.recipient_category !== undefined && previous.recipient_category !== document.recipient_category;
        if (attributeChanged || dimensionsChanged || previous.reverse_charge !== undefined && previous.reverse_charge !== document.reverse_charge) {
          if (!previous.classification || !previous.recipient_group || !isValidStateCode(previous.place_of_supply ?? '')
            || typeof previous.is_interstate !== 'boolean' || previous.ecommerce_operator_gstin === undefined) throw new Error('Prior document classification dimensions missing');
          if (dimensionsChanged && (previous.party_gstin === undefined || !previous.recipient_category)) throw new Error('Prior recipient identity missing');
          attributeChanged = true;
        }
        if (amountKeys.some(key => !Number.isSafeInteger(document[key] - previous[key]))) throw new Error('Unsafe differential header');
        for (const key of amountKeys) document[key] -= previous[key];
        const priorContributions: typeof normalizedLines = [];
        if (attributeChanged) {
          for (const prior of previous.lines) {
            const priorAmounts = emptyAmounts();
            for (const key of amountKeys) priorAmounts[key] = -prior[key];
            priorContributions.push({ source: { id: prior.source_line_id, line_no: 0, qty_micros: prior.quantity_micros,
              taxable_paise: prior.taxable_paise, igst_paise: prior.igst_paise, cgst_paise: prior.cgst_paise, sgst_paise: prior.sgst_paise,
              cess_paise: prior.cess_paise, line_total_paise: prior.total_paise, hsn: prior.hsn, description: prior.description,
              uqc_code: prior.uqc_code ?? undefined, goods_or_service: prior.goods_or_service as Line['goods_or_service'],
              taxability: prior.taxability as Line['taxability'], tax_rate_bps: prior.tax_rate_bps },
              amounts: priorAmounts, taxability: prior.taxability, quantity: -prior.quantity_micros,
              dimensions: { ...document, classification: previous.classification!, place_of_supply: previous.place_of_supply!,
                is_interstate: previous.is_interstate!, party_gstin: previous.party_gstin ?? gstin,
                recipient_category: previous.recipient_category ?? document.recipient_category,
                reverse_charge: previous.reverse_charge ?? document.reverse_charge,
                ecommerce_operator_gstin: previous.ecommerce_operator_gstin ?? null } });
          }
        }
        for (const line of normalizedLines) {
          const prior = priorLines.get(line.source.id);
          if (attributeChanged) line.quantity = sign * Math.abs(line.source.qty_micros);
          else if (prior) {
            for (const key of amountKeys) line.amounts[key] -= prior[key];
            line.quantity = sign * Math.abs(line.source.qty_micros) - prior.quantity_micros;
          }
          // A line delta never carries document-level round-off.
          line.amounts.round_off_paise = 0;
        }
        normalizedLines.push(...priorContributions);
      } catch {
        unsupported = true; issue('AMENDMENT_PREVIOUS_VALUES_REQUIRED', 'BLOCKING_ERROR', type, header.id, 'Amendment requires valid original/reporting periods, complete prior header/lines and prior classification dimensions for changed groups; full amended values are excluded.', null, number);
        document.included = false; document.exclusion_reason = 'AMENDMENT_PREVIOUS_VALUES_REQUIRED';
      }
    }
    if (document.classification !== 'UNCLASSIFIED_INVALID_GSTIN') document.classification = unsupported ? 'UNCLASSIFIED' : classification;
    if (unsupported) issue('UNSUPPORTED_CLASSIFICATION', 'BLOCKING_ERROR', type, header.id, 'Metadata does not support a complete classification; this source remains visible and unclassified.', null, number);
    const legalKey = JSON.stringify([outward ? 'OUTWARD' : 'INWARD', outward ? '' : gstin || partyId, document.document_type, financialYearForDate(date), number,
      type === 'ADVANCE' && document.document_type === 'ADVANCE_ADJUSTMENT' ? header.id : '']);
    const duplicates = duplicateKeys.get(legalKey) ?? [];
    duplicates.push(document); duplicateKeys.set(legalKey, duplicates);
    if (!document.included) return;
    const rates = new Map<string, NormalizedGstRateRow>();
    for (const line of normalizedLines) {
      const dimensions = line.dimensions ?? document;
      const lineClassification = unclassified(document.classification) ? document.classification : ['NIL_RATED', 'EXEMPT', 'NON_GST'].includes(line.taxability) ? line.taxability as GstClassification : dimensions.classification;
      const key = JSON.stringify([line.source.tax_rate_bps, line.taxability, lineClassification, dimensions.place_of_supply, dimensions.party_gstin, dimensions.recipient_category, dimensions.ecommerce_operator_gstin]);
      let row = rates.get(key);
      if (!row) {
        row = { ...emptyAmounts(), source_entity_type: type, source_entity_id: header.id, source_line_ids: [], tax_period_key: period.periodKey,
          classification: lineClassification, tax_rate_bps: line.source.tax_rate_bps, taxability: line.taxability,
          place_of_supply: dimensions.place_of_supply, ecommerce_operator_gstin: dimensions.ecommerce_operator_gstin,
          is_interstate: dimensions.is_interstate, recipient_category: dimensions.recipient_category, party_gstin: dimensions.party_gstin, reverse_charge: dimensions.reverse_charge };
        row.recipient_group = unclassified(document.classification) ? 'UNCLASSIFIED' : rules?.splitHsnByRecipient ? dimensions.party_gstin ? 'B2B' : 'B2C' : 'COMBINED';
        rates.set(key, row);
      }
      row.source_line_ids.push(line.source.id); add(row, line.amounts, header.id);
      const quantity = line.quantity ?? sign * Math.abs(line.source.qty_micros);
      hsnLineContributions.push({ document: dimensions, source: line.source, amounts: line.amounts, taxability: line.taxability, quantity });
    }
    if (meta?.iff_reported_period) {
      const month = Number(meta.iff_reported_period.slice(5));
      if (period.filingFrequency !== 'QRMP' || !/^\d{4}-\d{2}$/.test(meta.iff_reported_period)
        || !isDateOnly(`${meta.iff_reported_period}-01`) || month % 3 === 0 || meta.iff_reported_period !== date.slice(0, 7)
        || !outward || !gstin || !['B2B', 'DEEMED_EXPORT'].includes(document.classification)) {
        issue('INVALID_IFF_METADATA', 'BLOCKING_ERROR', type, header.id, 'IFF requires a registered QRMP document in its source month and the first two months of a quarter.');
      }
    }
    (outward ? outwardRateRows : inwardRateRows).push(...rates.values());
  }

  function buildHsnContribution(contribution: typeof hsnLineContributions[number]) {
      const { document, source, amounts, taxability, quantity } = contribution;
       const outward = document.direction === 'OUTWARD' || document.source_entity_type === 'INVOICE' || document.source_entity_type === 'SALES_RETURN';
      const recipientGroup = unclassified(document.classification) ? 'UNCLASSIFIED' : rules?.splitHsnByRecipient ? document.party_gstin ? 'B2B' : 'B2C' : 'COMBINED';
      const hsnKey = JSON.stringify([recipientGroup, source.hsn, source.description, source.uqc_code ?? null,
        source.goods_or_service ?? null, taxability, source.tax_rate_bps]);
      const hsnMap = outward ? outwardHsn : inwardHsn;
      let hsn = hsnMap.get(hsnKey);
      if (!hsn) {
        hsn = { ...emptyAmounts(), tax_period_key: period.periodKey, recipient_group: recipientGroup,
          hsn: source.hsn, description: source.description, uqc_code: source.uqc_code ?? null,
          goods_or_service: source.goods_or_service ?? null, taxability, tax_rate_bps: source.tax_rate_bps,
          quantity_micros: 0, source_entity_ids: [], source_line_ids: [] };
        hsnMap.set(hsnKey, hsn); hsnSources.set(hsn, new Set());
      }
      add(hsn, amounts, document.source_entity_id);
      hsn.quantity_micros += quantity;
      if (!Number.isSafeInteger(hsn.quantity_micros)) { hsn.quantity_micros = 0; issue('UNSAFE_QUANTITY_AGGREGATE', 'BLOCKING_ERROR', document.source_entity_type, document.source_entity_id, 'HSN quantity exceeds safe integer range.'); }
      hsnSources.get(hsn)!.add(document.source_entity_id); hsn.source_line_ids.push(source.id);
  }

  for (const invoice of invoices.values()) {
    const lines = invoiceLines.get(invoice.id) ?? [];
    const quantities = returnedQuantities.get(invoice.id);
    const fullyReturned = invoice.status === 'cancelled' && !invoice.reversed_by_invoice_id && !!lines.length
      && lines.every(line => line.qty_micros > 0 && quantities?.get(line.id) === line.qty_micros);
    let excluded: string | null = invoice.deleted_at ? 'DELETED' : invoice.status === 'draft' ? 'DRAFT'
      : invoice.reverses_invoice_id ? 'LEGACY_REVERSAL' : invoice.reversed_by_invoice_id ? 'SUPERSEDED_OR_REVERSED'
      : invoice.status === 'cancelled' && !fullyReturned ? 'CANCELLED' : null;
    if (invoice.reversed_by_invoice_id) {
      const audit = auditMap.get(invoice.reversed_by_invoice_id);
      if (audit) remember('LEGACY_REVERSAL_AUDIT', audit.credit_note_invoice_id, audit);
      if (audit?.classification === 'SALES_RETURN' && returns.has(audit.materialized_sales_return_id ?? '')) excluded = invoice.deleted_at ? 'DELETED' : null;
    }
    normalize(invoice, 'INVOICE', lines, invoice.invoice_date, invoice.invoice_number, invoice.customer_id,
      invoice.place_of_supply, invoice.is_interstate, metadata.get(`INVOICE:${invoice.id}`)?.document_type === 'CREDIT_NOTE' ? -1 : 1,
      excluded, invoice.status === 'cancelled' && !fullyReturned && excluded === 'CANCELLED');
    if (fullyReturned && dateInPeriod(invoice.invoice_date, period)) {
      for (const row of returnEvidence.get(invoice.id) ?? []) remember('RETURN_CANCELLATION_EVIDENCE', row.id, { header: row, lines: returnLines.get(row.id) ?? [] }, row.entity_version, row.return_date);
      issue('FULL_NATIVE_RETURN_ORIGINAL_RETAINED', 'INFORMATION', 'INVOICE', invoice.id, 'Original supply retained; linked full native return is reported in its own period.');
    }
  }
  for (const returned of returns.values()) {
    const original = originals.get(returned.original_invoice_id) ?? null;
    const exclusion = returned.deleted_at ? 'DELETED' : returned.status !== 'posted' ? 'CANCELLED'
      : returned.legacy_migration_classification && returned.legacy_migration_classification !== 'SALES_RETURN' ? 'LEGACY_UNKNOWN' : null;
    normalize(returned, 'SALES_RETURN', returnLines.get(returned.id) ?? [], returned.return_date, returned.return_number,
      returned.customer_id, original?.place_of_supply ?? '', original?.is_interstate ?? -1, -1, exclusion,
      exclusion === 'CANCELLED', original);
  }
  for (const purchase of purchases.values()) {
    const isReturn = !!purchase.reverses_purchase_id;
    const successor = purchases.get(purchase.reversed_by_purchase_id ?? '');
    const deleted = (purchase as Purchase & { deleted_at?: string | null }).deleted_at;
    const excluded = deleted ? 'DELETED' : purchase.status === 'draft' ? 'DRAFT' : purchase.status === 'cancelled' ? 'CANCELLED'
      : purchase.replaced_by_purchase_id ? 'SUPERSEDED' : purchase.reversed_by_purchase_id && successor?.reverses_purchase_id !== purchase.id ? 'UNVERIFIED_REVERSAL' : null;
    const meta = metadata.get(`PURCHASE:${purchase.id}`) ?? metadata.get(`PURCHASE_RETURN:${purchase.id}`);
    const sign = isReturn || meta?.document_type === 'CREDIT_NOTE' ? -1 : 1;
    normalize(purchase, isReturn ? 'PURCHASE_RETURN' : 'PURCHASE', purchaseLines.get(purchase.id) ?? [], purchase.bill_date,
      purchase.supplier_bill_number || purchase.bill_number, purchase.supplier_id, meta?.place_of_supply_state_code ?? sources.business.state_code,
      purchase.is_interstate, sign, excluded, excluded === 'CANCELLED', purchases.get(purchase.reverses_purchase_id ?? '') ?? null);
  }
  for (const advance of sources.advances) {
    if (advance.business_id !== businessId || advance.deleted_at) continue;
    const meta = metadata.get(`ADVANCE:${advance.id}`);
    if (!dateInPeriod(advance.advance_date, period)) continue;
    remember('ADVANCE', advance.id, { advance, metadata: meta ?? null }, advance.entity_version, advance.advance_date, 'EXCLUDED', meta?.entity_version ?? null);
    if (meta?.tax_on_advance_applicable === 0) continue;
    try {
      if (meta?.tax_on_advance_applicable !== 1 || advance.party_type !== 'customer') throw new Error();
      const lines = JSON.parse(meta.advance_gst_json ?? '').lines as GstNoteLine[];
      if (!Array.isArray(lines) || !lines.length || lines.some(line => line.taxability !== 'TAXABLE')) throw new Error();
      const amounts = sum(lines.map(line => ({ ...line, pre_round_total_paise: line.line_total_paise, total_paise: line.line_total_paise })));
      if (amounts.total_paise !== advance.amount_paise || !Number.isSafeInteger(advance.amount_paise)) throw new Error();
      const header: GstNote = { ...advance, ...amounts, direction: 'OUTWARD', note_type: 'DEBIT_NOTE', note_number: advance.advance_number,
        note_date: advance.advance_date, party_id: advance.party_id, place_of_supply: meta.place_of_supply_state_code ?? '',
        is_interstate: meta.place_of_supply_state_code !== period.gstinSnapshot.slice(0, 2) ? 1 : 0, lines_json: JSON.stringify(lines) };
      // This is a receipt voucher, not an accounting invoice or debit note.
      const priorMeta = metadata.get(`ADVANCE:${advance.id}`)!;
      metadata.set(`ADVANCE:${advance.id}`, { ...priorMeta, document_type: 'RECEIPT_VOUCHER' });
      normalize(header, 'ADVANCE', lines, advance.advance_date, advance.advance_number, advance.party_id, header.place_of_supply, header.is_interstate, 1, null, false);
    } catch { issue('ADVANCE_GST_DETAIL_REQUIRED', 'BLOCKING_ERROR', 'ADVANCE', advance.id, 'Taxable customer advance requires explicit historical taxable lines matching the receipt and GST classification.'); }
  }
  for (const invoice of invoices.values()) {
    const meta = metadata.get(`INVOICE:${invoice.id}`);
    if (!meta?.advance_adjustments_json || !outwardDocuments.some(row => row.source_entity_id === invoice.id && row.included && !unclassified(row.classification))) continue;
    try {
      const offsets = JSON.parse(meta.advance_adjustments_json) as GstAdvanceOffset[];
      if (!Array.isArray(offsets) || new Set(offsets.map(row => row.advance_id)).size !== offsets.length) throw new Error();
      const prepared: Array<{ header: GstNote; lines: GstNoteLine[]; meta: GstDocumentMetadata }> = [];
      const invoiceOffset = emptyAmounts();
      for (const offset of offsets) {
        const advance = sources.advances.find(row => row.id === offset.advance_id && row.business_id === businessId);
        const advanceMeta = metadata.get(`ADVANCE:${offset.advance_id}`);
        if (!advance || advance.deleted_at || advance.party_type !== 'customer' || advance.party_id !== invoice.customer_id
          || advance.advance_date > invoice.invoice_date || advanceMeta?.tax_on_advance_applicable !== 1) throw new Error();
        const priorLines = JSON.parse(advanceMeta.advance_gst_json ?? '').lines as GstNoteLine[];
        if (!Array.isArray(priorLines) || !priorLines.length || priorLines.some(line => line.taxability !== 'TAXABLE')) throw new Error();
        const advanceAmounts = sum(priorLines.map(line => ({ ...line, pre_round_total_paise: line.line_total_paise, total_paise: line.line_total_paise })));
        if (advanceAmounts.total_paise !== advance.amount_paise) throw new Error();
        const cumulative = emptyAmounts();
        const cumulativeLines = new Map<string, GstAmounts>();
        const evidence = [...new Map([...(sources.advanceOffsetEvidence ?? []), ...sources.metadata].map(row => [row.id, row])).values()];
        for (const linked of evidence) if (linked.business_id === businessId && linked.advance_adjustments_json) {
          const values = JSON.parse(linked.advance_adjustments_json);
          if (!Array.isArray(values)) throw new Error();
          for (const value of values) if (value.advance_id === advance.id) {
            for (const key of ['taxable_paise', ...taxKeys] as const) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error();
            add(cumulative, value);
            const allocations = value.lines ?? (priorLines.length === 1 ? [{ ...value, advance_line_id: priorLines[0].id }]
              : (['taxable_paise', ...taxKeys] as const).every(key => value[key] === advanceAmounts[key]) ? priorLines.map(line => ({ ...line, advance_line_id: line.id })) : null);
            if (!Array.isArray(allocations)) throw new Error();
            const allocated = emptyAmounts();
            for (const allocation of allocations) {
              const prior = priorLines.find(line => line.id === allocation.advance_line_id);
              if (!prior) throw new Error();
              const total = cumulativeLines.get(prior.id) ?? emptyAmounts();
              for (const key of ['taxable_paise', ...taxKeys] as const) if (!Number.isSafeInteger(allocation[key]) || allocation[key] < 0) throw new Error();
              add(total, allocation); add(allocated, allocation); cumulativeLines.set(prior.id, total);
              for (const key of ['taxable_paise', ...taxKeys] as const) if (total[key] > prior[key]) throw new Error();
            }
            for (const key of ['taxable_paise', ...taxKeys] as const) if (allocated[key] !== value[key]) throw new Error();
          }
        }
        for (const key of ['taxable_paise', ...taxKeys] as const) {
          if (!Number.isSafeInteger(offset[key]) || offset[key] < 0 || cumulative[key] > advanceAmounts[key]) throw new Error();
        }
        if (offset.taxable_paise <= 0) throw new Error();
        add(invoiceOffset, offset);
        const id = `advance-offset:${invoice.id}:${advance.id}`;
        const amounts = { ...emptyAmounts(), ...offset };
        amounts.total_paise = amounts.pre_round_total_paise = amounts.taxable_paise + taxKeys.reduce((sum, key) => sum + amounts[key], 0);
        const fullOffset = (['taxable_paise', ...taxKeys] as const).every(key => offset[key] === advanceAmounts[key]);
        const allocation = offset.lines ?? (priorLines.length === 1 ? [{ ...offset, advance_line_id: priorLines[0].id }]
          : fullOffset ? priorLines.map(line => ({ ...line, advance_line_id: line.id })) : null);
        if (!allocation || !allocation.length || new Set(allocation.map(row => row.advance_line_id)).size !== allocation.length) throw new Error();
        const lines: GstNoteLine[] = allocation.map((value, index) => {
          const prior = priorLines.find(line => line.id === value.advance_line_id);
          if (!prior) throw new Error();
          for (const key of ['taxable_paise', ...taxKeys] as const) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > prior[key]) throw new Error();
          const total = value.taxable_paise + taxKeys.reduce((sum, key) => sum + value[key], 0);
          if (!Number.isSafeInteger(total)) throw new Error();
          return { ...prior, ...value, id: `${id}:${index}`, qty_micros: 0, line_total_paise: total };
        });
        const allocationSum = sum(lines);
        for (const key of ['taxable_paise', ...taxKeys] as const) if (allocationSum[key] !== offset[key]) throw new Error();
        const header: GstNote = { ...advance, ...amounts, id, direction: 'OUTWARD', note_type: 'CREDIT_NOTE', note_number: invoice.invoice_number,
          note_date: invoice.invoice_date, party_id: advance.party_id, place_of_supply: advanceMeta.place_of_supply_state_code ?? '',
          is_interstate: advanceMeta.place_of_supply_state_code !== period.gstinSnapshot.slice(0, 2) ? 1 : 0, lines_json: JSON.stringify(lines) };
        prepared.push({ header, lines, meta: { ...advanceMeta, source_entity_id: id, document_type: 'ADVANCE_ADJUSTMENT', reporting_period_override: null,
          amendment_kind: null, original_source_entity_id: advance.id } });
        remember('LINKED_ADVANCE', advance.id, { advance, metadata: advanceMeta }, advance.entity_version, advance.advance_date);
      }
      for (const key of ['taxable_paise', ...taxKeys] as const) if (invoiceOffset[key] > invoice[key]) throw new Error();
      for (const entry of prepared) {
        metadata.set(`ADVANCE:${entry.header.id}`, entry.meta);
        normalize(entry.header, 'ADVANCE', entry.lines, invoice.invoice_date, invoice.invoice_number, invoice.customer_id,
          entry.header.place_of_supply, entry.header.is_interstate, -1, null, false);
      }
    } catch { issue('INVALID_ADVANCE_OFFSET', 'BLOCKING_ERROR', 'INVOICE', invoice.id, 'Linked advance offsets require earlier same-party taxable receipts, explicit rate-wise amounts and cumulative limits.'); }
  }
  for (const note of sources.notes ?? []) {
    if (note.business_id !== businessId) continue;
    let lines: GstNoteLine[] = [];
    try { const parsed = JSON.parse(note.lines_json); if (!Array.isArray(parsed)) throw new Error(); lines = parsed; }
    catch { issue('MISSING_LINE_DATA', 'BLOCKING_ERROR', 'GST_NOTE', note.id, 'Historical note lines are invalid.'); }
    normalize(note, 'GST_NOTE', lines, note.note_date, note.note_number, note.party_id, note.place_of_supply, note.is_interstate,
      note.note_type === 'CREDIT_NOTE' ? -1 : 1, null, false);
  }
  // Remove every member of an exact duplicate set, rather than silently picking a winner.
  const duplicates = new Set<string>();
  const identityKey = (type: string, party: string, documentType: string, date: string, number: string) => JSON.stringify([
     type === 'INVOICE' || type === 'SALES_RETURN' || type === 'OUTWARD' ? 'OUTWARD' : 'INWARD', type === 'INVOICE' || type === 'SALES_RETURN' || type === 'OUTWARD' ? '' : party,
    documentType, financialYearForDate(date), number,
  ]);
  const identityEvidence = new Map<string, Set<string>>();
  const fuzzyEvidence = new Map<string, Set<string>>();
  for (const evidence of sources.documentIdentityEvidence ?? []) {
    if (evidence.business_id !== businessId) continue;
    const fy = evidence.document_date && isDateOnly(evidence.document_date) ? financialYearForDate(evidence.document_date) : evidence.financial_year;
    if (!fy || !/^\d{4}-\d{2}$/.test(fy) || evidence.document_date && !isDateOnly(evidence.document_date)) { issue('INVALID_IDENTITY_EVIDENCE', 'BLOCKING_ERROR', evidence.source_entity_type, evidence.source_entity_id, 'Duplicate identity evidence requires a valid date or explicit financial year.'); continue; }
    const outward = evidence.direction === 'OUTWARD' || evidence.source_entity_type === 'INVOICE' || evidence.source_entity_type === 'SALES_RETURN';
    const key = JSON.stringify([outward ? 'OUTWARD' : 'INWARD', outward ? '' : evidence.party_gstin?.trim().toUpperCase() ?? '', evidence.document_type, fy, evidence.document_number]);
    const ids = identityEvidence.get(key) ?? new Set<string>(); ids.add(`${evidence.source_entity_type}:${evidence.source_entity_id}`); identityEvidence.set(key, ids);
    const fuzzyKey = JSON.stringify([outward ? 'OUTWARD' : 'INWARD', outward ? '' : evidence.party_gstin?.trim().toUpperCase() ?? '', evidence.document_type, fy, evidence.document_number.toUpperCase().replace(/[^A-Z0-9]/g, '')]);
    const fuzzyIds = fuzzyEvidence.get(fuzzyKey) ?? new Set<string>(); fuzzyIds.add(`${evidence.source_entity_type}:${evidence.source_entity_id}`); fuzzyEvidence.set(fuzzyKey, fuzzyIds);
    remember('DOCUMENT_IDENTITY_EVIDENCE', `${evidence.source_entity_type}:${evidence.source_entity_id}`, evidence);
  }
  for (const document of [...outwardDocuments, ...inwardDocuments]) {
    if (!document.included) continue;
    const key = identityKey(document.direction ?? document.source_entity_type, document.party_gstin || document.party_id, document.document_type, document.document_date, document.document_number);
    const id = `${document.source_entity_type}:${document.source_entity_id}`;
    const fuzzyKey = JSON.stringify([document.direction, document.direction === 'OUTWARD' ? '' : document.party_gstin, document.document_type,
      financialYearForDate(document.document_date), document.document_number.toUpperCase().replace(/[^A-Z0-9]/g, '')]);
    if ([...(fuzzyEvidence.get(fuzzyKey) ?? [])].some(other => other !== id) && ![...(identityEvidence.get(key) ?? [])].some(other => other !== id)) {
      issue('FUZZY_DUPLICATE_SUGGESTION', 'WARNING', document.source_entity_type, document.source_entity_id, 'Another document has a similar punctuation/case-normalized number. Legal numbers are not merged or changed.', null, document.document_number);
    }
    if ([...(identityEvidence.get(key) ?? [])].some(other => other !== id)) {
      document.included = false; document.exclusion_reason = 'DUPLICATE'; duplicates.add(id);
      issue('DUPLICATE_DOCUMENT', 'BLOCKING_ERROR', document.source_entity_type, document.source_entity_id, 'Full-financial-year evidence contains another source with this exact legal document identity.', null, document.document_number);
    }
  }
  for (const group of duplicateKeys.values()) if (group.length > 1) for (const document of group) {
    document.included = false; document.exclusion_reason = 'DUPLICATE'; duplicates.add(`${document.source_entity_type}:${document.source_entity_id}`);
    issue('DUPLICATE_DOCUMENT', 'BLOCKING_ERROR', document.source_entity_type, document.source_entity_id, 'Exact legal document identity is duplicated; all copies excluded from totals.', null, document.document_number);
  }
  if (duplicates.size) {
    for (const rows of [outwardRateRows, inwardRateRows]) for (let index = rows.length - 1; index >= 0; index--) if (duplicates.has(`${rows[index].source_entity_type}:${rows[index].source_entity_id}`)) rows.splice(index, 1);
  }
  const excludedIdentities = new Set([...outwardDocuments, ...inwardDocuments].filter(row => !row.included).map(row => `${row.source_entity_type}:${row.source_entity_id}`));
  for (const contribution of hsnLineContributions) if (contribution.document.included && !excludedIdentities.has(`${contribution.document.source_entity_type}:${contribution.document.source_entity_id}`)) buildHsnContribution(contribution);
  for (const document of [...outwardDocuments, ...inwardDocuments]) {
    const entry = manifest.get(`${document.source_entity_type}:${document.source_entity_id}`)!;
    entry.report_effect = document.included ? 'INCLUDED' : 'EXCLUDED';
  }
  const finishHsn = (map: Map<string, NormalizedHsnRow>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => {
    row.source_entity_ids = [...hsnSources.get(row)!].sort(); row.source_line_ids.sort(); return row;
  });
  const outwardHsnRows = finishHsn(outwardHsn), inwardHsnRows = finishHsn(inwardHsn);
  for (const rows of [outwardDocuments, inwardDocuments]) rows.sort((a, b) => a.document_date.localeCompare(b.document_date) || a.source_entity_type.localeCompare(b.source_entity_type) || a.source_entity_id.localeCompare(b.source_entity_id));
  for (const rows of [outwardRateRows, inwardRateRows]) rows.sort((a, b) => a.source_entity_type.localeCompare(b.source_entity_type) || a.source_entity_id.localeCompare(b.source_entity_id) || a.tax_rate_bps - b.tax_rate_bps || a.taxability.localeCompare(b.taxability));
  const outwardIncluded = outwardDocuments.filter(d => d.included), inwardIncluded = inwardDocuments.filter(d => d.included);
  const outwardNotes = outwardDocuments.filter(d => ['CREDIT_NOTE', 'DEBIT_NOTE'].includes(d.document_type));
  const inwardNotes = inwardDocuments.filter(d => ['CREDIT_NOTE', 'DEBIT_NOTE'].includes(d.document_type));
  const outwardNoteIds = new Set(outwardNotes.map(d => d.source_entity_id));
  const inwardNoteIds = new Set(inwardNotes.map(d => d.source_entity_id));
  function summary(documents: NormalizedGstDocument[], rows: NormalizedGstRateRow[]): GstSummary {
    const live = documents.filter(d => d.included), ids = new Set(live.map(d => d.source_entity_id));
    return { ...sum(live), document_count: live.filter(row => !row.allocation_only).length, party_count: new Set(live.map(d => d.party_gstin).filter(Boolean)).size,
      detail_row_count: rows.filter(row => ids.has(row.source_entity_id)).length, source_entity_ids: [...ids].sort() };
  }
  const sections: Record<string, NormalizedGstDocument[]> = {};
  for (const key of ['B2B', 'B2CL', 'B2CS', 'EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT', 'DEEMED_EXPORT', 'NIL_RATED', 'EXEMPT', 'NON_GST', 'REGISTERED_NOTES', 'UNREGISTERED_NOTES', 'AMENDMENTS', 'ECO_9_5_SUPPLIER', 'ECO_9_5_LIABLE', 'UNCLASSIFIED', 'UNCLASSIFIED_INVALID_GSTIN', 'ADVANCES']) sections[key] = [];
  const sourceSection = new Map<string, string>();
  for (const document of outwardIncluded) {
    const section = unclassified(document.classification) ? document.classification : document.source_entity_type === 'ADVANCE' ? 'ADVANCES' : document.amendment_kind && document.amendment_kind !== 'INTERNAL_UNFILED_EDIT' ? 'AMENDMENTS'
      : document.classification === 'B2CS' ? 'B2CS'
      : outwardNoteIds.has(document.source_entity_id) ? document.party_gstin ? 'REGISTERED_NOTES' : 'UNREGISTERED_NOTES' : document.classification;
    (sections[section] ??= []).push(document); sourceSection.set(document.source_entity_id, section);
  }
  const sectionRates: Record<string, NormalizedGstRateRow[]> = {};
  const allocationsBySource = new Map<string, Map<string, NormalizedGstRateRow[]>>();
  for (const key of Object.keys(sections)) sectionRates[key] = [];
  for (const row of outwardRateRows) {
    const primary = sourceSection.get(row.source_entity_id)!;
    const section = ['NIL_RATED', 'EXEMPT', 'NON_GST'].includes(row.classification) && !['AMENDMENTS', 'REGISTERED_NOTES', 'UNREGISTERED_NOTES'].includes(primary)
      ? row.classification : primary;
    sectionRates[section].push(row);
    const source = allocationsBySource.get(row.source_entity_id) ?? new Map<string, NormalizedGstRateRow[]>();
    const rows = source.get(section) ?? []; rows.push(row); source.set(section, rows); allocationsBySource.set(row.source_entity_id, source);
  }
  // Header identity/value belongs to one primary section. Additional allocations
  // carry only historical line measures and never repeat invoice value/count.
  for (const document of outwardIncluded) {
    const primary = sourceSection.get(document.source_entity_id)!;
    const allocation = allocationsBySource.get(document.source_entity_id) ?? new Map<string, NormalizedGstRateRow[]>();
    const allocations = [...allocation.keys()];
    if (allocations.length <= 1 && (!allocations.length || allocations[0] === primary)) continue;
    const all = new Set([...allocations, primary]);
    for (const section of all) {
      const totals = sum(allocation.get(section) ?? []);
      const projected = { ...document, ...totals, allocation_only: section !== primary,
        classification: section !== primary ? section as GstClassification : document.classification,
        total_paise: section === primary ? document.total_paise : 0, round_off_paise: section === primary ? document.round_off_paise : 0 };
      const index = sections[section].findIndex(row => row.source_entity_id === document.source_entity_id);
      if (index >= 0) sections[section][index] = projected; else sections[section].push(projected);
    }
  }
  const sectionSummaries: Record<string, GstSummary> = {};
  for (const key of Object.keys(sections)) sectionSummaries[key] = summary(sections[key], sectionRates[key]);
  const b2csGroups = new Map<string, GstB2csAggregate>();
  const outwardById = new Map(outwardIncluded.map(document => [document.source_entity_id, document]));
  for (const row of sectionRates.B2CS) {
    const document = outwardById.get(row.source_entity_id)!;
    const key = JSON.stringify([period.periodKey, row.place_of_supply, row.tax_rate_bps, document.is_interstate, row.ecommerce_operator_gstin]);
    const aggregate = b2csGroups.get(key) ?? { ...emptyAmounts(), tax_period_key: period.periodKey, place_of_supply: row.place_of_supply,
      tax_rate_bps: row.tax_rate_bps, supply_type: document.is_interstate ? 'INTERSTATE' : 'INTRASTATE', ecommerce_operator_gstin: row.ecommerce_operator_gstin,
      source_entity_ids: [], source_entity_types: [], source_line_ids: [] };
    add(aggregate, row);
    aggregate.source_entity_ids.push(row.source_entity_id); aggregate.source_entity_types!.push(row.source_entity_type); aggregate.source_line_ids.push(...row.source_line_ids);
    b2csGroups.set(key, aggregate);
  }
  const b2csAggregates = [...b2csGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => ({ ...row,
    source_entity_ids: [...new Set(row.source_entity_ids)].sort(), source_entity_types: [...new Set(row.source_entity_types!)].sort(), source_line_ids: [...new Set(row.source_line_ids)].sort() }));

  const itcNotes = new Map((sources.notes ?? []).filter(row => row.business_id === businessId && row.direction === 'INWARD').map(row => [row.id, row]));
  for (const note of itcNotes.values()) {
    // Adapt detailed note evidence locally; no purchase or historical amount is persisted.
    try {
      if (purchases.has(note.id)) throw new Error('Source identity collision');
      const evidence = inwardNoteEvidence(note);
      purchases.set(note.id, evidence.header); purchaseLines.set(note.id, evidence.lines);
      const meta = metadata.get(`GST_NOTE:${note.id}`);
      if (meta) metadata.set(`PURCHASE:${note.id}`, meta);
    } catch { issue('ITC_NOTE_EVIDENCE_INVALID', 'BLOCKING_ERROR', 'GST_NOTE', note.id, 'Inward note historical evidence is invalid or conflicts with a purchase identity.'); }
  }
  const ledger = indexed(sources.itcEntries, 'GST_ITC_LEDGER');
  const supersededLedger = new Set<string>();
  const supersedingReviews = new Map<string, string[]>();
  for (const entry of ledger.values()) {
    const prior = ledger.get(entry.related_prior_entry_id ?? '');
    if (!prior || !['UNREVIEWED', 'PENDING_REVIEW'].includes(prior.status) || ['UNREVIEWED', 'PENDING_REVIEW'].includes(entry.status)) continue;
    const valid = prior.source_entity_type === entry.source_entity_type && prior.source_entity_id === entry.source_entity_id
      && prior.tax_head === entry.tax_head && prior.tax_period_key === entry.tax_period_key
      && !!entry.category && (!!entry.reviewed_at || entry.user_confirmation === 1)
      && [entry.books_tax_paise, entry.original_eligible_paise, entry.temporarily_reversed_paise, entry.permanently_reversed_paise, entry.reclaimed_paise]
        .every(amount => amount == null || Number.isSafeInteger(amount) && amount >= 0);
    if (!valid) continue;
    const children = supersedingReviews.get(prior.id) ?? [];
    children.push(entry.id); supersedingReviews.set(prior.id, children);
    remember('GST_ITC_LEDGER', prior.id, prior, prior.entity_version);
  }
  for (const [id, children] of supersedingReviews) if (children.length === 1) supersededLedger.add(id);
  const historyInvalid = new Set<string>();
  const outstandingReversals = new Map<string, number>();
  const historyKey = (entry: typeof sources.itcEntries[number]) => `${entry.source_entity_id}:${entry.tax_head}`;
  const historyEvents: Array<{ entry: typeof sources.itcEntries[number]; date: string; kind: 'CLAIM' | 'REVERSAL' | 'RECLAIM' | 'RETURN'; amount: number }> = [];
  const returnedEntitlement = new Map<string, number>();
  const returnAvailableLimits = new Map<string, number>();
  for (const entry of ledger.values()) {
    if (supersededLedger.has(entry.id)) continue;
    const purchase = purchases.get(entry.source_entity_id);
    const sourcePeriod = entry.source_period_key ?? purchase?.bill_date.slice(0, 7);
    const reviewed = !!entry.category && (!!entry.reviewed_at || entry.user_confirmation === 1);
    const claimStatus = ['ELIGIBLE', 'ELIGIBLE_IN_BOOKS', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED'].includes(entry.status);
    const initialClaim = claimStatus && (entry.status === 'ELIGIBLE' || entry.status === 'ELIGIBLE_IN_BOOKS' || sourcePeriod === entry.tax_period_key);
    const head = `${entry.tax_head.toLowerCase()}_paise` as typeof taxKeys[number];
    if (initialClaim) historyEvents.push({ entry, date: entry.tax_period_key, kind: 'CLAIM', amount: entry.original_eligible_paise ?? (purchase && sourcePeriod === entry.tax_period_key ? Math.abs(purchase[head]) : 0) });
    if (entry.status === 'TEMPORARILY_REVERSED' || entry.status === 'PERMANENTLY_REVERSED') historyEvents.push({ entry,
      date: entry.reversal_period_key ?? entry.tax_period_key, kind: 'REVERSAL', amount: (entry.status === 'TEMPORARILY_REVERSED' ? entry.temporarily_reversed_paise : entry.permanently_reversed_paise) ?? Math.abs(purchase?.[head] ?? 0) });
    if (entry.status === 'RECLAIMED') historyEvents.push({ entry, date: entry.reclaim_period_key ?? entry.tax_period_key, kind: 'RECLAIM', amount: entry.reclaimed_paise ?? 0 });
    if (entry.tax_period_key <= throughPeriodKey || (entry.reversal_period_key ?? entry.tax_period_key) <= throughPeriodKey || (entry.reclaim_period_key ?? entry.tax_period_key) <= throughPeriodKey) {
      remember('GST_ITC_LEDGER', entry.id, entry, entry.entity_version);
      if (purchase) remember('ITC_SOURCE_PURCHASE', purchase.id, { header: purchase, lines: purchaseLines.get(purchase.id) ?? [],
        metadata: metadata.get(`PURCHASE:${purchase.id}`) ?? metadata.get(`PURCHASE_RETURN:${purchase.id}`) ?? null }, purchase.entity_version, purchase.bill_date);
      if (claimStatus && !reviewed) historyInvalid.add(historyKey(entry));
    }
  }
  // A returned source permanently loses entitlement, including temporarily reversed tax.
  for (const note of purchases.values()) {
    if (!note.reverses_purchase_id || !['received', 'partial', 'paid'].includes(note.status) || !isDateOnly(note.bill_date)) continue;
    const original = purchases.get(note.reverses_purchase_id);
    for (const head of taxHeads) {
      const key = `${head.toLowerCase()}_paise` as typeof taxKeys[number];
      if (!note[key]) continue;
      const eventEntry = { id: `RETURN:${note.id}:${head}`, source_entity_id: note.reverses_purchase_id,
        source_entity_type: 'PURCHASE', tax_head: head, category: 'OTHER_ITC', reviewed_at: note.updated_at,
        tax_period_key: note.bill_date.slice(0, 7) } as typeof sources.itcEntries[number];
      historyEvents.push({ entry: eventEntry, date: note.bill_date.slice(0, 7), kind: 'RETURN', amount: Math.abs(note[key]) });
      if (note.bill_date < period.nextPeriodStart) remember('ITC_RETURN_ENTITLEMENT_EVIDENCE', eventEntry.id, { note, original: original ?? null }, note.entity_version, note.bill_date);
    }
  }
  const historyBalances = new Map<string, { claimed: number; available: number }>();
  const priority = { CLAIM: 0, REVERSAL: 1, RETURN: 2, RECLAIM: 3 };
  historyEvents.sort((a, b) => a.date.localeCompare(b.date) || priority[a.kind] - priority[b.kind] || a.entry.id.localeCompare(b.entry.id));
  for (const event of historyEvents) {
    if (event.date > throughPeriodKey) continue;
    const key = historyKey(event.entry), purchase = purchases.get(event.entry.source_entity_id);
    const balance = historyBalances.get(key) ?? { claimed: 0, available: 0 };
    const head = `${event.entry.tax_head.toLowerCase()}_paise` as typeof taxKeys[number];
    const magnitude = Math.abs(event.amount);
    let valid = !!purchase && Number.isSafeInteger(event.amount) && event.amount >= 0 && Number.isSafeInteger(purchase[head])
      && !!event.entry.category && (!!event.entry.reviewed_at || event.entry.user_confirmation === 1);
    try { monthPeriod(businessId, period.gstinSnapshot, event.date); } catch { valid = false; }
    // Purchase-note claims are negative review effects, not additional original entitlement.
    if (purchase?.reverses_purchase_id || itcNotes.get(event.entry.source_entity_id)?.note_type === 'CREDIT_NOTE') continue;
    if (event.kind === 'RETURN') {
      const previousReturned = returnedEntitlement.get(key) ?? 0;
      const totalReturned = previousReturned + magnitude;
      valid &&= Number.isSafeInteger(totalReturned) && totalReturned <= Math.abs(purchase?.[head] ?? 0);
      if (valid) {
        const noteId = event.entry.id.slice('RETURN:'.length, -(`:${event.entry.tax_head}`).length);
        returnAvailableLimits.set(`${noteId}:${event.entry.tax_head}`, balance.available);
        returnedEntitlement.set(key, totalReturned);
        // Reduce the permanent entitlement ceiling. Reversed balances disappear first,
        // so they cannot subsequently be reclaimed after a full return.
        const remainingCeiling = Math.max(0, Math.abs(purchase![head]) - totalReturned);
        let remove = Math.max(0, balance.claimed - remainingCeiling) - Math.max(0, balance.claimed - (Math.abs(purchase![head]) - previousReturned));
        for (const [priorId, outstanding] of outstandingReversals) {
          if (!remove) break;
          const prior = ledger.get(priorId)!;
          if (historyKey(prior) !== key) continue;
          const consumed = Math.min(remove, outstanding);
          outstandingReversals.set(priorId, outstanding - consumed); remove -= consumed;
        }
        balance.available = Math.max(0, Math.min(balance.available - remove, remainingCeiling));
      }
    } else if (event.kind === 'CLAIM') {
      const claimed = balance.claimed + magnitude, available = balance.available + magnitude;
      valid &&= Number.isSafeInteger(claimed) && Number.isSafeInteger(available) && claimed <= Math.abs(purchase?.[head] ?? 0) - (returnedEntitlement.get(key) ?? 0);
      if (valid) { balance.claimed = claimed; balance.available = available; }
    } else if (event.kind === 'REVERSAL') {
      valid &&= magnitude <= balance.available;
      if (valid) { balance.available -= magnitude; if (event.entry.status === 'TEMPORARILY_REVERSED') outstandingReversals.set(event.entry.id, magnitude); }
    } else {
      const prior = ledger.get(event.entry.related_prior_entry_id ?? '');
      const remaining = outstandingReversals.get(prior?.id ?? '') ?? 0;
      valid &&= !!prior && prior.status === 'TEMPORARILY_REVERSED' && historyKey(prior) === key
        && (prior.reversal_period_key ?? prior.tax_period_key) < event.date && magnitude <= remaining
        && Number.isSafeInteger(balance.available + magnitude);
      if (valid) { balance.available += magnitude; outstandingReversals.set(prior!.id, remaining - magnitude); }
    }
    if (!valid) {
      historyInvalid.add(key);
      issue(event.kind === 'CLAIM' ? 'ITC_CUMULATIVE_ENTITLEMENT_EXCEEDED' : 'ITC_CUMULATIVE_BALANCE_INVALID', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', event.entry.id,
        'Cumulative ITC history exceeds source entitlement (including purchase returns) or prior claimed/reclaimable balance; no current movement approved.', head);
    }
    historyBalances.set(key, balance);
  }
  const currentLedger = [...ledger.values()].filter(entry => !supersededLedger.has(entry.id)
    && (periodContainsKey(entry.tax_period_key) || periodContainsKey(entry.reversal_period_key ?? '') || periodContainsKey(entry.reclaim_period_key ?? '')))
    .sort((a, b) => a.source_entity_type.localeCompare(b.source_entity_type) || a.source_entity_id.localeCompare(b.source_entity_id) || a.tax_head.localeCompare(b.tax_head) || a.id.localeCompare(b.id));
  const ledgerBySource = new Map<string, typeof currentLedger>();
  for (const entry of currentLedger) {
    remember('GST_ITC_LEDGER', entry.id, entry, entry.entity_version);
    const key = `${entry.source_entity_type}:${entry.source_entity_id}:${entry.tax_head}`;
    const group = ledgerBySource.get(key) ?? []; group.push(entry); ledgerBySource.set(key, group);
  }
  const booksItcRows: BooksItcRow[] = [];
  const usedLedger = new Set<string>();
  const reclaimedByPrior = new Map<string, number>();
  for (const entry of ledger.values()) if (entry.status === 'RECLAIMED' && entry.related_prior_entry_id && (entry.reclaim_period_key ?? entry.tax_period_key) <= throughPeriodKey) {
    const amount = entry.reclaimed_paise;
    if (amount != null && Number.isSafeInteger(amount) && amount >= 0) reclaimedByPrior.set(entry.related_prior_entry_id, (reclaimedByPrior.get(entry.related_prior_entry_id) ?? 0) + amount);
    remember('GST_ITC_LEDGER', entry.id, entry, entry.entity_version);
  }
  function itcRow(document: NormalizedGstDocument | null, head: GstTaxHead, entry: typeof currentLedger[number] | null, books: number) {
    const key = `${head.toLowerCase()}_paise` as typeof taxKeys[number];
    let status: BooksItcStatus = !entry ? 'UNREVIEWED' : entry.status === 'ELIGIBLE' ? 'ELIGIBLE_IN_BOOKS' : entry.status === 'PENDING_REVIEW' ? 'UNREVIEWED' : entry.status;
    const row: BooksItcRow = { source_entity_type: document?.source_entity_type ?? entry!.source_entity_type, source_entity_id: document?.source_entity_id ?? entry!.source_entity_id,
      ledger_entry_id: entry?.id ?? null, tax_period_key: period.periodKey, source_period_key: entry?.source_period_key ?? document?.document_date.slice(0, 7) ?? entry!.tax_period_key,
      tax_head: head, status, category: entry?.category ?? null, books_tax_paise: books,
      eligible_paise: 0, temporarily_reversed_paise: 0, permanently_reversed_paise: 0,
      reclaimable_paise: 0, reclaimed_paise: 0, approved_paise: 0,
      reason: entry?.reason ?? entry?.reason_code ?? 'Not reviewed', related_prior_entry_id: entry?.related_prior_entry_id ?? null };
    row.reason_code = entry?.reason_code ?? null; row.unreviewed_paise = 0;
    let valid = true;
    if (entry) {
      usedLedger.add(entry.id);
      for (const field of ['books_tax_paise', 'original_eligible_paise', 'temporarily_reversed_paise', 'permanently_reversed_paise', 'reclaimable_paise', 'reclaimed_paise'] as const) {
        if (entry[field] != null && (!Number.isSafeInteger(entry[field]) || (entry[field]! < 0 && !(document?.effect_sign === -1 && field === 'books_tax_paise')))) valid = false;
      }
      const eligibilityPeriod = periodContainsKey(entry.tax_period_key);
      const reversalPeriod = periodContainsKey(entry.reversal_period_key ?? entry.tax_period_key);
      const reclaimPeriod = periodContainsKey(entry.reclaim_period_key ?? entry.tax_period_key);
      const sourcePurchase = purchases.get(entry.source_entity_id);
      const sourceTax = sourcePurchase ? Math.abs(sourcePurchase[key]) : 0;
      const sourceMeta = metadata.get(`PURCHASE:${entry.source_entity_id}`) ?? metadata.get(`PURCHASE_RETURN:${entry.source_entity_id}`);
      if (entry.category === 'RCM' && sourceMeta?.reverse_charge !== 1
        || sourceMeta?.reverse_charge === 1 && status !== 'UNREVIEWED' && entry.category !== 'RCM') {
        valid = false; issue('ITC_RCM_CONTEXT_REQUIRED', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry.id, 'RCM ITC category must match explicitly captured inward reverse-charge source metadata.', key);
      }
      if (status === 'INELIGIBLE' && !['SECTION_16_4', 'POS_RESTRICTION', 'SECTION_17_5', 'PERMANENT_NON_RECLAIMABLE'].includes(entry.reason_code ?? '')) {
        valid = false; issue('ITC_LEGAL_REASON_REQUIRED', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry.id, 'Ineligible ITC requires an explicit supported legal reason; Table 4 disclosure is not guessed.', key);
      }
      if (historyInvalid.has(historyKey(entry))) valid = false;
      if (entry.books_tax_paise != null && Math.abs(entry.books_tax_paise) !== Math.abs(books) && document) valid = false;
      if (status !== 'UNREVIEWED' && (!entry.category || (!entry.reviewed_at && entry.user_confirmation !== 1))) valid = false;
      if (document && (unclassified(document.classification) || !isValidGstin(document.party_gstin) || !document.included)) valid = false;
      const signed = (amount: number | null | undefined) => (document?.effect_sign ?? (sourcePurchase?.reverses_purchase_id || itcNotes.get(entry.source_entity_id)?.note_type === 'CREDIT_NOTE' ? -1 : 1)) * Math.abs(amount ?? 0);
      if (status === 'ELIGIBLE_IN_BOOKS') {
        row.eligible_paise = eligibilityPeriod ? signed(entry.original_eligible_paise ?? (document ? books : 0)) : 0;
        if (document && eligibilityPeriod && Math.abs(row.eligible_paise) > Math.abs(books) || !document && Math.abs(row.eligible_paise) > sourceTax) valid = false;
        row.approved_paise = row.eligible_paise;
        if (sourcePurchase?.reverses_purchase_id && Math.abs(row.approved_paise) > Math.min(Math.abs(sourcePurchase[key]), returnAvailableLimits.get(`${sourcePurchase.id}:${head}`) ?? 0)) {
          valid = false; issue('ITC_RETURN_DOUBLE_REDUCTION', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry.id,
            'Approved purchase-return reduction exceeds original available claimed ITC; already reversed or never claimed tax cannot be deducted twice.', key);
        }
      } else if (status === 'TEMPORARILY_REVERSED' || status === 'PERMANENTLY_REVERSED') {
        const laterMovement = !document && (entry.source_period_key ?? sourcePurchase?.bill_date.slice(0, 7) ?? entry.tax_period_key) < entry.tax_period_key;
        row.eligible_paise = eligibilityPeriod && !laterMovement ? signed(entry.original_eligible_paise ?? books) : 0;
        row.temporarily_reversed_paise = reversalPeriod && status === 'TEMPORARILY_REVERSED' ? signed(entry.temporarily_reversed_paise ?? books) : 0;
        row.permanently_reversed_paise = reversalPeriod && status === 'PERMANENTLY_REVERSED' ? signed(entry.permanently_reversed_paise ?? books) : 0;
        if (document && eligibilityPeriod && Math.abs(row.eligible_paise) !== Math.abs(books)) valid = false;
        if (document && Math.abs(row.temporarily_reversed_paise + row.permanently_reversed_paise) > Math.abs(books)) valid = false;
        if (!document && Math.abs(row.temporarily_reversed_paise + row.permanently_reversed_paise) > sourceTax) valid = false;
        row.reclaimable_paise = status === 'TEMPORARILY_REVERSED' ? Math.max(0, Math.abs(row.temporarily_reversed_paise) - (reclaimedByPrior.get(entry.id) ?? 0)) : 0;
        row.approved_paise = row.eligible_paise - row.temporarily_reversed_paise - row.permanently_reversed_paise;
        if (!reversalPeriod && eligibilityPeriod) status = row.status = 'ELIGIBLE_IN_BOOKS';
      } else if (status === 'INELIGIBLE' && ['SECTION_17_5', 'PERMANENT_NON_RECLAIMABLE'].includes(entry.reason_code ?? '') && eligibilityPeriod) {
        row.eligible_paise = signed(books); row.permanently_reversed_paise = signed(books);
      } else if (status === 'RECLAIMABLE') {
        const prior = ledger.get(entry.related_prior_entry_id ?? '');
        const remaining = outstandingReversals.get(prior?.id ?? '') ?? 0;
        if (!prior || prior.status !== 'TEMPORARILY_REVERSED' || historyKey(prior) !== historyKey(entry)
          || entry.reclaimable_paise == null || entry.reclaimable_paise !== remaining) valid = false;
        // Balance is emitted once from the original temporary reversal, below.
        row.reclaimable_paise = 0;
      }
      else if (status === 'RECLAIMED') {
        const prior = ledger.get(entry.related_prior_entry_id ?? '');
        if (prior) remember('GST_ITC_LEDGER', prior.id, prior, prior.entity_version);
        row.reclaimed_paise = reclaimPeriod ? entry.reclaimed_paise ?? 0 : 0;
        if (!prior || prior.status !== 'TEMPORARILY_REVERSED' || prior.tax_head !== head
          || prior.source_entity_id !== entry.source_entity_id || prior.source_entity_type !== entry.source_entity_type
          || (prior.reversal_period_key ?? prior.tax_period_key) >= (entry.reclaim_period_key ?? entry.tax_period_key)
          || !Number.isSafeInteger(prior.temporarily_reversed_paise)
          || (reclaimedByPrior.get(prior.id) ?? 0) > (prior.temporarily_reversed_paise ?? 0)) {
          valid = false; issue('RECLAIM_EXCEEDS_BALANCE', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry.id, 'Reclaim lacks an earlier matching temporary reversal or exceeds its remaining balance.', key);
        }
        row.eligible_paise = row.reclaimed_paise; row.approved_paise = row.reclaimed_paise;
      }
    }
    if (!valid) {
      issue('ITC_REVIEW_INVALID', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry!.id, 'ITC review lacks valid amounts, source, category or review evidence.', key);
      status = row.status = 'UNREVIEWED'; row.eligible_paise = row.temporarily_reversed_paise = row.permanently_reversed_paise = row.reclaimed_paise = row.reclaimable_paise = row.approved_paise = 0;
    }
    if (books && status === 'ELIGIBLE_IN_BOOKS') {
      const remainder = books - row.eligible_paise;
      row.unreviewed_paise = remainder; row.books_tax_paise -= remainder;
      if (remainder) {
        booksItcRows.push({ ...row, ledger_entry_id: null, status: 'UNREVIEWED', category: null, books_tax_paise: remainder,
          eligible_paise: 0, approved_paise: 0, reclaimable_paise: 0, reclaimed_paise: 0,
          temporarily_reversed_paise: 0, permanently_reversed_paise: 0, unreviewed_paise: remainder,
          reason: 'Unreviewed remainder of partial ITC review.' });
        issue('ITC_UNREVIEWED', 'WARNING', row.source_entity_type, row.source_entity_id, 'Partial eligibility leaves purchase tax unreviewed.', key);
      }
    }
    if (status === 'UNREVIEWED' && books) issue('ITC_UNREVIEWED', 'WARNING', row.source_entity_type, row.source_entity_id, 'Purchase tax remains unreviewed and is not approved Books ITC.', key);
    if (document?.effect_sign === -1 && status === 'UNREVIEWED') {
      const originalId = purchases.get(document.source_entity_id)?.reverses_purchase_id ?? document.original_source_entity_id;
      if ((historyBalances.get(`${originalId}:${head}`)?.claimed ?? 0) > 0 || historyInvalid.has(`${originalId}:${head}`)) issue('PURCHASE_RETURN_ITC_REVIEW_REQUIRED', 'BLOCKING_ERROR', document.source_entity_type, document.source_entity_id,
        'Original purchase has claimed ITC; explicitly review the purchase-return reduction before CA readiness.', key);
    }
    booksItcRows.push(row);
  }
  for (const document of inwardIncluded) for (const head of taxHeads) {
    const key = `${head.toLowerCase()}_paise` as typeof taxKeys[number];
    const group = ledgerBySource.get(`${document.source_entity_type}:${document.source_entity_id}:${head}`)
      ?? (document.source_entity_type === 'PURCHASE_RETURN' ? ledgerBySource.get(`PURCHASE:${document.source_entity_id}:${head}`) : undefined) ?? [];
    if (group.length > 1) issue('DUPLICATE_ITC_REVIEW', 'BLOCKING_ERROR', document.source_entity_type, document.source_entity_id, 'Multiple ITC entries affect the same source/head/period; not approved.');
    if (group.length > 1) for (const entry of group) usedLedger.add(entry.id);
    if (document[key] || group.length) itcRow(document, head, group.length === 1 ? group[0] : null, document[key]);
  }
  for (const entry of currentLedger) if (!usedLedger.has(entry.id)) {
    // Period movements for old purchases do not add purchase tax a second time.
    const sourcePurchase = purchases.get(entry.source_entity_id);
    const sourceLines = purchaseLines.get(entry.source_entity_id) ?? [];
    const sourceMeta = metadata.get(`PURCHASE:${entry.source_entity_id}`) ?? metadata.get(`PURCHASE_RETURN:${entry.source_entity_id}`);
    const origin = sourcePurchase?.supplier_state_code ?? '';
    const destination = sourceMeta?.place_of_supply_state_code ?? period.gstinSnapshot.slice(0, 2);
    const sourceTotals = emptyAmounts();
    let linesValid = sourceLines.length > 0;
    for (const line of sourceLines) {
      if (['taxable_paise', ...taxKeys, 'line_total_paise'].some(key => !Number.isSafeInteger(line[key as keyof Line]))) { linesValid = false; continue; }
      add(sourceTotals, { taxable_paise: Math.abs(line.taxable_paise), igst_paise: Math.abs(line.igst_paise), cgst_paise: Math.abs(line.cgst_paise), sgst_paise: Math.abs(line.sgst_paise), cess_paise: Math.abs(line.cess_paise), pre_round_total_paise: Math.abs(line.line_total_paise) });
    }
    const note = itcNotes.get(entry.source_entity_id);
    const sourceExists = sourcePurchase && sourcePurchase.status !== 'draft' && sourcePurchase.status !== 'cancelled'
      && !sourcePurchase.replaced_by_purchase_id && isValidGstin(suppliers.get(sourcePurchase.supplier_id)?.gstin ?? '')
      && isDateOnly(sourcePurchase.bill_date) && sourcePurchase.bill_date < period.periodStart
      && (!entry.source_period_key || entry.source_period_key === sourcePurchase.bill_date.slice(0, 7))
      && (entry.source_entity_type === 'PURCHASE' || entry.source_entity_type === 'PURCHASE_RETURN' || entry.source_entity_type === 'GST_NOTE' && !!note)
      && [...taxKeys, 'taxable_paise', 'pre_round_total_paise', 'round_off_paise', 'total_paise'].every(key => Number.isSafeInteger(sourcePurchase[key as GstAmountKey]))
      && linesValid && (['taxable_paise', ...taxKeys, 'pre_round_total_paise'] as const).every(key => sourceTotals[key] === Math.abs(sourcePurchase[key]))
      && sourcePurchase.pre_round_total_paise === sourcePurchase.taxable_paise + taxKeys.reduce((total, key) => total + sourcePurchase[key], 0)
      && sourcePurchase.total_paise === sourcePurchase.pre_round_total_paise + sourcePurchase.round_off_paise
      && isValidStateCode(origin) && isValidStateCode(destination) && (origin !== destination) === (sourcePurchase.is_interstate === 1)
      && (sourcePurchase.is_interstate ? sourcePurchase.cgst_paise === 0 && sourcePurchase.sgst_paise === 0 : sourcePurchase.igst_paise === 0)
      && (!sourceMeta?.supply_category || sourceMeta.supply_category === 'DOMESTIC')
      && (!sourceMeta?.section_9_5_role || sourceMeta.section_9_5_role === 'NONE');
    const group = ledgerBySource.get(`${entry.source_entity_type}:${entry.source_entity_id}:${entry.tax_head}`)!;
    if (group.length > 1) {
      issue('DUPLICATE_ITC_REVIEW', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry.id, 'Multiple effective entries affect the same prior source/head/period; no movement approved.');
      continue;
    }
    if (!sourceExists || !['ELIGIBLE', 'ELIGIBLE_IN_BOOKS', 'RECLAIMED', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED', 'RECLAIMABLE'].includes(entry.status)) {
      issue('ITC_SOURCE_NOT_INCLUDED', 'BLOCKING_ERROR', 'GST_ITC_LEDGER', entry.id, 'ITC entry has no included purchase or supported prior-period movement.');
      continue;
    }
    const source = purchases.get(entry.source_entity_id)!;
    remember('ITC_SOURCE_PURCHASE', source.id, { header: source, lines: purchaseLines.get(source.id) ?? [], metadata: metadata.get(`PURCHASE:${source.id}`) ?? metadata.get(`PURCHASE_RETURN:${source.id}`) ?? null }, source.entity_version, source.bill_date);
    itcRow(null, entry.tax_head, entry, 0);
  }
  const booksItc = Object.fromEntries([...statuses, 'TOTAL_BOOKS_TAX', 'NET_APPROVED'].map(status => [status, emptyAmounts()])) as MonthlyGstCalculation['totals']['booksItc'];
  const booksItcStatusPartitions = Object.fromEntries(statuses.map(status => [status, emptyAmounts()])) as Record<BooksItcStatus, GstAmounts>;
  for (const row of booksItcRows) {
    const key = `${row.tax_head.toLowerCase()}_paise` as typeof taxKeys[number];
    add(booksItc.TOTAL_BOOKS_TAX, { [key]: row.books_tax_paise });
    add(booksItcStatusPartitions[row.status], { [key]: row.books_tax_paise });
    if (row.status === 'UNREVIEWED' || row.status === 'INELIGIBLE') add(booksItc[row.status], { [key]: row.books_tax_paise });
    add(booksItc.ELIGIBLE_IN_BOOKS, { [key]: row.eligible_paise - row.reclaimed_paise });
    add(booksItc.TEMPORARILY_REVERSED, { [key]: row.temporarily_reversed_paise });
    add(booksItc.PERMANENTLY_REVERSED, { [key]: row.permanently_reversed_paise });
    add(booksItc.RECLAIMED, { [key]: row.reclaimed_paise });
    add(booksItc.NET_APPROVED, { [key]: row.approved_paise });
  }
  // Outstanding carryforward is a balance, not another month's reversal/claim movement.
  for (const [id, remaining] of outstandingReversals) {
    const entry = ledger.get(id)!;
    if (historyInvalid.has(historyKey(entry))) continue;
    const key = `${entry.tax_head.toLowerCase()}_paise` as typeof taxKeys[number];
    add(booksItc.RECLAIMABLE, { [key]: remaining });
    const row = booksItcRows.find(row => row.ledger_entry_id === id);
    if (row) row.reclaimable_paise = remaining;
    else if (remaining) booksItcRows.push({ source_entity_type: entry.source_entity_type, source_entity_id: entry.source_entity_id,
      ledger_entry_id: id, tax_period_key: period.periodKey, source_period_key: entry.source_period_key ?? entry.tax_period_key,
      tax_head: entry.tax_head, status: 'RECLAIMABLE', category: entry.category, books_tax_paise: 0, eligible_paise: 0,
      temporarily_reversed_paise: 0, permanently_reversed_paise: 0, reclaimable_paise: remaining, reclaimed_paise: 0, approved_paise: 0,
      reason: 'Outstanding temporary reversal carried forward; no repeated period movement.', related_prior_entry_id: entry.related_prior_entry_id });
  }
  issue('BOOKS_ITC_PORTAL_RECONCILIATION_REQUIRED', 'WARNING', 'REPORT', period.periodKey, 'Books ITC is subject to CA review and reconciliation with GST Portal data.');
  for (const expense of sources.expenses) if (expense.business_id === businessId && dateInPeriod(expense.expense_date, period)) {
    remember('EXPENSE', expense.id, expense, expense.entity_version, expense.expense_date, 'EXCLUDED');
    if (expense.tax_paise) issue('INSUFFICIENT_GST_DETAIL', 'WARNING', 'EXPENSE', expense.id, 'Aggregate expense tax is excluded from approved ITC because tax-head and supplier invoice details are unavailable.');
  }

  const documentSeries = buildDocumentSeries(outwardDocuments);
  for (const series of documentSeries) if (series.status !== 'PASS') issue(series.duplicates.length ? 'DOCUMENT_SERIES_DUPLICATE' : 'DOCUMENT_SERIES_REVIEW', series.duplicates.length ? 'BLOCKING_ERROR' : 'WARNING', 'DOCUMENT_SERIES', series.series, 'Document series contains duplicates, gaps or non-sequential numbers.');
  if (rules?.documentSeriesRequired && outwardIncluded.length && !documentSeries.length) issue('DOCUMENT_SERIES_REQUIRED', 'BLOCKING_ERROR', 'REPORT', period.periodKey, 'Applicable document-series data is required.');
  const outwardGross = summary(outwardDocuments.filter(d => !outwardNoteIds.has(d.source_entity_id)), outwardRateRows);
  const outwardNoteSummary = summary(outwardNotes, outwardRateRows), outwardNet = summary(outwardDocuments, outwardRateRows);
  const inwardGross = summary(inwardDocuments.filter(d => !inwardNoteIds.has(d.source_entity_id)), inwardRateRows);
  const inwardNoteSummary = summary(inwardNotes, inwardRateRows), inwardNet = summary(inwardDocuments, inwardRateRows);
  const classifiedOutward = outwardIncluded.filter(d => !unclassified(d.classification));
  const classifiedOutwardRates = outwardRateRows.filter(row => !unclassified(row.classification));
  const outputLiability = sum(classifiedOutwardRates.filter(row => !row.reverse_charge && !['ECO_9_5_SUPPLIER', 'NIL_RATED', 'EXEMPT', 'NON_GST'].includes(row.classification)));
  const rcmDocuments = inwardIncluded.filter(d => d.classification === 'RCM'), rcmLiability = sum(inwardRateRows.filter(row => row.classification === 'RCM'));
  const indicativeWorkingBalance = emptyAmounts();
  for (const key of taxKeys) add(indicativeWorkingBalance, { [key]: outputLiability[key] + rcmLiability[key] - booksItc.NET_APPROVED[key] }, 'INDICATIVE_BALANCE');

  const fields: Gstr3bWorkingField[] = [];
  function field(table: string, measure: GstAmountKey, amount: number | null, sourceStatus: Gstr3bWorkingField['source_status'], ids: string[], g1: number | null = null, itc: number | null = null) {
    fields.push({ table_code: table, measure, books_derived_paise: sourceStatus === 'SALES_BOOKS' || sourceStatus === 'PURCHASE_BOOKS' ? amount : null,
      gstr1_working_paise: g1, approved_books_itc_paise: itc, calculated_paise: amount, ca_adjustment_paise: 0,
      final_working_paise: amount, source_status: amount === null ? 'NOT_AVAILABLE' : sourceStatus,
      source_document_count: new Set(ids).size, source_entity_ids: [...new Set(ids)].sort(), adjustment_ids: [], notes: '' });
  }
  const tableDocuments: Record<string, NormalizedGstDocument[]> = {
    '3.1(a)': classifiedOutward.filter(d => ['B2B', 'B2CL', 'B2CS', 'DEEMED_EXPORT'].includes(d.classification)),
    '3.1(b)': classifiedOutward.filter(d => d.classification.startsWith('EXPORT') || d.classification.startsWith('SEZ')),
    '3.1(c)': classifiedOutward.filter(d => ['NIL_RATED', 'EXEMPT'].includes(d.classification)),
    '3.1(d)': rcmDocuments, '3.1(e)': classifiedOutward.filter(d => d.classification === 'NON_GST'),
    '3.1.1(i)': classifiedOutward.filter(d => d.classification === 'ECO_9_5_LIABLE'),
    '3.1.1(ii)': classifiedOutward.filter(d => d.classification === 'ECO_9_5_SUPPLIER'),
  };
  for (const [table, documents] of Object.entries(tableDocuments)) {
    const categories = table === '3.1(a)' ? ['B2B', 'B2CL', 'B2CS', 'DEEMED_EXPORT'] : table === '3.1(b)' ? ['EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT'] : table === '3.1(c)' ? ['NIL_RATED', 'EXEMPT'] : table === '3.1(e)' ? ['NON_GST'] : table === '3.1.1(i)' ? ['ECO_9_5_LIABLE'] : ['ECO_9_5_SUPPLIER'];
    const allocated = table === '3.1(d)' ? inwardRateRows.filter(row => row.classification === 'RCM') : classifiedOutwardRates.filter(row => !row.reverse_charge && categories.includes(row.classification));
    const totals = sum(allocated);
    for (const key of ['taxable_paise', ...taxKeys] as const) field(table, key, totals[key], table === '3.1(d)' ? 'PURCHASE_BOOKS' : 'SALES_BOOKS', allocated.map(d => d.source_entity_id), table === '3.1(d)' ? null : totals[key]);
  }
  const categoryTables: Record<string, string> = { IMPORT_GOODS: '4(A)(1)', IMPORT_SERVICES: '4(A)(2)', RCM: '4(A)(3)', ISD: '4(A)(4)', OTHER_ITC: '4(A)(5)' };
  for (const head of taxHeads) {
    const key = `${head.toLowerCase()}_paise` as typeof taxKeys[number];
    const rows = booksItcRows.filter(r => r.tax_head === head);
    for (const [category, table] of Object.entries(categoryTables)) {
      const matched = rows.filter(r => r.category === category);
      const amount = sum(matched.map(r => ({ [key]: r.eligible_paise })))[key];
      field(table, key, amount, 'APPROVED_BOOKS_ITC', matched.map(r => r.source_entity_id), null, amount);
    }
    for (const [table, measure] of [['4(B)(1)', 'permanently_reversed_paise'], ['4(B)(2)', 'temporarily_reversed_paise'], ['4(D)(1)', 'reclaimed_paise']] as const) {
      const amount = sum(rows.map(r => ({ [key]: r[measure] })))[key];
      field(table, key, amount, 'APPROVED_BOOKS_ITC', rows.filter(r => r[measure]).map(r => r.source_entity_id), null, amount);
    }
    field('4(C)', key, booksItc.NET_APPROVED[key], 'APPROVED_BOOKS_ITC', rows.filter(r => r.approved_paise).map(r => r.source_entity_id), null, booksItc.NET_APPROVED[key]);
    const restricted = rows.filter(r => r.status === 'INELIGIBLE' && ['SECTION_16_4', 'POS_RESTRICTION'].includes(r.reason_code ?? ''));
    field('4(D)(2)', key, sum(restricted.map(r => ({ [key]: r.books_tax_paise })))[key], 'APPROVED_BOOKS_ITC', restricted.map(r => r.source_entity_id));
    for (const table of ['5.1.INTEREST', '5.1.LATE_FEE', '6.1.CASH', '6.1.CREDIT', '6.1.PAYMENT']) field(table, key, null, 'NOT_AVAILABLE', []);
  }
  for (const interstate of [false, true]) for (const category of ['NIL_EXEMPT', 'NON_GST']) {
      const rows = inwardRateRows.filter(d => d.is_interstate === interstate
      && (category === 'NON_GST' ? d.classification === 'NON_GST' : ['NIL_RATED', 'EXEMPT'].includes(d.classification)));
    field(`5.${category}.${interstate ? 'INTERSTATE' : 'INTRASTATE'}`, 'taxable_paise', sum(rows).taxable_paise, 'PURCHASE_BOOKS', rows.map(r => r.source_entity_id));
  }
  for (const adjustment of [...sources.adjustments].sort((a, b) => a.id.localeCompare(b.id))) {
    if (adjustment.business_id !== businessId || !periodContainsKey(adjustment.tax_period_key ?? '')) continue;
    remember('GST_ADJUSTMENT', adjustment.id, adjustment, adjustment.entity_version);
    const key = adjustment.measure ?? (adjustment.tax_head ? `${adjustment.tax_head.toLowerCase()}_paise` as GstAmountKey : null);
    const target = fields.find(f => f.table_code === adjustment.table_code && f.measure === key);
    const delta = adjustment.adjustment_paise;
    if (!key || !target || adjustment.report_type !== 'GSTR3B_DRAFT' || !Number.isSafeInteger(delta) || !adjustment.reason.trim()
      || adjustment.measure === 'taxable_paise' && adjustment.tax_head !== null
      || adjustment.measure !== 'taxable_paise' && adjustment.tax_head !== key.slice(0, -6).toUpperCase()) {
      issue('INVALID_CA_ADJUSTMENT', 'BLOCKING_ERROR', 'GST_ADJUSTMENT', adjustment.id, 'Adjustment requires a supported Draft 3B table, explicit integer delta, period and reason.'); continue;
    }
    const next = target.ca_adjustment_paise + delta!;
    if (!Number.isSafeInteger(next) || !Number.isSafeInteger((target.calculated_paise ?? 0) + next)) {
      issue('UNSAFE_CA_ADJUSTMENT', 'BLOCKING_ERROR', 'GST_ADJUSTMENT', adjustment.id, 'Adjustment exceeds safe integer range.'); continue;
    }
    target.ca_adjustment_paise = next; target.final_working_paise = (target.calculated_paise ?? 0) + next;
    target.source_status = 'MANUAL_CA_ADJUSTMENT'; target.adjustment_ids.push(adjustment.id);
    target.notes += `${adjustment.reason}${adjustment.note ? ': ' + adjustment.note : ''}\n`;
    issue('MANUAL_CA_ADJUSTMENT', 'WARNING', 'GST_ADJUSTMENT', adjustment.id, 'Manual delta changes final working only; books-derived calculation is preserved.');
  }
  const finalTable4Net = emptyAmounts();
  for (const f of fields) if (f.table_code.startsWith('4(A)') || f.table_code.startsWith('4(B)')) add(finalTable4Net, { [f.measure]: (f.table_code.startsWith('4(B)') ? -1 : 1) * (f.final_working_paise ?? 0) });
  for (const net of fields.filter(f => f.table_code === '4(C)')) {
    const derived = finalTable4Net[net.measure];
    const explicitAdjustment = net.adjustment_ids.length > 0;
    if (explicitAdjustment && net.final_working_paise !== derived) {
      issue('TABLE4_FINAL_NET_CONFLICT', 'BLOCKING_ERROR', 'REPORT', '4(C)', 'Direct 4(C) adjustment conflicts with adjusted 4A minus 4B.', net.measure);
      net.source_status = 'REVIEW_REQUIRED';
    } else {
      net.final_working_paise = derived;
      net.ca_adjustment_paise = derived - (net.calculated_paise ?? 0);
      const contributing = fields.filter(f => f.measure === net.measure && (f.table_code.startsWith('4(A)') || f.table_code.startsWith('4(B)')));
      net.adjustment_ids = [...new Set([...net.adjustment_ids, ...contributing.flatMap(f => f.adjustment_ids)])].sort();
      if (net.adjustment_ids.length) { net.source_status = 'MANUAL_CA_ADJUSTMENT'; net.notes += 'Final 4(C) derived from adjusted 4A minus 4B.\n'; }
    }
  }
  const interstateGroups = new Map<string, GstAmounts & { place_of_supply: string; recipient_category: string; source_entity_ids: string[] }>();
  for (const row of classifiedOutwardRates) if (row.is_interstate && !row.reverse_charge && ['UNREGISTERED', 'COMPOSITION', 'UIN'].includes(row.recipient_category ?? '')
    && ['B2B', 'B2CL', 'B2CS'].includes(row.classification)) {
    const key = `${row.place_of_supply}:${row.recipient_category}`;
    const group = interstateGroups.get(key) ?? { ...emptyAmounts(), place_of_supply: row.place_of_supply, recipient_category: row.recipient_category!, source_entity_ids: [] };
    add(group, row); group.source_entity_ids.push(row.source_entity_id); interstateGroups.set(key, group);
  }

  const reconciliations: GstReconciliationResult[] = [];
  function reconcile(code: string, source: GstAmounts, calculated: GstAmounts, documents: NormalizedGstDocument[], detailCount: number,
    keys: GstAmountKey[] = amountKeys, sourceCount = documents.length, sectionCount = documents.length) {
    const variance = emptyAmounts();
    for (const key of keys) variance[key] = calculated[key] - source[key];
    const fail = keys.some(key => variance[key] !== 0 || !Number.isSafeInteger(variance[key])) || sourceCount !== sectionCount;
    reconciliations.push({ code, status: fail ? 'ERROR' : 'PASS', source_document_count: sourceCount, section_document_count: sectionCount,
      detail_row_count: detailCount, party_count: new Set(documents.map(d => d.party_gstin).filter(Boolean)).size,
      source, calculated, variance, source_entity_ids: documents.map(d => d.source_entity_id).sort(), message: fail ? 'Unexplained variance; CA readiness blocked.' : 'Exact fixed-point reconciliation.' });
    if (fail) issue('RECONCILIATION_VARIANCE', 'BLOCKING_ERROR', 'REPORT', code, `${code}: unexplained source/working variance.`, null, null, variance);
  }
  for (const [name, documents, rates, hsn] of [['OUTWARD', outwardIncluded, outwardRateRows, outwardHsnRows], ['INWARD', inwardIncluded, inwardRateRows, inwardHsnRows]] as const) {
    const source = sum([...documents]);
    reconcile(`${name}_RATE_HEADERS`, source, sum([...rates]), [...documents], rates.length, ['taxable_paise', ...taxKeys, 'pre_round_total_paise']);
    reconcile(`${name}_HSN_LINES`, sum([...rates]), sum([...hsn]), [...documents], hsn.length, ['taxable_paise', ...taxKeys, 'pre_round_total_paise']);
    for (const group of ['B2B', 'B2C', 'COMBINED', 'UNCLASSIFIED'] as const) {
      const groupRates = rates.filter(row => row.recipient_group === group), groupHsn = hsn.filter(row => row.recipient_group === group);
      const ids = new Set(groupRates.map(row => row.source_entity_id));
      const groupDocs = documents.filter(document => ids.has(document.source_entity_id));
      reconcile(`${name}_HSN_${group}`, sum([...groupRates]), sum([...groupHsn]), [...groupDocs], groupHsn.length, ['taxable_paise', ...taxKeys, 'pre_round_total_paise']);
    }
  }
  for (const [section, documents] of Object.entries(sections)) {
    reconcile(`GSTR1_SECTION_${section}`, sum(documents), sum(sectionRates[section]), documents, sectionRates[section].length, ['taxable_paise', ...taxKeys, 'pre_round_total_paise']);
  }
  reconcile('B2CS_AGGREGATES', sum(sectionRates.B2CS), sum(b2csAggregates), sections.B2CS, b2csAggregates.length, ['taxable_paise', ...taxKeys, 'pre_round_total_paise']);
  reconcile('GSTR1_SECTION_TOTALS', outwardNet, sum(Object.values(sectionSummaries)), outwardIncluded, outwardRateRows.length,
    amountKeys, outwardIncluded.length, Object.values(sectionSummaries).reduce((count, s) => count + s.document_count, 0));
  const g3Outward = sum(fields.filter(f => ['3.1(a)', '3.1(b)', '3.1(c)', '3.1(e)', '3.1.1(i)', '3.1.1(ii)'].includes(f.table_code)).map(f => ({ [f.measure]: f.calculated_paise ?? 0 })));
  reconcile('GSTR1_TO_3B', sum(classifiedOutwardRates.filter(row => !row.reverse_charge)), g3Outward, classifiedOutward, classifiedOutward.length, ['taxable_paise', ...taxKeys]);
  reconcile('PURCHASE_GROSS_NOTES_NET', inwardNet, sum([inwardGross, inwardNoteSummary]), inwardIncluded, inwardRateRows.length);
  reconcile('PURCHASE_TAX_ITC_LEDGER', inwardNet, booksItc.TOTAL_BOOKS_TAX, inwardIncluded, booksItcRows.length, [...taxKeys]);
  reconcile('ITC_BOOKS_STATUS_PARTITIONS', booksItc.TOTAL_BOOKS_TAX, sum(Object.values(booksItcStatusPartitions)), inwardIncluded, booksItcRows.length, [...taxKeys]);
  const itcMovementNet = emptyAmounts();
  for (const key of taxKeys) add(itcMovementNet, { [key]: booksItc.ELIGIBLE_IN_BOOKS[key] - booksItc.TEMPORARILY_REVERSED[key] - booksItc.PERMANENTLY_REVERSED[key] + booksItc.RECLAIMED[key] });
  reconcile('ITC_MOVEMENTS_NET_APPROVED', booksItc.NET_APPROVED, itcMovementNet, inwardIncluded, booksItcRows.length, [...taxKeys]);
  const ledgerNet = sum(fields.filter(f => f.table_code === '4(C)').map(f => ({ [f.measure]: f.calculated_paise ?? 0 })));
  reconcile('APPROVED_ITC_TO_3B', booksItc.NET_APPROVED, ledgerNet, inwardIncluded, booksItcRows.length, [...taxKeys]);
  const table4Net = emptyAmounts();
  for (const f of fields) if (f.table_code.startsWith('4(A)') || f.table_code.startsWith('4(B)')) add(table4Net, { [f.measure]: (f.table_code.startsWith('4(B)') ? -1 : 1) * (f.calculated_paise ?? 0) });
  reconcile('TABLE4_A_MINUS_B', booksItc.NET_APPROVED, table4Net, inwardIncluded, booksItcRows.length, [...taxKeys]);
  const final4C = sum(fields.filter(f => f.table_code === '4(C)').map(f => ({ [f.measure]: f.final_working_paise ?? 0 })));
  reconcile('TABLE4_FINAL_A_MINUS_B', finalTable4Net, final4C, inwardIncluded, booksItcRows.length, [...taxKeys]);
  const rcmReviewed = booksItcRows.filter(row => row.category === 'RCM' && row.status !== 'UNREVIEWED');
  const explicitRcm = new Set([...purchases.values()].filter(source => (metadata.get(`PURCHASE:${source.id}`) ?? metadata.get(`PURCHASE_RETURN:${source.id}`))?.reverse_charge === 1).map(source => source.id));
  reconcile('RCM_ITC_CONTEXT', sum(rcmReviewed.map(row => ({ [`${row.tax_head.toLowerCase()}_paise`]: row.approved_paise }))),
    sum(rcmReviewed.filter(row => explicitRcm.has(row.source_entity_id)).map(row => ({ [`${row.tax_head.toLowerCase()}_paise`]: row.approved_paise }))), rcmDocuments, rcmReviewed.length, [...taxKeys]);
  const seriesSource = outwardDocuments.filter(d => d.included || d.cancelled || d.exclusion_reason === 'DUPLICATE' || d.classification.startsWith('UNCLASSIFIED'));
  reconcile('DOCUMENT_SERIES_COUNT', emptyAmounts(), emptyAmounts(), seriesSource, documentSeries.length, [], seriesSource.length, documentSeries.reduce((count, row) => count + row.total_issued, 0));
  const sourceCancelled = seriesSource.filter(document => document.cancelled).length;
  reconcile('DOCUMENT_SERIES_CANCELLED', emptyAmounts(), emptyAmounts(), seriesSource, documentSeries.length, [], sourceCancelled, documentSeries.reduce((count, row) => count + row.cancelled, 0));
  reconcile('DOCUMENT_SERIES_NET_ISSUED', emptyAmounts(), emptyAmounts(), seriesSource, documentSeries.length, [], seriesSource.length - sourceCancelled, documentSeries.reduce((count, row) => count + row.net_issued, 0));
  for (const nature of new Set(seriesSource.map(document => document.document_type))) {
    const documents = seriesSource.filter(document => document.document_type === nature), rows = documentSeries.filter(row => row.document_nature === nature);
    const cancelled = documents.filter(document => document.cancelled).length;
    for (const [measure, sourceCount, calculatedCount] of [
      ['ISSUED', documents.length, rows.reduce((count, row) => count + row.total_issued, 0)],
      ['CANCELLED', cancelled, rows.reduce((count, row) => count + row.cancelled, 0)],
      ['NET', documents.length - cancelled, rows.reduce((count, row) => count + row.net_issued, 0)],
    ] as const) reconcile(`DOCUMENT_SERIES_${nature}_${measure}`, emptyAmounts(), emptyAmounts(), documents, rows.length, [], sourceCount, calculatedCount);
  }
  const effectiveActivity = outwardIncluded.length > 0 || inwardIncluded.length > 0
    || booksItcRows.some(row => row.eligible_paise !== 0 || row.temporarily_reversed_paise !== 0 || row.permanently_reversed_paise !== 0 || row.reclaimed_paise !== 0 || row.reclaimable_paise !== 0)
    || fields.some(field => field.adjustment_ids.length > 0);
  if (!effectiveActivity) issue('NIL_PERIOD_NOT_CONFIRMED', 'WARNING', 'REPORT', period.periodKey, 'Empty local books do not establish completeness of a nil return period.');
  const hasBlocking = issues.some(i => i.severity === 'BLOCKING_ERROR');
  return { businessName: sources.business.name, schemaVersion: 1, ruleSetVersion: GST_RULE_SET_VERSION,
    businessId, gstinSnapshot: period.gstinSnapshot, period: { ...period }, generatedAt, sourceDataHash: '',
    status: hasBlocking ? 'INCOMPLETE' : !effectiveActivity ? 'DRAFT' : 'READY_FOR_CA_REVIEW',
    sourceManifest: [...manifest.values()].sort((a, b) => a.entity_type.localeCompare(b.entity_type) || a.entity_id.localeCompare(b.entity_id)),
    outwardDocuments, inwardDocuments, outwardRateRows, inwardRateRows, outwardHsnRows, inwardHsnRows,
    outwardNotes, inwardNotes, booksItcRows, gstr1Sections: { summaries: sectionSummaries, documents: sections, rateRows: sectionRates,
      hsnB2b: outwardHsnRows.filter(r => r.recipient_group === 'B2B'), hsnB2c: outwardHsnRows.filter(r => r.recipient_group === 'B2C'), b2csAggregates,
      iffReportedSourceIds: outwardIncluded.filter(row => row.iff_reported_period).map(row => row.source_entity_id).sort(),
      ...(period.periodType === 'QUARTER' ? {
        quarterPendingDocuments: outwardIncluded.filter(row => !row.iff_reported_period),
        quarterPendingRateRows: outwardRateRows.filter(row => !outwardById.get(row.source_entity_id)?.iff_reported_period),
      } : {}) },
    gstr3bSections: { fields, interstateSupplies: [...interstateGroups.values()].sort((a, b) => a.place_of_supply.localeCompare(b.place_of_supply) || a.recipient_category.localeCompare(b.recipient_category)),
      disclaimer: 'Indicative GST working before GSTR-2B reconciliation, electronic ledger balances, statutory ITC utilization, interest, late fee and CA review.' },
    documentSeries, totals: { outwardGross, outwardNotes: outwardNoteSummary, outwardNet, inwardGross, inwardNotes: inwardNoteSummary, inwardNet,
      booksItc, booksItcStatusPartitions, outputLiability, rcmLiability, indicativeWorkingBalance }, issues, reconciliations };
}
