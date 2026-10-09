import { describe, expect, it } from 'vitest';
import type { Business, Customer, Supplier, Invoice, InvoiceLine, Purchase, PurchaseLine, SalesReturn, SalesReturnItem, GstProfile, GstAato, GstDocumentMetadata, GstItcLedgerEntry, GstAdjustment } from '../../db/types';
import { computeGstinCheckChar } from '../../lib/gst';
import { calculateMonthlyGst } from './calculateMonthlyGst';
import { monthPeriod, quarterPeriod } from './periods';
import type { GstAmounts, GstMonthlySources } from './types';

const gstin = (state: string) => { const base = `${state}AAAAA0000A1Z`; return base + computeGstinCheckChar(base); };
const stamp = { created_at: '2025-05-01T00:00:00Z', updated_at: '2025-05-01T00:00:00Z', entity_version: 1 };
const amount = (taxable = 10000, rate = 1800, round = 0, interstate = false): GstAmounts => {
  const tax = Math.round(taxable * rate / 10000);
  return { taxable_paise: taxable, cgst_paise: interstate ? 0 : Math.floor(tax / 2), sgst_paise: interstate ? 0 : tax - Math.floor(tax / 2),
    igst_paise: interstate ? tax : 0, cess_paise: 0, pre_round_total_paise: taxable + tax, round_off_paise: round, total_paise: taxable + tax + round };
};
function fixture(): GstMonthlySources {
  return {
    business: { ...stamp, id: 'b', name: 'Synthetic Books', gstin: gstin('27'), state_code: '27' } as Business,
    customers: [{ ...stamp, id: 'c', business_id: 'b', name: 'Synthetic Customer', gstin: gstin('27'), state_code: '27' } as Customer],
    suppliers: [{ ...stamp, id: 's', business_id: 'b', name: 'Synthetic Supplier', gstin: gstin('27'), state_code: '27' } as Supplier],
    profiles: [{ ...stamp, id: 'profile', business_id: 'b', gstin: gstin('27'), active: 1, registration_type: 'REGULAR',
      filing_frequency: 'MONTHLY', gst_reporting_enabled: 1, effective_from: '2020-01-01', effective_to: null } as GstProfile],
    aato: [{ ...stamp, id: 'aato', business_id: 'b', financial_year: '2024-25', aato_paise: 10000000, source: 'USER_CONFIRMED', confirmed_at: stamp.created_at } as GstAato],
    invoices: [], invoiceLines: [], purchases: [], purchaseLines: [], salesReturns: [], salesReturnItems: [], originalInvoices: [],
    metadata: [], itcEntries: [], adjustments: [], expenses: [], advances: [], legacyAudits: [],
  };
}
function invoice(s: GstMonthlySources, id = 'i', options: Partial<Invoice> = {}, taxable = 10000, rate = 1800) {
  const amounts = amount(taxable, rate, options.round_off_paise ?? 0, options.is_interstate === 1);
  const header = { ...stamp, business_id: 'b', id, invoice_number: `INV-${id}`, invoice_date: '2025-05-15',
    customer_id: 'c', place_of_supply: '27', is_interstate: 0, status: 'issued', reverses_invoice_id: null,
    reversed_by_invoice_id: null, financial_year: '2025-26', ...amounts, ...options } as Invoice;
  const line = { id: `line-${id}`, business_id: 'b', invoice_id: id, line_no: 1, description: 'Historical description',
    hsn: '84713000', uqc_code: 'NOS', goods_or_service: 'GOODS', taxability: 'TAXABLE', snapshot_source: 'NATIVE',
    qty_micros: 1000000, tax_rate_bps: rate, item_id: 'item', warehouse_id: 'warehouse', unit_price_paise: taxable,
    discount_pct_bps: 0, discount_paise: 0, ...amounts, line_total_paise: amounts.pre_round_total_paise } as InvoiceLine;
  s.invoices.push(header); s.invoiceLines.push(line); return { header, line };
}
function purchase(s: GstMonthlySources, id = 'p', options: Partial<Purchase> = {}) {
  const amounts = amount(10000, 1800, options.round_off_paise ?? 0, options.is_interstate === 1);
  const header = { ...stamp, business_id: 'b', id, bill_number: `BILL-${id}`, supplier_bill_number: `SUP-${id}`,
    bill_date: '2025-05-15', supplier_id: 's', supplier_state_code: '27', is_interstate: 0, status: 'received',
    reverses_purchase_id: null, reversed_by_purchase_id: null, ...amounts, ...options } as Purchase;
  const line = { id: `pline-${id}`, business_id: 'b', purchase_id: id, line_no: 1, description: 'Historical purchase',
    hsn: '84713000', uqc_code: 'NOS', goods_or_service: 'GOODS', taxability: 'TAXABLE', snapshot_source: 'NATIVE',
    qty_micros: 1000000, tax_rate_bps: 1800, item_id: 'item', warehouse_id: 'warehouse', unit_cost_paise: 10000,
    discount_paise: 0, ...amounts, line_total_paise: amounts.pre_round_total_paise } as PurchaseLine;
  s.purchases.push(header); s.purchaseLines.push(line); return { header, line };
}
function salesReturn(s: GstMonthlySources, original: ReturnType<typeof invoice>, options: Partial<SalesReturn> = {}) {
  const header = { ...stamp, ...amount(), id: 'sr', business_id: 'b', return_number: 'SR-000001', return_date: '2025-05-20',
    original_invoice_id: original.header.id, customer_id: 'c', status: 'posted', legacy_migration_classification: null,
    reversed_credit_note_invoice_id: null, ...options } as SalesReturn;
  const line = { ...original.line, id: 'srline', sales_return_id: header.id, original_invoice_id: original.header.id,
    original_invoice_line_id: original.line.id } as SalesReturnItem;
  s.salesReturns.push(header); s.salesReturnItems.push(line); return { header, line };
}
const calculate = (s: GstMonthlySources, month = '2025-05') => calculateMonthlyGst(s, monthPeriod('b', gstin('27'), month), stamp.created_at);
const codes = (s: GstMonthlySources) => calculate(s).issues.map(i => i.code);
function metadata(s: GstMonthlySources, id: string, values: Partial<GstDocumentMetadata>) {
  s.metadata.push({ ...stamp, id: `meta-${id}`, business_id: 'b', source_entity_type: 'INVOICE', source_entity_id: id,
    document_type: 'TAX_INVOICE', supply_category: 'DOMESTIC', ...values } as GstDocumentMetadata);
}
function review(s: GstMonthlySources, id: string, status: GstItcLedgerEntry['status'], values: Partial<GstItcLedgerEntry> = {}) {
  const entry = { ...stamp, id, business_id: 'b', source_entity_type: 'PURCHASE', source_entity_id: 'p', tax_period_key: '2025-05',
    tax_head: 'CGST', status, category: 'OTHER_ITC', reviewed_at: stamp.created_at, books_tax_paise: 900,
    original_eligible_paise: 900, temporarily_reversed_paise: null, permanently_reversed_paise: null,
    reclaimed_paise: null, reclaimable_paise: null, ...values } as GstItcLedgerEntry;
  s.itcEntries.push(entry); return entry;
}

describe('pure monthly GST working', () => {
  it('retains IFF books in quarter 3B while excluding them from pending quarter GSTR1 rows', () => {
    const s = fixture(); s.profiles[0].filing_frequency = 'QRMP';
    invoice(s, 'iff', { invoice_date: '2025-04-10' }); invoice(s, 'end', { invoice_date: '2025-06-10' });
    metadata(s, 'iff', { iff_reported_period: '2025-04' });
    const result = calculateMonthlyGst(s, quarterPeriod('b', gstin('27'), '2025-26', 1), stamp.created_at);
    expect(result.gstr1Sections.iffReportedSourceIds).toEqual(['iff']);
    expect(result.gstr1Sections.quarterPendingDocuments?.map(row => row.source_entity_id)).toEqual(['end']);
    expect(result.gstr1Sections.quarterPendingRateRows?.reduce((sum, row) => sum + row.taxable_paise, 0)).toBe(10000);
    expect(result.totals.outwardNet.taxable_paise).toBe(20000);
    expect(result.gstr3bSections.fields.find(row => row.table_code === '3.1(a)' && row.measure === 'taxable_paise')?.calculated_paise).toBe(20000);
    s.metadata[0].iff_reported_period = '2025-06';
    expect(calculateMonthlyGst(s, quarterPeriod('b', gstin('27'), '2025-26', 1), stamp.created_at).issues.some(row => row.code === 'INVALID_IFF_METADATA')).toBe(true);
  });
  it('warns about master differences and fuzzy numbers without rewriting legal history', () => {
    const s = fixture(); invoice(s, '1');
    s.currentItems = [{ id: 'item', business_id: 'b', name: 'Renamed', hsn: '99999999', tax_rate_bps: 500, unit_id: 'unit' }] as GstMonthlySources['currentItems'];
    s.documentIdentityEvidence = [{ business_id: 'b', source_entity_type: 'INVOICE', source_entity_id: 'other', document_type: 'TAX_INVOICE',
      document_number: 'inv/1', financial_year: '2025-26', party_gstin: null }];
    const result = calculate(s);
    expect(result.issues.map(row => row.code)).toEqual(expect.arrayContaining(['MASTER_HISTORY_DIFFERENCE', 'FUZZY_DUPLICATE_SUGGESTION']));
    expect(result.outwardHsnRows[0]).toMatchObject({ hsn: '84713000', description: 'Historical description', tax_rate_bps: 1800 });
    expect(result.outwardDocuments[0].document_number).toBe('INV-1');
    expect(result.outwardDocuments[0].included).toBe(true);
  });
  it('uses reviewed UIN identity without GSTIN checksum and allocates Table3.2', () => {
    const s = fixture(); invoice(s, 'uin', { is_interstate: 1, place_of_supply: '29' });
    metadata(s, 'uin', { recipient_category: 'UIN', recipient_uin: '29UNREVIEWED001', recipient_identity_reviewed_at: stamp.created_at,
      recipient_identity_review_reason: 'Verified synthetic identity certificate' });
    const result = calculate(s);
    expect(result.outwardDocuments[0].classification).toBe('B2B');
    expect(result.gstr3bSections.interstateSupplies[0]).toMatchObject({ recipient_category: 'UIN', taxable_paise: 10000, igst_paise: 1800 });
    expect(result.status).toBe('READY_FOR_CA_REVIEW');
    s.metadata[0].recipient_identity_reviewed_at = null;
    expect(codes(s)).toContain('UIN_IDENTITY_REVIEW_REQUIRED');
  });
  it('keeps outward RCM in GSTR1 but excludes supplier output liability', () => {
    const s = fixture(); invoice(s); metadata(s, 'i', { reverse_charge: 1, recipient_category: 'REGISTERED' });
    const result = calculate(s);
    expect(result.gstr1Sections.summaries.B2B.cgst_paise).toBe(900);
    expect(result.totals.outputLiability.cgst_paise).toBe(0);
    expect(result.gstr3bSections.fields.find(row => row.table_code === '3.1(a)' && row.measure === 'cgst_paise')?.calculated_paise).toBe(0);
    expect(result.reconciliations.every(row => row.status === 'PASS')).toBe(true);
  });
  it('removes prior recipient/POS/category dimensions and adds amended dimensions', () => {
    const s = fixture(); s.customers[0].gstin = '';
    const inv = invoice(s, 'amended', { is_interstate: 1, place_of_supply: '29' });
    metadata(s, 'amended', { amendment_kind: 'OLDER_PERIOD_AMENDMENT', original_return_period: '2025-04', original_document_number: 'OLD-01',
      previously_reported_values_json: JSON.stringify({ ...amount(), classification: 'B2B', recipient_group: 'B2B', place_of_supply: '27',
        is_interstate: false, ecommerce_operator_gstin: null, party_gstin: gstin('27'), recipient_category: 'REGISTERED',
        lines: [{ ...amount(), source_line_id: inv.line.id, quantity_micros: inv.line.qty_micros, tax_rate_bps: inv.line.tax_rate_bps,
          hsn: inv.line.hsn, description: inv.line.description, uqc_code: 'NOS', goods_or_service: 'GOODS', taxability: 'TAXABLE' }] }) });
    const result = calculate(s);
    expect(result.outwardRateRows.map(row => [row.classification, row.place_of_supply, row.taxable_paise])).toEqual(expect.arrayContaining([
      ['B2B', '27', -10000], ['B2CS', '29', 10000],
    ]));
    expect(result.gstr3bSections.interstateSupplies[0].taxable_paise).toBe(10000);
    expect(result.outwardHsnRows.map(row => [row.recipient_group, row.taxable_paise])).toEqual(expect.arrayContaining([['B2B', -10000], ['B2C', 10000]]));
    expect(result.reconciliations.every(row => row.status === 'PASS')).toBe(true);
  });
  it('reports independent outward and inward delinked notes using persisted lines', () => {
    const s = fixture(); const inv = invoice(s); s.invoices = []; s.invoiceLines = [];
    s.notes = ['OUTWARD', 'INWARD'].map(direction => ({ ...stamp, ...amount(), id: direction, business_id: 'b', direction,
      note_type: 'CREDIT_NOTE', note_number: `${direction}-001`, note_date: '2025-05-10', party_id: direction === 'OUTWARD' ? 'c' : 's',
      place_of_supply: '27', supplier_state_code: '27', is_interstate: 0, lines_json: JSON.stringify([inv.line]) })) as NonNullable<GstMonthlySources['notes']>;
    const result = calculate(s);
    expect(result.totals.outwardNotes.total_paise).toBe(-11800);
    expect(result.totals.inwardNotes.total_paise).toBe(-11800);
    expect(result.issues.filter(row => row.code === 'MISSING_ORIGINAL_NOTE_LINK')).toHaveLength(2);
    expect(result.reconciliations.every(row => row.status === 'PASS')).toBe(true);
  });
  it('reports taxable receipt then linked invoice offset without repeating advance liability', () => {
    const s = fixture(); const inv = invoice(s);
    s.advances = [{ ...stamp, id: 'advance', business_id: 'b', advance_date: '2025-04-10', advance_number: 'ADV-001', party_type: 'customer',
      party_id: 'c', amount_paise: 11800, remaining_paise: 11800, applications: [], method: 'cash', account_id: 'cash', reference: '', notes: '', journal_entry_id: 'je' }];
    metadata(s, 'advance', { source_entity_type: 'ADVANCE', tax_on_advance_applicable: 1, place_of_supply_state_code: '27',
      advance_gst_json: JSON.stringify({ lines: [inv.line] }) });
    metadata(s, 'i', { advance_adjustments_json: JSON.stringify([{ advance_id: 'advance', taxable_paise: 10000, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0 }]) });
    const result = calculate(s);
    expect(result.totals.outputLiability.cgst_paise, JSON.stringify(result.issues)).toBe(0);
    expect(result.totals.outwardNet.taxable_paise).toBe(0);
    expect(result.reconciliations.every(row => row.status === 'PASS')).toBe(true);
    s.metadata[1].advance_adjustments_json = s.metadata[1].advance_adjustments_json!.replace('10000', '10001');
    expect(codes(s)).toContain('INVALID_ADVANCE_OFFSET');
  });
  it('requires partial mixed-rate offset allocation and prevents reusing the same rate balance', () => {
    const s = fixture(); const inv = invoice(s);
    const second = { ...inv.line, id: 'advance-rate2', ...amount(10000, 500), tax_rate_bps: 500, line_total_paise: 10500 };
    s.advances = [{ ...stamp, id: 'advance', business_id: 'b', advance_date: '2025-04-10', advance_number: 'ADV-001', party_type: 'customer',
      party_id: 'c', amount_paise: 22300, remaining_paise: 22300, applications: [], method: 'cash', account_id: 'cash', reference: '', notes: '', journal_entry_id: 'je' }];
    metadata(s, 'advance', { source_entity_type: 'ADVANCE', tax_on_advance_applicable: 1, place_of_supply_state_code: '27',
      advance_gst_json: JSON.stringify({ lines: [inv.line, second] }) });
    const offset = { advance_id: 'advance', taxable_paise: 10000, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0 };
    metadata(s, 'i', { advance_adjustments_json: JSON.stringify([offset]) });
    expect(codes(s)).toContain('INVALID_ADVANCE_OFFSET');
    const allocated = { ...offset, lines: [{ ...offset, advance_line_id: inv.line.id }] };
    s.metadata[1].advance_adjustments_json = JSON.stringify([allocated]);
    expect(codes(s)).not.toContain('INVALID_ADVANCE_OFFSET');
    s.advanceOffsetEvidence = [{ ...s.metadata[1], id: 'prior-offset', source_entity_id: 'other', advance_adjustments_json: JSON.stringify([allocated]) }];
    expect(codes(s)).toContain('INVALID_ADVANCE_OFFSET');
  });
  it.each([33, -33, 0, 15])('preserves signed roundoff %s exactly once', round => {
    const s = fixture(); invoice(s, '000001', { round_off_paise: round }); purchase(s, '000001', { round_off_paise: round });
    const result = calculate(s);
    expect(result.totals.outwardNet.total_paise).toBe(11800 + round);
    expect(result.totals.outwardNet.round_off_paise).toBe(round);
    expect(result.outwardHsnRows[0].total_paise).toBe(11800);
    expect(result.reconciliations.every(r => r.status === 'PASS')).toBe(true);
    expect(result.status).toBe('READY_FOR_CA_REVIEW');
    expect(result.booksItcRows.every(row => row.status === 'UNREVIEWED' && row.approved_paise === 0)).toBe(true);
  });
  it('uses mixed-rate return lines, one document value and signed credit-note roundoff', () => {
    const s = fixture(); const original = invoice(s);
    const returned = salesReturn(s, original, { ...amount(10000, 1800, -33) });
    const second = { ...returned.line, id: 'srline2', qty_micros: 1000000, tax_rate_bps: 500, ...amount(10000, 500), line_total_paise: 10500 };
    s.salesReturnItems.push(second);
    Object.assign(returned.header, { taxable_paise: 20000, cgst_paise: 1150, sgst_paise: 1150, pre_round_total_paise: 22300, total_paise: 22267 });
    const result = calculate(s);
    expect(result.outwardNotes[0].round_off_paise).toBe(33);
    expect(result.totals.outwardNotes.total_paise).toBe(-22267);
    expect(result.totals.outwardNotes.document_count).toBe(1);
    expect(result.totals.outwardNotes.detail_row_count).toBe(2);
    expect(result.outwardRateRows.filter(r => r.source_entity_type === 'SALES_RETURN').map(r => r.tax_rate_bps)).toEqual([500, 1800]);
  });
  it('retains a fully returned original despite settlement cancellation, but not a true cancellation', () => {
    const s = fixture(); const original = invoice(s, '1', { status: 'cancelled' }); salesReturn(s, original);
    invoice(s, '2', { status: 'cancelled' });
    const result = calculate(s);
    expect(result.totals.outwardGross.document_count).toBe(1);
    expect(result.totals.outwardNet.total_paise).toBe(0);
    expect(result.documentSeries.reduce((n, r) => n + r.cancelled, 0)).toBe(1);
    expect(result.sourceManifest.some(m => m.entity_type === 'RETURN_CANCELLATION_EVIDENCE')).toBe(true);
  });
  it('keeps original purchase and normalizes negative native return roundoff once', () => {
    const s = fixture(); const original = purchase(s, 'p', { round_off_paise: -33, reversed_by_purchase_id: 'ret' });
    const returned = purchase(s, 'ret', { reverses_purchase_id: 'p', round_off_paise: 33 });
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'pre_round_total_paise', 'total_paise'] as const) returned.header[key] = -original.header[key];
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'line_total_paise', 'qty_micros'] as const) returned.line[key] = -original.line[key];
    const result = calculate(s);
    expect(result.totals.inwardGross.total_paise).toBe(11767);
    expect(result.totals.inwardNotes.total_paise).toBe(-11767);
    expect(result.totals.inwardNotes.round_off_paise).toBe(33);
    expect(result.totals.inwardNet.total_paise).toBe(0);
    expect(result.totals.booksItc.TOTAL_BOOKS_TAX.cgst_paise).toBe(0);
  });
  it('separates note month from original month and uses boundary-inclusive date filtering', () => {
    const s = fixture(); const original = invoice(s, 'old', { invoice_date: '2025-04-30' });
    salesReturn(s, original, { return_date: '2025-05-01' }); invoice(s, 'future', { invoice_date: '2025-06-01' });
    expect(calculate(s).totals.outwardGross.document_count).toBe(0);
    expect(calculate(s).totals.outwardNotes.document_count).toBe(1);
    expect(calculate(s, '2025-04').totals.outwardGross.document_count).toBe(1);
  });
  it.each(['draft', 'deleted', 'edit', 'cancelled'])('excludes %s invoice from tax', kind => {
    const s = fixture(); invoice(s, 'i', kind === 'draft' ? { status: 'draft' } : kind === 'deleted' ? { deleted_at: stamp.created_at } : kind === 'edit' ? { reverses_invoice_id: 'old' } : { status: 'cancelled' });
    expect(calculate(s).totals.outwardNet.document_count).toBe(0);
  });
  it('never falls back from invalid GSTIN to B2C or eligible ITC', () => {
    const s = fixture(); s.customers[0].gstin = 'INVALID'; s.suppliers[0].gstin = 'INVALID'; invoice(s); purchase(s); review(s, 'review', 'ELIGIBLE_IN_BOOKS');
    const result = calculate(s);
    expect(result.outwardDocuments[0].classification).toBe('UNCLASSIFIED_INVALID_GSTIN');
    expect(result.gstr1Sections.summaries.B2CS.document_count).toBe(0);
    expect(result.totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    expect(result.status).toBe('INCOMPLETE');
  });
  it.each([['2024-07', 25000000, 'B2CS'], ['2024-07', 25000001, 'B2CL'], ['2024-08', 10000000, 'B2CS'], ['2024-08', 10000001, 'B2CL']])('B2CL uses persisted invoice value %s %s', (month, value, classification) => {
    const s = fixture(); s.customers[0].gstin = null;
    invoice(s, 'i', { invoice_date: `${month}-15`, place_of_supply: '29', is_interstate: 1, total_paise: Number(value) }, 10000);
    expect(calculate(s, month as string).outwardDocuments[0].classification).toBe(classification);
  });
  it('counts mixed rates once and splits HSN from May 2025', () => {
    const s = fixture(); const inv = invoice(s); const other = { ...inv.line, id: 'second', tax_rate_bps: 500, ...amount(10000, 500), line_total_paise: 10500 };
    s.invoiceLines.push(other); Object.assign(inv.header, { taxable_paise: 20000, cgst_paise: 1150, sgst_paise: 1150, pre_round_total_paise: 22300, total_paise: 22300 });
    const result = calculate(s);
    expect(result.gstr1Sections.summaries.B2B).toMatchObject({ document_count: 1, detail_row_count: 2, total_paise: 22300, party_count: 1 });
    expect(result.outwardHsnRows.every(r => r.recipient_group === 'B2B' && r.hsn === '84713000')).toBe(true);
    inv.header.invoice_date = '2025-04-15';
    expect(calculate(s, '2025-04').outwardHsnRows.every(r => r.recipient_group === 'COMBINED')).toBe(true);
  });
  it('blocks unknown AATO, zero-rate taxability, missing historical UQC and unsafe monetary values', () => {
    const s = fixture(); s.aato = []; const inv = invoice(s, 'i', {}, 10000, 0);
    delete inv.line.taxability; delete inv.line.uqc_code;
    expect(codes(s)).toEqual(expect.arrayContaining(['AATO_UNKNOWN', 'UNKNOWN_TAXABILITY', 'MISSING_UQC']));
    inv.header.total_paise = Infinity;
    const result = calculate(s);
    expect(result.issues.some(i => i.code === 'UNSAFE_MONEY')).toBe(true);
    expect(JSON.stringify(result.totals)).not.toContain('null');
    expect(result.totals.outwardNet.document_count).toBe(0);
  });
  it('blocks header, line and supply-head inconsistencies without rewriting snapshots', () => {
    const s = fixture(); const inv = invoice(s); inv.header.taxable_paise++;
    inv.header.place_of_supply = '29';
    expect(codes(s)).toEqual(expect.arrayContaining(['HEADER_TOTAL_MISMATCH', 'LINE_HEADER_MISMATCH', 'SUPPLY_TYPE_CONFLICT']));
    expect(inv.header.taxable_paise).toBe(10001);
  });
  it('excludes a document when its line total does not match its tax components', () => {
    const s = fixture(); const inv = invoice(s);
    inv.line.line_total_paise++;
    const result = calculate(s);
    expect(result.issues.some(issue => issue.code === 'LINE_TOTAL_MISMATCH' && issue.severity === 'BLOCKING_ERROR')).toBe(true);
    expect(result.outwardDocuments[0]).toMatchObject({ included: false, exclusion_reason: 'INVALID_LINE_OR_HEADER_EVIDENCE' });
    expect(result.totals.outwardNet.document_count).toBe(0);
  });
  it('excludes malformed positive documents without rewriting negative source evidence', () => {
    const s = fixture(); const inv = invoice(s);
    inv.header.igst_paise = -1800;
    inv.line.igst_paise = -1800;
    const result = calculate(s);
    expect(result.outwardDocuments[0]).toMatchObject({ igst_paise: -1800, included: false, exclusion_reason: 'INVALID_POSITIVE_AMOUNT' });
    expect(result.issues.some(issue => issue.code === 'UNEXPECTED_NEGATIVE_AMOUNT' && issue.severity === 'BLOCKING_ERROR')).toBe(true);
    expect(result.totals.outwardNet.document_count).toBe(0);
  });
  it('does not expose zero when an aggregate exceeds the safe integer range', () => {
    const s = fixture(); invoice(s, 'one', { taxable_paise: Number.MAX_SAFE_INTEGER, cgst_paise: 0, sgst_paise: 0, pre_round_total_paise: Number.MAX_SAFE_INTEGER, total_paise: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER, 0);
    invoice(s, 'two', { taxable_paise: 1, cgst_paise: 0, sgst_paise: 0, pre_round_total_paise: 1, total_paise: 1 }, 1, 0);
    const result = calculate(s);
    expect(result.issues.some(issue => issue.code === 'UNSAFE_AGGREGATE')).toBe(true);
    expect(result.status).toBe('INCOMPLETE');
    expect(result.totals.outwardNet.taxable_paise).toBeNaN();
  });
  it('excludes every exact duplicate while preserving source rows and series duplicate evidence', () => {
    const s = fixture(); invoice(s, '1', { invoice_number: 'INV-000001' }); invoice(s, '2', { invoice_number: 'INV-000001' });
    const result = calculate(s);
    expect(result.totals.outwardNet.document_count).toBe(0);
    expect(result.outwardDocuments).toHaveLength(2);
    expect(result.outwardHsnRows).toHaveLength(0);
    expect(result.documentSeries[0].duplicates).toEqual(['INV-000001']);
  });
  it.each(['NIL_RATED', 'EXEMPT', 'NON_GST'] as const)('explicit %s maps to its own 3B working', taxability => {
    const s = fixture(); const inv = invoice(s, 'i', {}, 10000, 0); inv.line.taxability = taxability;
    const result = calculate(s);
    expect(result.outwardDocuments[0].classification).toBe(taxability);
    expect(result.gstr3bSections.fields.find(f => f.table_code === (taxability === 'NON_GST' ? '3.1(e)' : '3.1(c)') && f.measure === 'taxable_paise')!.calculated_paise).toBe(10000);
  });
  it.each(['EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT', 'DEEMED_EXPORT'] as const)('handles explicit %s only with evidence', category => {
    const s = fixture(); const inv = invoice(s, 'i', { place_of_supply: '29', is_interstate: 1 }, 10000, category.endsWith('WITHOUT_PAYMENT') ? 0 : 1800);
    inv.line.taxability = category === 'DEEMED_EXPORT' ? 'TAXABLE' : 'ZERO_RATED';
    metadata(s, 'i', { supply_category: category, recipient_category: category.startsWith('EXPORT') ? 'OVERSEAS' : category.startsWith('SEZ') ? 'SEZ' : 'REGISTERED',
      shipping_bill_number: 'SB-1', shipping_bill_date: '2025-05-16', port_code: 'SYNTHETIC' });
    const result = calculate(s);
    expect(result.outwardDocuments[0].classification).toBe(category);
    s.metadata[0].shipping_bill_number = null;
    if (category.startsWith('EXPORT')) expect(calculate(s).issues.some(issue => issue.code === 'EXPORT_SHIPPING_DETAIL_PENDING')).toBe(true);
  });
  it('explicit section 9(5) does not enter ordinary outward liability', () => {
    const s = fixture(); invoice(s); metadata(s, 'i', { section_9_5_role: 'SUPPLIER', ecommerce_operator_gstin: gstin('27'), ecommerce_reporting_type: 'SECTION_9_5' });
    const result = calculate(s);
    expect(result.totals.outputLiability.cgst_paise).toBe(0);
    expect(result.gstr3bSections.fields.find(f => f.table_code === '3.1(a)' && f.measure === 'cgst_paise')!.calculated_paise).toBe(0);
    expect(result.gstr3bSections.fields.find(f => f.table_code === '3.1.1(ii)' && f.measure === 'cgst_paise')!.calculated_paise).toBe(900);
  });
  it('uses amendment differential header, line and quantity snapshots', () => {
    const s = fixture(); const inv = invoice(s, 'i', { invoice_date: '2025-04-15' }, 20000);
    metadata(s, 'i', { reporting_period_override: '2025-05', amendment_kind: 'OLDER_PERIOD_AMENDMENT', original_return_period: '2025-04', original_document_number: 'INV-old',
      previously_reported_values_json: JSON.stringify({ ...amount(), lines: [{ ...inv.line, ...amount(), source_line_id: inv.line.id, quantity_micros: 500000 }] }) });
    const result = calculate(s);
    expect(result.totals.outwardNet.taxable_paise).toBe(10000);
    expect(result.outwardHsnRows[0].quantity_micros).toBe(500000);
    expect(result.gstr1Sections.summaries.AMENDMENTS.taxable_paise).toBe(10000);
    expect(result.reconciliations.every(r => r.status === 'PASS')).toBe(true);
    s.metadata[0].previously_reported_values_json = null;
    expect(calculate(s).totals.outwardNet.document_count).toBe(0);
  });
  it.each(['ELIGIBLE_IN_BOOKS', 'INELIGIBLE', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED'] as const)('reviewed ITC %s has exact Table4 net', status => {
    const s = fixture(); purchase(s); review(s, 'r', status, { reason_code: status === 'INELIGIBLE' ? 'SECTION_16_4' : null, temporarily_reversed_paise: status === 'TEMPORARILY_REVERSED' ? 900 : null, permanently_reversed_paise: status === 'PERMANENTLY_REVERSED' ? 900 : null });
    const result = calculate(s);
    expect(result.totals.booksItc.NET_APPROVED.cgst_paise).toBe(status === 'ELIGIBLE_IN_BOOKS' ? 900 : 0);
    expect(result.reconciliations.find(r => r.code === 'TABLE4_A_MINUS_B')!.status).toBe('PASS');
  });
  it('unknown category cannot become eligible and reclaim is capped across all periods', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'prior', 'TEMPORARILY_REVERSED', { tax_period_key: '2025-04', reversal_period_key: '2025-04', temporarily_reversed_paise: 900 });
    review(s, 'reclaim', 'RECLAIMED', { books_tax_paise: 0, reclaimed_paise: 500, related_prior_entry_id: 'prior' });
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(500);
    review(s, 'earlier', 'RECLAIMED', { tax_period_key: '2025-04', reclaimed_paise: 500, related_prior_entry_id: 'prior' });
    expect(codes(s)).toContain('RECLAIM_EXCEEDS_BALANCE');
    const t = fixture(); purchase(t); review(t, 'bad', 'ELIGIBLE_IN_BOOKS', { category: null });
    expect(calculate(t).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
  });
  it('prior-period reversal subtracts approved ITC without repeating purchase tax or original eligibility', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'claim', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-04' });
    review(s, 'r', 'TEMPORARILY_REVERSED', { source_period_key: '2025-04', books_tax_paise: 0, temporarily_reversed_paise: 900 });
    const result = calculate(s);
    expect(result.totals.booksItc.TOTAL_BOOKS_TAX.cgst_paise).toBe(0);
    expect(result.totals.booksItc.NET_APPROVED.cgst_paise).toBe(-900);
    expect(result.reconciliations.find(r => r.code === 'TABLE4_A_MINUS_B')!.status).toBe('PASS');
  });
  it('gates eligibility, reversal and reclaim to their own effective periods', () => {
    const s = fixture(); purchase(s);
    review(s, 'movement', 'TEMPORARILY_REVERSED', { tax_period_key: '2025-05', source_period_key: '2025-05', reversal_period_key: '2025-06', temporarily_reversed_paise: 900 });
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(900);
    expect(calculate(s).totals.booksItc.ELIGIBLE_IN_BOOKS.cgst_paise).toBe(900);
    expect(calculate(s).booksItcRows[0]).toMatchObject({ eligible_paise: 900, temporarily_reversed_paise: 0 });
    expect(calculate(s, '2025-06').booksItcRows[0]).toMatchObject({ eligible_paise: 0, temporarily_reversed_paise: 900, approved_paise: -900, books_tax_paise: 0 });
    const t = fixture(); purchase(t, 'p', { bill_date: '2025-04-15' });
    review(t, 'prior', 'TEMPORARILY_REVERSED', { tax_period_key: '2025-04', reversal_period_key: '2025-04', temporarily_reversed_paise: 900 });
    review(t, 'reclaim', 'RECLAIMED', { tax_period_key: '2025-05', reclaim_period_key: '2025-06', source_period_key: '2025-04', books_tax_paise: 0, reclaimed_paise: 500, related_prior_entry_id: 'prior' });
    expect(calculate(t).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    expect(calculate(t, '2025-06').totals.booksItc.NET_APPROVED.cgst_paise).toBe(500);
  });
  it('supports later eligibility for a validated old purchase without adding book tax again', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'later', 'ELIGIBLE_IN_BOOKS', { books_tax_paise: 0, source_period_key: '2025-04' });
    const result = calculate(s);
    expect(result.totals.booksItc.NET_APPROVED.cgst_paise).toBe(900);
    expect(result.totals.booksItc.TOTAL_BOOKS_TAX.cgst_paise).toBe(0);
    expect(result.reconciliations.find(r => r.code === 'TABLE4_A_MINUS_B')!.status).toBe('PASS');
    s.purchases[0].status = 'cancelled';
    expect(calculate(s).issues.some(i => i.code === 'ITC_SOURCE_NOT_INCLUDED')).toBe(true);
  });
  it('rejects later eligibility when old source lines or tax heads are inconsistent', () => {
    const s = fixture(); const p = purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'later', 'ELIGIBLE_IN_BOOKS', { books_tax_paise: 0, source_period_key: '2025-04' });
    p.line.cgst_paise++;
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    expect(codes(s)).toContain('ITC_SOURCE_NOT_INCLUDED');
  });
  it('blocks repeated full entitlement across months but supports a partial remaining entitlement', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'april', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-04', original_eligible_paise: 900 });
    const may = review(s, 'may', 'ELIGIBLE_IN_BOOKS', { source_period_key: '2025-04', books_tax_paise: 0, original_eligible_paise: 900 });
    expect(codes(s)).toContain('ITC_CUMULATIVE_ENTITLEMENT_EXCEEDED');
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    s.itcEntries[0].original_eligible_paise = 600; may.original_eligible_paise = 300;
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(300);
    expect(calculate(s).status).toBe('READY_FOR_CA_REVIEW');
  });
  it('caps cumulative reversals at claimed balance and adds only validated linked reclaims back', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'claim', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-04' });
    review(s, 'r1', 'TEMPORARILY_REVERSED', { tax_period_key: '2025-05', source_period_key: '2025-04', books_tax_paise: 0, temporarily_reversed_paise: 900 });
    review(s, 'r2', 'PERMANENTLY_REVERSED', { tax_period_key: '2025-06', source_period_key: '2025-04', books_tax_paise: 0, permanently_reversed_paise: 900 });
    expect(calculate(s, '2025-06').issues.some(i => i.code === 'ITC_CUMULATIVE_BALANCE_INVALID')).toBe(true);
    expect(calculate(s, '2025-06').totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    s.itcEntries.pop();
    review(s, 'reclaim', 'RECLAIMED', { tax_period_key: '2025-06', source_period_key: '2025-04', books_tax_paise: 0, reclaimed_paise: 300, related_prior_entry_id: 'r1' });
    review(s, 'r3', 'PERMANENTLY_REVERSED', { tax_period_key: '2025-07', source_period_key: '2025-04', books_tax_paise: 0, permanently_reversed_paise: 300 });
    expect(calculate(s, '2025-07').totals.booksItc.NET_APPROVED.cgst_paise).toBe(-300);
    expect(calculate(s, '2025-07').totals.booksItc.RECLAIMABLE.cgst_paise).toBe(600);
  });
  it('does not allow a reversal without an evidenced earlier claim or a second original claim after reversal', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'reversal', 'TEMPORARILY_REVERSED', { source_period_key: '2025-04', books_tax_paise: 0, temporarily_reversed_paise: 900 });
    expect(codes(s)).toContain('ITC_CUMULATIVE_BALANCE_INVALID');
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    review(s, 'claim', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-04' });
    review(s, 'claim-again', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-06', source_period_key: '2025-04', books_tax_paise: 0 });
    expect(calculate(s, '2025-06').issues.some(i => i.code === 'ITC_CUMULATIVE_ENTITLEMENT_EXCEEDED')).toBe(true);
    expect(calculate(s, '2025-06').totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
  });
  it('ignores future history effects and reduces outstanding carryforward only on the reclaim month', () => {
    const s = fixture(); purchase(s);
    review(s, 'temporary', 'TEMPORARILY_REVERSED', { temporarily_reversed_paise: 300 });
    review(s, 'reclaim', 'RECLAIMED', { tax_period_key: '2025-07', source_period_key: '2025-05', books_tax_paise: 0, reclaimed_paise: 100, related_prior_entry_id: 'temporary' });
    expect(calculate(s, '2025-06').totals.booksItc.RECLAIMABLE.cgst_paise).toBe(300);
    const july = calculate(s, '2025-07');
    expect(july.totals.booksItc.RECLAIMABLE.cgst_paise).toBe(200);
    expect(july.totals.booksItc.RECLAIMED.cgst_paise).toBe(100);
    expect(july.totals.booksItc.ELIGIBLE_IN_BOOKS.cgst_paise).toBe(0);
    expect(july.totals.booksItc.NET_APPROVED.cgst_paise).toBe(100);
    expect(calculate(s, '2025-08').totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
  });
  it('unreviewed purchase return blocks readiness only when original ITC was claimed', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15', reversed_by_purchase_id: 'return' });
    const returned = purchase(s, 'return', { reverses_purchase_id: 'p' });
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'pre_round_total_paise', 'total_paise'] as const) returned.header[key] *= -1;
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'line_total_paise', 'qty_micros'] as const) returned.line[key] *= -1;
    expect(codes(s)).not.toContain('PURCHASE_RETURN_ITC_REVIEW_REQUIRED');
    review(s, 'claim', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-04' });
    expect(codes(s)).toContain('PURCHASE_RETURN_ITC_REVIEW_REQUIRED');
    expect(calculate(s).status).toBe('INCOMPLETE');
    review(s, 'review-return', 'ELIGIBLE_IN_BOOKS', { source_entity_id: 'return', books_tax_paise: 900 });
    expect(codes(s)).not.toContain('PURCHASE_RETURN_ITC_REVIEW_REQUIRED');
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(-900);
  });
  it('separates eligible movement, partial reversal, books partitions and outstanding carryforward', () => {
    const s = fixture(); purchase(s);
    review(s, 'temp', 'TEMPORARILY_REVERSED', { temporarily_reversed_paise: 300 });
    const may = calculate(s);
    expect(may.totals.booksItc).toMatchObject({ ELIGIBLE_IN_BOOKS: { cgst_paise: 900 }, TEMPORARILY_REVERSED: { cgst_paise: 300 }, RECLAIMABLE: { cgst_paise: 300 }, NET_APPROVED: { cgst_paise: 600 } });
    expect(may.totals.booksItcStatusPartitions!.TEMPORARILY_REVERSED.cgst_paise).toBe(900);
    const june = calculate(s, '2025-06');
    expect(june.totals.booksItc.RECLAIMABLE.cgst_paise).toBe(300);
    expect(june.totals.booksItc.ELIGIBLE_IN_BOOKS.cgst_paise).toBe(0);
    expect(june.totals.booksItc.TEMPORARILY_REVERSED.cgst_paise).toBe(0);
    expect(june.totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    expect(june.booksItcRows[0]).toMatchObject({ status: 'RECLAIMABLE', books_tax_paise: 0, reclaimable_paise: 300, eligible_paise: 0 });
    expect(june.reconciliations.find(r => r.code === 'ITC_BOOKS_STATUS_PARTITIONS')!.status).toBe('PASS');
    expect(june.reconciliations.find(r => r.code === 'ITC_MOVEMENTS_NET_APPROVED')!.status).toBe('PASS');
  });
  it('ledger-only and adjustment-only activity are not false nil previews', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15' });
    review(s, 'later', 'ELIGIBLE_IN_BOOKS', { books_tax_paise: 0, source_period_key: '2025-04' });
    expect(calculate(s).status).toBe('READY_FOR_CA_REVIEW');
    expect(codes(s)).not.toContain('NIL_PERIOD_NOT_CONFIRMED');
    const t = fixture(); t.adjustments.push({ ...stamp, id: 'manual', business_id: 'b', tax_period_key: '2025-05', report_type: 'GSTR3B_DRAFT', table_code: '5.1.INTEREST', tax_head: 'CGST', adjustment_paise: 100, reason: 'CA supplied interest' } as GstAdjustment);
    expect(calculate(t).status).toBe('READY_FOR_CA_REVIEW');
    expect(codes(t)).not.toContain('NIL_PERIOD_NOT_CONFIRMED');
  });
  it('full purchase return consumes temporary entitlement and blocks later reclaim/double deduction', () => {
    const s = fixture(); purchase(s, 'p', { bill_date: '2025-04-15', reversed_by_purchase_id: 'ret' });
    review(s, 'temp', 'TEMPORARILY_REVERSED', { tax_period_key: '2025-04', temporarily_reversed_paise: 900 });
    const ret = purchase(s, 'ret', { reverses_purchase_id: 'p' });
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'pre_round_total_paise', 'total_paise'] as const) ret.header[key] *= -1;
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'line_total_paise', 'qty_micros'] as const) ret.line[key] *= -1;
    review(s, 'return-review', 'ELIGIBLE_IN_BOOKS', { source_entity_id: 'ret' });
    expect(codes(s)).toContain('ITC_RETURN_DOUBLE_REDUCTION');
    expect(calculate(s).totals.booksItc.RECLAIMABLE.cgst_paise).toBe(0);
    review(s, 'reclaim', 'RECLAIMED', { tax_period_key: '2025-06', source_period_key: '2025-04', books_tax_paise: 0, reclaimed_paise: 900, related_prior_entry_id: 'temp' });
    expect(calculate(s, '2025-06').issues.some(issue => issue.code === 'ITC_CUMULATIVE_BALANCE_INVALID')).toBe(true);
    expect(calculate(s, '2025-06').totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
  });
  it('RCM ITC requires explicit source reverse-charge metadata and reconciles its context', () => {
    const s = fixture(); purchase(s); review(s, 'rcm', 'ELIGIBLE_IN_BOOKS', { category: 'RCM' });
    expect(codes(s)).toContain('ITC_RCM_CONTEXT_REQUIRED');
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    s.metadata.push({ ...stamp, id: 'm', business_id: 'b', source_entity_type: 'PURCHASE', source_entity_id: 'p', document_type: 'TAX_INVOICE', supply_category: 'DOMESTIC', reverse_charge: 1 } as GstDocumentMetadata);
    const result = calculate(s);
    expect(result.totals.booksItc.NET_APPROVED.cgst_paise).toBe(900);
    expect(result.reconciliations.find(row => row.code === 'RCM_ITC_CONTEXT')!.status).toBe('PASS');
  });
  it.each(['SECTION_16_4', 'POS_RESTRICTION', 'SECTION_17_5', 'UNKNOWN'])('maps ineligible legal reason %s without blanket 4D2', reason => {
    const s = fixture(); purchase(s); review(s, 'ineligible', 'INELIGIBLE', { reason_code: reason });
    const result = calculate(s);
    const d2 = result.gstr3bSections.fields.find(field => field.table_code === '4(D)(2)' && field.measure === 'cgst_paise')!;
    expect(d2.calculated_paise).toBe(['SECTION_16_4', 'POS_RESTRICTION'].includes(reason) ? 900 : 0);
    if (reason === 'SECTION_17_5') expect(result.gstr3bSections.fields.find(field => field.table_code === '4(B)(1)' && field.measure === 'cgst_paise')!.calculated_paise).toBe(900);
    if (reason === 'UNKNOWN') expect(result.status).toBe('INCOMPLETE');
  });
  it('partial eligibility leaves exact unreviewed remainder and books partitions', () => {
    const s = fixture(); purchase(s); review(s, 'partial', 'ELIGIBLE_IN_BOOKS', { original_eligible_paise: 300 });
    const result = calculate(s);
    expect(result.totals.booksItc.ELIGIBLE_IN_BOOKS.cgst_paise).toBe(300);
    expect(result.totals.booksItc.UNREVIEWED.cgst_paise).toBe(600);
    expect(result.totals.booksItcStatusPartitions!.ELIGIBLE_IN_BOOKS.cgst_paise).toBe(300);
    expect(result.totals.booksItcStatusPartitions!.UNREVIEWED.cgst_paise).toBe(600);
    expect(result.booksItcRows.filter(row => row.tax_head === 'CGST').reduce((total, row) => total + row.books_tax_paise, 0)).toBe(900);
    expect(result.reconciliations.find(row => row.code === 'ITC_BOOKS_STATUS_PARTITIONS')!.status).toBe('PASS');
  });
  it('nets small unregistered notes into B2CS aggregates without double counting note register', () => {
    const s = fixture(); s.customers[0].gstin = null; const inv = invoice(s); salesReturn(s, inv);
    const result = calculate(s);
    expect(result.outwardNotes).toHaveLength(1);
    expect(result.gstr1Sections.summaries.B2CS.document_count).toBe(2);
    expect(result.gstr1Sections.summaries.UNREGISTERED_NOTES.document_count).toBe(0);
    expect(result.gstr1Sections.b2csAggregates![0]).toMatchObject({ taxable_paise: 0, cgst_paise: 0, source_entity_ids: ['i', 'sr'] });
    expect(result.reconciliations.find(row => row.code === 'B2CS_AGGREGATES')!.status).toBe('PASS');
  });
  it('full-FY identity evidence blocks duplicates outside the selected month without importing their money', () => {
    const s = fixture(); invoice(s, 'i', { invoice_number: 'INV-000001' });
    s.documentIdentityEvidence = [{ business_id: 'b', source_entity_type: 'INVOICE', source_entity_id: 'april', document_type: 'TAX_INVOICE', document_number: 'INV-000001', document_date: '2025-04-01', party_gstin: gstin('27') }];
    expect(codes(s)).toContain('DUPLICATE_DOCUMENT');
    expect(calculate(s).totals.outwardNet.document_count).toBe(0);
  });
  it('accepts repository FY-only identity evidence and scopes supplier identities by GSTIN', () => {
    const s = fixture(); purchase(s);
    s.documentIdentityEvidence = [{ business_id: 'b', source_entity_type: 'PURCHASE', source_entity_id: 'other', document_type: 'TAX_INVOICE', document_number: 'SUP-p', financial_year: '2025-26', party_gstin: gstin('29') }];
    expect(codes(s)).not.toContain('DUPLICATE_DOCUMENT');
    s.documentIdentityEvidence[0].party_gstin = gstin('27');
    expect(codes(s)).toContain('DUPLICATE_DOCUMENT');
  });
  it('pre-2021 HSN and mixed-taxability documents explicitly block instead of silently becoming nil', () => {
    const s = fixture(); invoice(s, 'historical', { invoice_date: '2021-03-15' });
    expect(calculate(s, '2021-03').issues.some(issue => issue.code === 'HISTORICAL_HSN_RULE_UNSUPPORTED')).toBe(true);
    const t = fixture(); const inv = invoice(t);
    t.invoiceLines.push({ ...inv.line, id: 'exempt', ...amount(10000, 0), line_total_paise: 10000, tax_rate_bps: 0, taxability: 'EXEMPT' });
    Object.assign(inv.header, { taxable_paise: 20000, pre_round_total_paise: 21800, total_paise: 21800 });
    expect(codes(t)).not.toContain('MIXED_TAXABILITY_REVIEW');
    const mixed = calculate(t);
    expect(mixed.status).toBe('READY_FOR_CA_REVIEW');
    expect(mixed.gstr3bSections.fields.find(row => row.table_code === '3.1(c)' && row.measure === 'taxable_paise')?.calculated_paise).toBe(10000);
    expect(mixed.gstr1Sections.summaries.EXEMPT.taxable_paise).toBe(10000);
    expect(mixed.totals.outwardNet.document_count).toBe(1);
    expect(mixed.reconciliations.every(row => row.status === 'PASS')).toBe(true);
  });
  it('service exports do not require shipping bills and captured metadata survives normalization', () => {
    const s = fixture(); const inv = invoice(s, 'i', { is_interstate: 1, place_of_supply: '29' }, 10000, 0); inv.line.taxability = 'ZERO_RATED'; inv.line.goods_or_service = 'SERVICE';
    metadata(s, 'i', { supply_category: 'EXPORT_WITHOUT_PAYMENT', recipient_category: 'OVERSEAS', shipping_bill_number: null, shipping_bill_date: null, port_code: null });
    const result = calculate(s);
    expect(result.outwardDocuments[0]).toMatchObject({ classification: 'EXPORT_WITHOUT_PAYMENT', shipping_bill_number: null });
    expect(result.issues.some(issue => issue.code === 'EXPORT_SHIPPING_DETAIL_PENDING')).toBe(false);
  });
  it('complete prior classification supports old-rate/HSN reversal plus new groups', () => {
    const s = fixture(); const inv = invoice(s, 'i', { invoice_date: '2025-04-15' }, 20000, 1800);
    const old = { ...inv.line, ...amount(10000, 500), tax_rate_bps: 500, hsn: '94031000', source_line_id: inv.line.id, quantity_micros: 500000 };
    metadata(s, 'i', { reporting_period_override: '2025-05', amendment_kind: 'OLDER_PERIOD_AMENDMENT', original_return_period: '2025-04', original_document_number: 'OLD',
      previously_reported_values_json: JSON.stringify({ ...amount(10000, 500), classification: 'B2B', recipient_group: 'B2B', place_of_supply: '27', is_interstate: false, ecommerce_operator_gstin: null, lines: [old] }) });
    const result = calculate(s);
    expect(result.totals.outwardNet.taxable_paise).toBe(10000);
    expect(result.outwardRateRows.map(row => [row.tax_rate_bps, row.taxable_paise])).toEqual([[500, -10000], [1800, 20000]]);
    expect(result.outwardHsnRows.map(row => [row.hsn, row.taxable_paise])).toEqual(expect.arrayContaining([['94031000', -10000], ['84713000', 20000]]));
    expect(result.reconciliations.every(row => row.status === 'PASS')).toBe(true);
  });
  it('synthetic 46 sales, 15 recipients, six later additions and five purchases count actual documents', () => {
    const s = fixture(); s.customers = [];
    for (let n = 0; n < 15; n++) {
      const base = `27AAAAA${String(n).padStart(4, '0')}A1Z`;
      s.customers.push({ ...stamp, id: `c${n}`, business_id: 'b', name: `Synthetic ${n}`, gstin: base + computeGstinCheckChar(base) } as Customer);
    }
    s.customers.push({ ...s.customers[0], id: 'unregistered', gstin: null });
    for (let n = 1; n <= 46; n++) invoice(s, String(n).padStart(6, '0'), { customer_id: n === 46 ? 'unregistered' : `c${n % 15}` });
    s.suppliers = Array.from({ length: 3 }, (_, n) => ({ ...s.suppliers[0], id: `s${n}`, gstin: gstin(String(27 + n)) }));
    for (let n = 0; n < 5; n++) purchase(s, String(n), { supplier_id: `s${n % 3}` });
    const first = calculate(s);
    expect(first.totals.outwardGross.document_count).toBe(46);
    expect(first.gstr1Sections.summaries.B2B).toMatchObject({ document_count: 45, party_count: 15 });
    expect(first.gstr1Sections.summaries.B2CS.document_count).toBe(1);
    expect(first.totals.inwardGross).toMatchObject({ document_count: 5, party_count: 3 });
    for (let n = 47; n <= 52; n++) invoice(s, String(n).padStart(6, '0'), { customer_id: 'c0' });
    const later = calculate(s);
    expect(later.totals.outwardGross.document_count).toBe(52);
    expect(later.documentSeries.find(row => row.series === 'INV-')!.serial_to).toBe('INV-000052');
  });
  it.each(['NIL_RATED', 'EXEMPT', 'NON_GST'] as const)('does not hide taxable liability under incompatible %s metadata', category => {
    const s = fixture(); invoice(s); metadata(s, 'i', { supply_category: category });
    const result = calculate(s);
    expect(result.outwardDocuments[0].classification).toBe('UNCLASSIFIED');
    expect(result.issues.some(i => i.code === 'TAXABILITY_CONFLICT')).toBe(true);
    expect(result.gstr1Sections.summaries[category].document_count).toBe(0);
    expect(result.status).toBe('INCOMPLETE');
  });
  it('SEZ recipient cannot silently enter ordinary B2B', () => {
    const s = fixture(); invoice(s); metadata(s, 'i', { recipient_category: 'SEZ', supply_category: 'DOMESTIC' });
    expect(calculate(s).outwardDocuments[0].classification).toBe('UNCLASSIFIED');
    expect(codes(s)).toContain('SEZ_CLASSIFICATION_REQUIRED');
  });
  it.each(['EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT', 'DEEMED_EXPORT'] as const)('native return inherits validated %s classification', category => {
    const s = fixture(); const rate = category.endsWith('WITHOUT_PAYMENT') ? 0 : 1800;
    const inv = invoice(s, 'i', { place_of_supply: '29', is_interstate: 1 }, 10000, rate);
    inv.line.taxability = category === 'DEEMED_EXPORT' ? 'TAXABLE' : 'ZERO_RATED';
    metadata(s, 'i', { supply_category: category, recipient_category: category.startsWith('EXPORT') ? 'OVERSEAS' : category.startsWith('SEZ') ? 'SEZ' : 'REGISTERED',
      shipping_bill_number: 'SB-1', shipping_bill_date: '2025-05-16', port_code: 'SYNTHETIC' });
    salesReturn(s, inv, { ...amount(10000, rate, 0, true) });
    const result = calculate(s);
    expect(result.outwardNotes[0].classification).toBe(category);
    expect(result.outwardNotes[0].document_type).toBe('CREDIT_NOTE');
    expect(result.reconciliations.find(r => r.code === 'GSTR1_TO_3B')!.status).toBe('PASS');
    s.metadata[0].recipient_category = 'UNKNOWN';
    expect(calculate(s).outwardNotes[0].classification).toBe('UNCLASSIFIED');
  });
  it('native return inherits original section 9(5) and cannot enter ordinary 3.1(a)', () => {
    const s = fixture(); const inv = invoice(s);
    metadata(s, 'i', { section_9_5_role: 'SUPPLIER', ecommerce_operator_gstin: gstin('27'), ecommerce_reporting_type: 'SECTION_9_5' });
    salesReturn(s, inv);
    expect(calculate(s).outwardNotes[0].classification).toBe('ECO_9_5_SUPPLIER');
    expect(calculate(s).gstr3bSections.fields.find(f => f.table_code === '3.1(a)' && f.measure === 'taxable_paise')!.calculated_paise).toBe(0);
  });
  it.each(['tax_rate_bps', 'hsn', 'uqc_code', 'taxability'] as const)('blocks attribute-changing amendment %s rather than placing deltas in the new group', attribute => {
    const s = fixture(); const inv = invoice(s);
    const prior = { ...inv.line, ...amount(), source_line_id: inv.line.id, quantity_micros: 1000000 };
    Object.assign(prior, { [attribute]: attribute === 'tax_rate_bps' ? 500 : 'DIFFERENT' });
    metadata(s, 'i', { amendment_kind: 'OLDER_PERIOD_AMENDMENT', original_return_period: '2025-04', original_document_number: 'OLD', reporting_period_override: '2025-05',
      previously_reported_values_json: JSON.stringify({ ...amount(), lines: [prior] }) });
    const result = calculate(s);
    expect(result.totals.outwardNet.document_count).toBe(0);
    expect(result.outwardHsnRows).toHaveLength(0);
    expect(result.status).toBe('INCOMPLETE');
  });
  it.each([['SAME_PERIOD_GSTR1A', '2025-04'], ['OLDER_PERIOD_AMENDMENT', '2025-05'], ['OLDER_PERIOD_AMENDMENT', '2025-06'], ['OLDER_PERIOD_AMENDMENT', '2025-13']])('enforces %s original period %s', (kind, originalPeriod) => {
    const s = fixture(); const inv = invoice(s);
    metadata(s, 'i', { amendment_kind: kind, original_return_period: originalPeriod, original_document_number: 'OLD',
      previously_reported_values_json: JSON.stringify({ ...amount(), lines: [{ ...inv.line, ...amount(), source_line_id: inv.line.id, quantity_micros: 1000000 }] }) });
    expect(calculate(s).totals.outwardNet.document_count).toBe(0);
    s.metadata[0].amendment_kind = 'SAME_PERIOD_GSTR1A'; s.metadata[0].original_return_period = '2025-05';
    expect(calculate(s).gstr1Sections.summaries.AMENDMENTS.document_count).toBe(1);
  });
  it('reviewed purchase return uses positive ledger magnitudes with negative approved effect', () => {
    const s = fixture(); purchase(s, 'original', { bill_date: '2025-04-15', reversed_by_purchase_id: 'p' });
    const returned = purchase(s, 'p', { reverses_purchase_id: 'original' });
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'pre_round_total_paise', 'total_paise'] as const) returned.header[key] = -returned.header[key];
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'line_total_paise', 'qty_micros'] as const) returned.line[key] = -returned.line[key];
    review(s, 'r', 'ELIGIBLE_IN_BOOKS', { books_tax_paise: 900, original_eligible_paise: 900 });
    review(s, 'original-claim', 'ELIGIBLE_IN_BOOKS', { tax_period_key: '2025-04', source_entity_id: 'original' });
    const result = calculate(s);
    expect(result.totals.booksItc.NET_APPROVED.cgst_paise).toBe(-900);
    expect(result.booksItcRows.find(r => r.tax_head === 'CGST')!.books_tax_paise).toBe(-900);
    expect(result.issues.some(i => i.code === 'ITC_REVIEW_INVALID')).toBe(false);
  });
  it('derives final 4C from adjusted 4A minus 4B and blocks conflicting direct 4C', () => {
    const s = fixture(); purchase(s); review(s, 'r', 'ELIGIBLE_IN_BOOKS');
    s.adjustments.push({ ...stamp, id: 'a', business_id: 'b', tax_period_key: '2025-05', report_type: 'GSTR3B_DRAFT', table_code: '4(A)(5)', tax_head: 'CGST', adjustment_paise: 100, reason: 'CA adjustment' } as GstAdjustment);
    const result = calculate(s);
    expect(result.gstr3bSections.fields.find(f => f.table_code === '4(C)' && f.measure === 'cgst_paise')).toMatchObject({ calculated_paise: 900, final_working_paise: 1000, ca_adjustment_paise: 100, adjustment_ids: ['a'] });
    expect(result.reconciliations.find(r => r.code === 'TABLE4_FINAL_A_MINUS_B')!.status).toBe('PASS');
    s.adjustments.push({ ...s.adjustments[0], id: 'b', table_code: '4(C)', adjustment_paise: 50 });
    expect(codes(s)).toContain('TABLE4_FINAL_NET_CONFLICT');
    expect(calculate(s).reconciliations.find(r => r.code === 'TABLE4_FINAL_A_MINUS_B')!.status).toBe('ERROR');
  });
  it.each(['ADVANCE_ADJUSTMENT', 'RECEIPT_VOUCHER', 'REFUND_VOUCHER', 'IMPORT_BILL_OF_ENTRY'] as const)('blocks invoice metadata type %s', type => {
    const s = fixture(); invoice(s); metadata(s, 'i', { document_type: type });
    expect(codes(s)).toContain('UNSUPPORTED_DOCUMENT_TYPE');
    expect(calculate(s).outwardDocuments[0].classification).toBe('UNCLASSIFIED');
  });
  it('blocks section 9(5) supplier with ordinary ecommerce reporting', () => {
    const s = fixture(); invoice(s); metadata(s, 'i', { section_9_5_role: 'SUPPLIER', ecommerce_reporting_type: 'ORDINARY', ecommerce_operator_gstin: gstin('27') });
    expect(calculate(s).outwardDocuments[0].classification).toBe('UNCLASSIFIED');
  });
  it('Table5 distinguishes nil/exempt and non-GST across intra/interstate', () => {
    const s = fixture();
    for (const interstate of [0, 1]) for (const taxability of ['NIL_RATED', 'EXEMPT', 'NON_GST'] as const) {
      const p = purchase(s, `${interstate}-${taxability}`, { is_interstate: interstate, supplier_state_code: interstate ? '29' : '27', ...amount(10000, 0) });
      Object.assign(p.line, { ...amount(10000, 0), line_total_paise: 10000, tax_rate_bps: 0, taxability });
    }
    const result = calculate(s);
    expect(result.gstr3bSections.fields.filter(f => f.table_code.startsWith('5.') && !f.table_code.startsWith('5.1.')).map(f => [f.table_code, f.calculated_paise])).toEqual([
      ...result.gstr3bSections.fields.filter(f => f.table_code === '5.1').map(f => [f.table_code, null]),
      ['5.NIL_EXEMPT.INTRASTATE', 20000], ['5.NON_GST.INTRASTATE', 10000], ['5.NIL_EXEMPT.INTERSTATE', 20000], ['5.NON_GST.INTERSTATE', 10000],
    ]);
  });
  it('explicit reviewed supersession consumes UNREVIEWED only once and rejects competing reviews', () => {
    const s = fixture(); purchase(s); review(s, 'unreviewed', 'UNREVIEWED', { category: null });
    review(s, 'reviewed', 'ELIGIBLE_IN_BOOKS', { related_prior_entry_id: 'unreviewed' });
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(900);
    expect(calculate(s).totals.booksItc.TOTAL_BOOKS_TAX.cgst_paise).toBe(900);
    expect(calculate(s).booksItcRows.filter(r => r.tax_head === 'CGST')).toHaveLength(1);
    review(s, 'competing', 'ELIGIBLE_IN_BOOKS', { related_prior_entry_id: 'unreviewed' });
    expect(calculate(s).totals.booksItc.NET_APPROVED.cgst_paise).toBe(0);
    expect(codes(s)).toContain('DUPLICATE_ITC_REVIEW');
  });
  it('reordering source arrays preserves normalized calculation and fingerprint input', () => {
    const s = fixture(); invoice(s, '000001'); invoice(s, '000002'); purchase(s);
    review(s, 'cgst', 'ELIGIBLE_IN_BOOKS'); review(s, 'sgst', 'ELIGIBLE_IN_BOOKS', { tax_head: 'SGST' });
    const before = calculate(s);
    s.invoices.reverse(); s.invoiceLines.reverse(); s.itcEntries.reverse();
    expect(calculate(s)).toEqual(before);
  });
  it('invalid override and duplicate previous line identities block amendment readiness', () => {
    const s = fixture(); const inv = invoice(s);
    metadata(s, 'i', { reporting_period_override: '2025-13' });
    expect(codes(s)).toContain('INVALID_REPORTING_PERIOD');
    s.metadata[0].reporting_period_override = '2025-05';
    s.metadata[0].amendment_kind = 'OLDER_PERIOD_AMENDMENT'; s.metadata[0].original_return_period = '2025-04'; s.metadata[0].original_document_number = 'OLD';
    s.metadata[0].previously_reported_values_json = JSON.stringify({ ...amount(), lines: [{ ...inv.line, ...amount(), source_line_id: 'missing', quantity_micros: 1000000 }] });
    expect(calculate(s).totals.outwardNet.document_count).toBe(0);
  });
  it('CA adjustments are explicit deltas, external values remain unavailable by default', () => {
    const s = fixture(); invoice(s);
    s.adjustments.push({ ...stamp, id: 'adj', business_id: 'b', tax_period_key: '2025-05', report_type: 'GSTR3B_DRAFT', table_code: '3.1(a)', tax_head: 'CGST', adjustment_paise: -10, reason: 'CA review' } as GstAdjustment);
    const result = calculate(s), field = result.gstr3bSections.fields.find(f => f.table_code === '3.1(a)' && f.measure === 'cgst_paise')!;
    expect(field).toMatchObject({ calculated_paise: 900, books_derived_paise: 900, ca_adjustment_paise: -10, final_working_paise: 890 });
    expect(result.gstr3bSections.fields.filter(f => ['5.1', '6.1'].includes(f.table_code)).every(f => f.calculated_paise === null && f.final_working_paise === null && f.source_status === 'NOT_AVAILABLE')).toBe(true);
  });
  it('manifest retains full source content and calculation is deterministic without mutating input', () => {
    const s = fixture(); const inv = invoice(s); const before = JSON.stringify(s);
    const a = calculate(s), b = calculate(s);
    expect(a).toEqual(b); expect(JSON.stringify(s)).toBe(before);
    inv.line.description = 'Changed snapshot';
    expect(calculate(s).sourceManifest).not.toEqual(a.sourceManifest);
    expect(a.sourceDataHash).toBe('');
  });
  it('isolates business data and keeps nil preview in DRAFT', () => {
    const s = fixture(); invoice(s, 'other', { business_id: 'other' });
    expect(calculate(s).outwardDocuments).toHaveLength(0);
    expect(calculate(s).status).toBe('DRAFT');
  });
  it('exactly sums 50k outward and 50k inward mixed-rate lines across months', () => {
    const s = fixture();
    for (let doc = 0; doc < 100; doc++) {
      const month = doc % 2 === 0 ? '05' : '06';
      const i = invoice(s, String(doc).padStart(6, '0'), { invoice_date: `2025-${month}-15` }, 1, 1800);
      const p = purchase(s, String(doc).padStart(6, '0'), { bill_date: `2025-${month}-15` });
      for (const header of [i.header, p.header]) Object.assign(header, amount(500, 0));
      const lineBase = { ...amount(1, 0), taxable_paise: 1, line_total_paise: 1 };
      Object.assign(i.line, lineBase); Object.assign(p.line, lineBase);
      for (let n = 1; n < 500; n++) {
        s.invoiceLines.push({ ...i.line, ...lineBase, id: `il-${doc}-${n}`, line_no: n + 1, tax_rate_bps: n % 2 ? 500 : 1800, hsn: n % 2 ? '84713000' : '94031000' });
        s.purchaseLines.push({ ...p.line, ...lineBase, id: `pl-${doc}-${n}`, line_no: n + 1, tax_rate_bps: n % 2 ? 500 : 1800, hsn: n % 2 ? '84713000' : '94031000' });
      }
    }
    expect(s.invoiceLines).toHaveLength(50000); expect(s.purchaseLines).toHaveLength(50000);
    const start = performance.now();
    const may = calculate(s), june = calculate(s, '2025-06');
    expect(may.totals.outwardNet.taxable_paise).toBe(25000); expect(june.totals.outwardNet.taxable_paise).toBe(25000);
    expect(may.totals.inwardNet.taxable_paise).toBe(25000); expect(june.totals.inwardNet.taxable_paise).toBe(25000);
    expect(may.reconciliations.every(r => r.status === 'PASS')).toBe(true);
    expect(performance.now() - start).toBeLessThan(10000);
  }, 15000);
});
