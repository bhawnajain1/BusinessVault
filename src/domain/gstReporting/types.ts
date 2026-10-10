import type {
  Business, Invoice, InvoiceLine, Purchase, PurchaseLine, SalesReturn,
  SalesReturnItem, Customer, Supplier, GstProfile, GstAato, GstDocumentMetadata,
  GstItcLedgerEntry, GstAdjustment, Expense, Advance, LegacyReversalAudit,
  GstNote, Item, Unit,
} from '../../db/types';

export interface GstMonthlySources {
  notes?: GstNote[];
  currentItems?: Item[];
  currentUnits?: Unit[];
  advanceOffsetEvidence?: GstDocumentMetadata[];
  business: Business;
  invoices: Invoice[];
  invoiceLines: InvoiceLine[];
  purchases: Purchase[];
  purchaseLines: PurchaseLine[];
  salesReturns: SalesReturn[];
  salesReturnItems: SalesReturnItem[];
  originalInvoices: Invoice[];
  customers: Customer[];
  suppliers: Supplier[];
  profiles: GstProfile[];
  aato: GstAato[];
  metadata: GstDocumentMetadata[];
  itcEntries: GstItcLedgerEntry[];
  adjustments: GstAdjustment[];
  expenses: Expense[];
  advances: Advance[];
  legacyAudits: LegacyReversalAudit[];
  /** Full-FY canonical identity evidence, including documents outside the selected month. */
  documentIdentityEvidence?: GstDocumentIdentityEvidence[];
}

export interface GstDocumentIdentityEvidence {
  business_id: string;
  source_entity_type: NormalizedGstDocument['source_entity_type'];
  source_entity_id: string;
  document_type: string;
  document_number: string;
  document_date?: string;
  /** Identity-only FY query evidence can supply FY instead of a document date. */
  financial_year?: string;
  direction?: 'OUTWARD' | 'INWARD';
  party_gstin: string | null;
  /** Superseded, reversal, cancelled, and deleted revisions cannot block the live document. */
  reportable?: boolean;
}

export interface GstTaxPeriod {
  businessId: string;
  gstinSnapshot: string;
  financialYear: string;
  filingFrequency: 'MONTHLY' | 'QRMP';
  periodType: 'MONTH' | 'QUARTER';
  periodKey: string;
  periodStart: string;
  nextPeriodStart: string;
}

export type GstTaxHead = 'IGST' | 'CGST' | 'SGST' | 'CESS';
export type GstAmountKey = 'taxable_paise' | 'igst_paise' | 'cgst_paise' | 'sgst_paise'
  | 'cess_paise' | 'pre_round_total_paise' | 'round_off_paise' | 'total_paise';
export interface GstAmounts {
  taxable_paise: number;
  igst_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  cess_paise: number;
  pre_round_total_paise: number;
  round_off_paise: number;
  total_paise: number;
}

/** Tax-only total. `total_paise` remains the source document/line value. */
export function taxTotalPaise(amounts: GstAmounts): number {
  const total = amounts.igst_paise + amounts.cgst_paise + amounts.sgst_paise + amounts.cess_paise;
  if (!Number.isSafeInteger(total)) throw new Error('GST tax total exceeds the safe integer range.');
  return total;
}
export type GstClassification = 'B2B' | 'B2CL' | 'B2CS' | 'EXPORT_WITH_PAYMENT'
  | 'EXPORT_WITHOUT_PAYMENT' | 'SEZ_WITH_PAYMENT' | 'SEZ_WITHOUT_PAYMENT'
  | 'DEEMED_EXPORT' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST' | 'RCM'
  | 'ECO_9_5_SUPPLIER' | 'ECO_9_5_LIABLE' | 'UNCLASSIFIED'
  | 'UNCLASSIFIED_INVALID_GSTIN';

export interface NormalizedGstDocument extends GstAmounts {
  source_entity_type: 'INVOICE' | 'SALES_RETURN' | 'PURCHASE' | 'PURCHASE_RETURN' | 'GST_NOTE' | 'ADVANCE';
  source_entity_id: string;
  source_entity_version: number;
  tax_period_key: string;
  document_type: string;
  document_number: string;
  document_date: string;
  party_id: string;
  party_name: string;
  party_gstin: string;
  recipient_category: string;
  place_of_supply: string;
  is_interstate: boolean;
  classification: GstClassification;
  effect_sign: 1 | -1;
  included: boolean;
  exclusion_reason: string | null;
  cancelled: boolean;
  original_source_entity_id: string | null;
  original_document_number: string | null;
  original_period_key: string | null;
  amendment_kind: string | null;
  ecommerce_operator_gstin: string | null;
  reverse_charge: boolean;
  line_count: number;
  shipping_bill_number?: string | null;
  shipping_bill_date?: string | null;
  port_code?: string | null;
  section_9_5_role?: string | null;
  section_52_tcs?: 0 | 1 | null;
  ecommerce_reporting_type?: string | null;
  direction?: 'OUTWARD' | 'INWARD';
  iff_reported_period?: string | null;
  allocation_only?: boolean;
}
export type NormalizedOutwardDocument = NormalizedGstDocument;
export type NormalizedInwardDocument = NormalizedGstDocument;
export type NormalizedGstNote = NormalizedGstDocument;

/** Previously reported line groups must be complete for attribute-changing amendments. */
export interface GstPreviouslyReportedLine extends GstAmounts {
  source_line_id: string;
  quantity_micros: number;
  tax_rate_bps: number;
  hsn: string;
  description: string;
  uqc_code: string | null;
  goods_or_service: string | null;
  taxability: string;
}
export interface GstPreviouslyReportedValues extends GstAmounts {
  lines: GstPreviouslyReportedLine[];
  classification?: GstClassification;
  recipient_group?: NormalizedHsnRow['recipient_group'];
  place_of_supply?: string;
  is_interstate?: boolean;
  ecommerce_operator_gstin?: string | null;
  party_gstin?: string;
  recipient_category?: string;
  reverse_charge?: boolean;
}

export interface GstAdvanceOffset extends Pick<GstAmounts, 'taxable_paise' | 'igst_paise' | 'cgst_paise' | 'sgst_paise' | 'cess_paise'> {
  advance_id: string;
  /** Required for a partial offset against a mixed-rate advance. */
  lines?: Array<{ advance_line_id: string; taxable_paise: number; igst_paise: number; cgst_paise: number; sgst_paise: number; cess_paise: number }>;
}

export interface NormalizedGstRateRow extends GstAmounts {
  source_entity_type: NormalizedGstDocument['source_entity_type'];
  source_entity_id: string;
  source_line_ids: string[];
  tax_period_key: string;
  classification: GstClassification;
  tax_rate_bps: number;
  taxability: string;
  place_of_supply: string;
  ecommerce_operator_gstin: string | null;
  is_interstate?: boolean;
  recipient_category?: string;
  party_gstin?: string;
  reverse_charge?: boolean;
  recipient_group?: NormalizedHsnRow['recipient_group'];
}
export type NormalizedOutwardRateRow = NormalizedGstRateRow;
export type NormalizedInwardRateRow = NormalizedGstRateRow;

export interface NormalizedHsnRow extends GstAmounts {
  tax_period_key: string;
  recipient_group: 'B2B' | 'B2C' | 'COMBINED' | 'UNCLASSIFIED';
  hsn: string;
  description: string;
  uqc_code: string | null;
  goods_or_service: string | null;
  taxability: string;
  tax_rate_bps: number;
  quantity_micros: number;
  source_entity_ids: string[];
  source_line_ids: string[];
}

export interface GstValidationIssue {
  code: string;
  severity: 'BLOCKING_ERROR' | 'WARNING' | 'INFORMATION';
  tax_period_key: string;
  source_entity_type: string;
  source_entity_id: string;
  document_number: string | null;
  field: string | null;
  message: string;
  recommended_correction: string;
  amount_impact: Partial<GstAmounts> | null;
}

export interface GstSourceManifestEntry {
  entity_type: string;
  entity_id: string;
  entity_version: number;
  document_date: string | null;
  report_effect: 'INCLUDED' | 'EXCLUDED' | 'CONTEXT';
  metadata_version: number | null;
  // Full content, including monetary lines and metadata, is part of the hash input.
  content: unknown;
}

export interface GstSummary extends GstAmounts {
  document_count: number;
  party_count: number;
  detail_row_count: number;
  source_entity_ids: string[];
}
export interface Gstr1WorkingSections {
  summaries: Record<string, GstSummary>;
  documents: Record<string, NormalizedGstDocument[]>;
  rateRows: Record<string, NormalizedGstRateRow[]>;
  hsnB2b: NormalizedHsnRow[];
  hsnB2c: NormalizedHsnRow[];
  b2csAggregates?: GstB2csAggregate[];
  /** Quarter preparation excludes these already-IFF-reported documents; books/3B retain them. */
  iffReportedSourceIds?: string[];
  quarterPendingDocuments?: NormalizedGstDocument[];
  quarterPendingRateRows?: NormalizedGstRateRow[];
}

export interface GstB2csAggregate extends GstAmounts {
  tax_period_key: string;
  place_of_supply: string;
  tax_rate_bps: number;
  supply_type: 'INTERSTATE' | 'INTRASTATE';
  ecommerce_operator_gstin: string | null;
  source_entity_ids: string[];
  source_entity_types?: NormalizedGstDocument['source_entity_type'][];
  source_line_ids: string[];
}

export type BooksItcStatus = 'UNREVIEWED' | 'ELIGIBLE_IN_BOOKS' | 'INELIGIBLE'
  | 'TEMPORARILY_REVERSED' | 'PERMANENTLY_REVERSED' | 'RECLAIMABLE' | 'RECLAIMED';
export interface BooksItcRow {
  source_entity_type: string;
  source_entity_id: string;
  ledger_entry_id: string | null;
  tax_period_key: string;
  source_period_key: string;
  tax_head: GstTaxHead;
  status: BooksItcStatus;
  category: string | null;
  books_tax_paise: number;
  eligible_paise: number;
  temporarily_reversed_paise: number;
  permanently_reversed_paise: number;
  reclaimable_paise: number;
  reclaimed_paise: number;
  approved_paise: number;
  reason: string;
  related_prior_entry_id: string | null;
  reason_code?: string | null;
  /** Partial review remainder; new calculations always populate this. */
  unreviewed_paise?: number;
}
export interface Gstr3bWorkingField {
  table_code: string;
  measure: GstAmountKey;
  books_derived_paise: number | null;
  gstr1_working_paise: number | null;
  approved_books_itc_paise: number | null;
  calculated_paise: number | null;
  ca_adjustment_paise: number;
  final_working_paise: number | null;
  source_status: 'SALES_BOOKS' | 'PURCHASE_BOOKS' | 'APPROVED_BOOKS_ITC'
    | 'MANUAL_CA_ADJUSTMENT' | 'NOT_AVAILABLE' | 'REVIEW_REQUIRED';
  source_document_count: number;
  source_entity_ids: string[];
  adjustment_ids: string[];
  notes: string;
}
export interface Gstr3bWorkingSections {
  fields: Gstr3bWorkingField[];
  interstateSupplies: Array<GstAmounts & {
    place_of_supply: string; recipient_category: string; source_entity_ids: string[];
  }>;
  disclaimer: string;
}

export interface GstDocumentSeriesRow {
  document_nature: string;
  series: string;
  serial_from: string;
  serial_to: string;
  total_issued: number;
  cancelled: number;
  net_issued: number;
  // Ranges avoid materializing millions of missing sequence numbers.
  gaps: Array<{ from: string; to: string }>;
  duplicates: string[];
  source_entity_ids: string[];
  status: 'PASS' | 'WARNING' | 'ERROR';
}
export interface GstReconciliationResult {
  code: string;
  status: 'PASS' | 'WARNING' | 'ERROR';
  source_document_count: number;
  section_document_count: number;
  detail_row_count: number;
  party_count: number;
  source: GstAmounts;
  calculated: GstAmounts;
  variance: GstAmounts;
  source_entity_ids: string[];
  message: string;
}
export interface MonthlyGstTotals {
  outwardGross: GstSummary;
  outwardNotes: GstSummary;
  outwardNet: GstSummary;
  inwardGross: GstSummary;
  inwardNotes: GstSummary;
  inwardNet: GstSummary;
  booksItc: Record<BooksItcStatus | 'TOTAL_BOOKS_TAX' | 'NET_APPROVED', GstAmounts>;
  /** Mutually exclusive current-period books tax, distinct from ITC movements/balances. */
  // Optional only for previously saved v1 calculations; new calculations always emit it.
  booksItcStatusPartitions?: Record<BooksItcStatus, GstAmounts>;
  outputLiability: GstAmounts;
  rcmLiability: GstAmounts;
  indicativeWorkingBalance: GstAmounts;
}
export interface MonthlyGstCalculation {
  businessName: string;
  schemaVersion: number;
  ruleSetVersion: string;
  businessId: string;
  gstinSnapshot: string;
  period: GstTaxPeriod;
  generatedAt: string;
  sourceDataHash: string;
  status: 'DRAFT' | 'INCOMPLETE' | 'READY_FOR_CA_REVIEW';
  sourceManifest: GstSourceManifestEntry[];
  outwardDocuments: NormalizedOutwardDocument[];
  inwardDocuments: NormalizedInwardDocument[];
  outwardRateRows: NormalizedOutwardRateRow[];
  inwardRateRows: NormalizedInwardRateRow[];
  outwardHsnRows: NormalizedHsnRow[];
  inwardHsnRows: NormalizedHsnRow[];
  outwardNotes: NormalizedGstNote[];
  inwardNotes: NormalizedGstNote[];
  booksItcRows: BooksItcRow[];
  gstr1Sections: Gstr1WorkingSections;
  gstr3bSections: Gstr3bWorkingSections;
  documentSeries: GstDocumentSeriesRow[];
  totals: MonthlyGstTotals;
  issues: GstValidationIssue[];
  reconciliations: GstReconciliationResult[];
}
