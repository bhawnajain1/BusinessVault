// @vitest-environment node
import ExcelJS from 'exceljs';
import example from '../../../docs/fixtures/gst-working-example.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsv } from '../../csv/csvCodec';
import { triggerDownload } from '../../csv/streamCsvExport';
import { buildMonthlyGstWorkbook, downloadMonthlyGstCsv, downloadMonthlyGstExcel, downloadMonthlyGstJson, downloadMonthlyGstPdf, GST_WORKBOOK_SHEETS, GST_WORKING_DISCLAIMER } from './exports';
import type { BooksItcStatus, GstAmounts, GstSummary, MonthlyGstCalculation, NormalizedGstDocument, NormalizedGstRateRow, NormalizedHsnRow } from './types';
import type { GstMonthlySources } from './types';
import { calculateMonthlyGst } from './calculateMonthlyGst';
import { monthPeriod } from './periods';
import { computeGstinCheckChar } from '../../lib/gst';

vi.mock('../../csv/streamCsvExport', () => ({ triggerDownload: vi.fn() }));
const heads = ['taxable_paise', 'igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise', 'pre_round_total_paise'] as const;
const zero = (): GstAmounts => ({ taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0, pre_round_total_paise: 0, round_off_paise: 0, total_paise: 0 });
const amounts = (taxable: number, igst: number, round = 0): GstAmounts => ({ ...zero(), taxable_paise: taxable, igst_paise: igst, pre_round_total_paise: taxable + igst, round_off_paise: round, total_paise: taxable + igst + round });
const summary = (values: GstAmounts, ids: string[], details: number): GstSummary => ({ ...values, document_count: ids.length, party_count: ids.length ? 1 : 0, detail_row_count: details, source_entity_ids: ids });

// Fully synthetic normalized inputs: no engine or database calls are needed to
// verify the exporter independently of its producer.
function fixture(month = '2025-05'): MonthlyGstCalculation {
  const gross = amounts(30003, 4600, -3), note = amounts(-10001, -1800, 1), net = amounts(20002, 2800, -2);
  const purchase = amounts(10001, 1800, -1), purchaseNote = amounts(-5001, -900, 1), purchaseNet = amounts(5000, 900);
  const document = (id: string, values: GstAmounts, type: NormalizedGstDocument['source_entity_type'] = 'INVOICE'): NormalizedGstDocument => ({
    ...values, source_entity_type: type, source_entity_id: id, source_entity_version: 1, tax_period_key: month,
    document_type: type.endsWith('RETURN') ? 'CREDIT_NOTE' : 'TAX_INVOICE', document_number: type.endsWith('RETURN') ? 'CN-000001' : '000001', document_date: `${month}-01`,
    party_id: '00001', party_name: '=HYPERLINK("https://example.invalid","Injected")', party_gstin: '001234567890123', recipient_category: 'REGISTERED', place_of_supply: '01',
    is_interstate: true, classification: 'B2B', effect_sign: type.endsWith('RETURN') ? -1 : 1, included: true, exclusion_reason: null, cancelled: false,
    original_source_entity_id: null, original_document_number: null, original_period_key: null, amendment_kind: null, ecommerce_operator_gstin: null, reverse_charge: false, line_count: id === 'invoice' ? 2 : 1,
  });
  const rate = (doc: NormalizedGstDocument, values: GstAmounts, bps: number, line: string): NormalizedGstRateRow => ({ ...values, source_entity_type: doc.source_entity_type, source_entity_id: doc.source_entity_id, source_line_ids: [line], tax_period_key: month, classification: doc.classification, tax_rate_bps: bps, taxability: 'TAXABLE', place_of_supply: '01', ecommerce_operator_gstin: null });
  const hsn = (row: NormalizedGstRateRow): NormalizedHsnRow => ({ ...row, recipient_group: 'B2B', hsn: '00123456', description: '+Historical description', uqc_code: 'NOS', goods_or_service: 'GOODS', quantity_micros: 1234567, source_entity_ids: [row.source_entity_id] });
  const invoice = document('invoice', gross), returned = document('return', note, 'SALES_RETURN');
  const bill = document('purchase', purchase, 'PURCHASE'), supplierNote = document('purchase-return', purchaseNote, 'PURCHASE_RETURN');
  const rates = [rate(invoice, amounts(10001, 1800), 1800, 'line-0001'), rate(invoice, amounts(20002, 2800), 1400, 'line-0002'), rate(returned, amounts(-10001, -1800), 1800, 'return-line')];
  const inwardRates = [rate(bill, amounts(10001, 1800), 1800, 'purchase-line'), rate(supplierNote, amounts(-5001, -900), 1800, 'purchase-return-line')];
  const booksItc = Object.fromEntries(['UNREVIEWED', 'ELIGIBLE_IN_BOOKS', 'INELIGIBLE', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED', 'RECLAIMABLE', 'RECLAIMED', 'TOTAL_BOOKS_TAX', 'NET_APPROVED'].map(key => [key, { ...zero(), igst_paise: key === 'UNREVIEWED' || key === 'TOTAL_BOOKS_TAX' ? 900 : 0 }])) as Record<BooksItcStatus | 'TOTAL_BOOKS_TAX' | 'NET_APPROVED', GstAmounts>;
  return {
    businessName: 'Synthetic Business', schemaVersion: 1, ruleSetVersion: 'test-rule-v1', businessId: 'business', gstinSnapshot: '001234567890123',
    period: { businessId: 'business', gstinSnapshot: '001234567890123', financialYear: '2025-26', filingFrequency: 'MONTHLY', periodType: 'MONTH', periodKey: month, periodStart: `${month}-01`, nextPeriodStart: month === '2025-05' ? '2025-06-01' : '2025-07-01' },
    generatedAt: '2025-07-01T12:00:00Z', sourceDataHash: `hash-${month}`, status: 'READY_FOR_CA_REVIEW', sourceManifest: [],
    outwardDocuments: [invoice, returned], inwardDocuments: [bill, supplierNote], outwardNotes: [returned], inwardNotes: [supplierNote],
    outwardRateRows: rates, inwardRateRows: inwardRates, outwardHsnRows: rates.map(hsn), inwardHsnRows: inwardRates.map(hsn),
    booksItcRows: [{ source_entity_type: 'PURCHASE', source_entity_id: 'purchase', ledger_entry_id: null, tax_period_key: month, source_period_key: month, tax_head: 'IGST', status: 'UNREVIEWED', category: null, books_tax_paise: 900, eligible_paise: 0, temporarily_reversed_paise: 0, permanently_reversed_paise: 0, reclaimable_paise: 0, reclaimed_paise: 0, approved_paise: 0, reason: 'Pending review', related_prior_entry_id: null }],
    gstr1Sections: { summaries: { B2B: summary(gross, ['invoice'], 2), REGISTERED_NOTES: summary(note, ['return'], 1) }, documents: { B2B: [invoice], REGISTERED_NOTES: [returned] }, rateRows: { B2B: rates.slice(0, 2), REGISTERED_NOTES: rates.slice(2) }, hsnB2b: rates.map(hsn), hsnB2c: [] },
    gstr3bSections: { fields: [{ table_code: '3.1(a)', measure: 'igst_paise', books_derived_paise: 2800, gstr1_working_paise: 2800, approved_books_itc_paise: null, calculated_paise: 2800, ca_adjustment_paise: 1, final_working_paise: 2801, source_status: 'MANUAL_CA_ADJUSTMENT', source_document_count: 2, source_entity_ids: ['invoice', 'return'], adjustment_ids: ['adjustment-1'], notes: 'CA review adjustment' }, { table_code: '6.1', measure: 'igst_paise', books_derived_paise: null, gstr1_working_paise: null, approved_books_itc_paise: null, calculated_paise: null, ca_adjustment_paise: 0, final_working_paise: null, source_status: 'NOT_AVAILABLE', source_document_count: 0, source_entity_ids: [], adjustment_ids: [], notes: 'Portal ledger unavailable' }], interstateSupplies: [{ ...net, place_of_supply: '01', recipient_category: 'UNREGISTERED', source_entity_ids: ['invoice'] }], disclaimer: 'Indicative GST working before portal reconciliation and CA review.' },
    documentSeries: [{ document_nature: 'TAX_INVOICE', series: '', serial_from: '000001', serial_to: '000001', total_issued: 1, cancelled: 0, net_issued: 1, gaps: [], duplicates: [], source_entity_ids: ['invoice'], status: 'PASS' }],
    totals: { outwardGross: summary(gross, ['invoice'], 2), outwardNotes: summary(note, ['return'], 1), outwardNet: summary(net, ['invoice', 'return'], 3), inwardGross: summary(purchase, ['purchase'], 1), inwardNotes: summary(purchaseNote, ['purchase-return'], 1), inwardNet: summary(purchaseNet, ['purchase', 'purchase-return'], 2), booksItc, outputLiability: net, rcmLiability: zero(), indicativeWorkingBalance: { ...zero(), igst_paise: 2800 } },
    issues: [{ code: 'BOOKS_ITC_PORTAL_RECONCILIATION_REQUIRED', severity: 'WARNING', tax_period_key: month, source_entity_type: 'REPORT', source_entity_id: 'business', document_number: null, field: null, message: '@Review purchase tax', recommended_correction: 'Reconcile with portal', amount_impact: { igst_paise: 900 } }],
    reconciliations: [{ code: 'OUTWARD_RATE_HEADERS', status: 'PASS', source_document_count: 2, section_document_count: 2, detail_row_count: 3, party_count: 1, source: net, calculated: { ...net, round_off_paise: 0, total_paise: 22802 }, variance: zero(), source_entity_ids: ['invoice', 'return'], message: 'Taxable and tax heads reconcile; round-off excluded from rate/HSN.' }],
  };
}

function rows(sheet: ExcelJS.Worksheet): Record<string, ExcelJS.CellValue>[] {
  const headers = sheet.getRow(1).values as ExcelJS.CellValue[];
  const result: Record<string, ExcelJS.CellValue>[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row: Record<string, ExcelJS.CellValue> = {};
    sheet.getRow(index).eachCell({ includeEmpty: true }, (cell, column) => { row[String(headers[column])] = cell.value; });
    result.push(row);
  }
  return result;
}
const sum = (data: Record<string, ExcelJS.CellValue>[], column: string) => data.reduce((total, row) => total + Math.round(Number(row[column] ?? 0) * 100), 0);
async function reopen(result: MonthlyGstCalculation[]) {
  const built = await buildMonthlyGstWorkbook(result);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(built.xlsxBuffer);
  return { workbook, built };
}
const downloads = vi.mocked(triggerDownload);

describe('monthly GST presentation exports', () => {
  beforeEach(() => downloads.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it('reopens exactly 18 sheets with filters, frozen headers, metadata and separate sorted periods', async () => {
    const may = fixture(), june = fixture('2025-06');
    const original = JSON.stringify([june, may]);
    const { workbook, built } = await reopen([june, may]);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(GST_WORKBOOK_SHEETS);
    expect(built.xlsxBuffer).toBeInstanceOf(ArrayBuffer);
    expect(built.blob.type).toContain('spreadsheetml');
    expect(built.filename).toBe('BusinessVault-GST-Working-2025-05-to-2025-06.xlsx');
    for (const sheet of workbook.worksheets) {
      expect(sheet.name.length).toBeLessThan(31);
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(sheet.autoFilter).toBeTruthy();
      expect(sheet.getCell('A1').value).toBe('Tax Period');
      expect(sheet.getColumn(1).width).toBeGreaterThanOrEqual(16);
    }
    expect(rows(workbook.getWorksheet('Overview')!).map(row => row['Tax Period'])).toEqual(['2025-05', '2025-06']);
    expect(rows(workbook.getWorksheet('Metadata')!)[0]).toMatchObject({ business_name: 'Synthetic Business', rule_set_version: 'test-rule-v1', source_data_hash: 'hash-2025-05', disclaimer: GST_WORKING_DISCLAIMER });
    expect(JSON.stringify([june, may])).toBe(original);
  });

  it('independently sums register, rate and HSN cells against monthly summaries and reconciliation for each month', async () => {
    const { workbook } = await reopen([fixture(), fixture('2025-06')]);
    for (const period of ['2025-05', '2025-06']) {
      const periodRows = (sheet: string) => rows(workbook.getWorksheet(sheet)!).filter(row => row['Tax Period'] === period);
      const monthly = periodRows('Monthly Summary');
      const sales = periodRows('Sales Register');
      const rates = ['G1 B2B', 'G1 B2CL', 'G1 B2CS', 'G1 Other'].flatMap(periodRows);
      const hsn = ['HSN B2B', 'HSN B2C'].flatMap(periodRows);
      const net = monthly.find(row => row.section === 'outwardNet')!;
      const reconciliation = periodRows('Reconciliation')[0];
      for (const key of heads) {
        const column = key.replace('_paise', ' (INR)');
        const expected = Math.round(Number(net[column]) * 100);
        expect(sum(sales, column)).toBe(expected);
        expect(sum(rates, column)).toBe(expected);
        expect(sum(hsn, column)).toBe(expected);
        expect(sum(sales, column)).toBe(Math.round(Number(reconciliation[`source_${column}`]) * 100));
        expect(reconciliation[`variance_${column}`]).toBe(0);
      }
      expect(sum(sales, 'total (INR)')).toBe(22800);
      expect(sum(sales, 'round_off (INR)')).toBe(-2);
      expect(net.document_count).toBe(2);
      expect(rates).toHaveLength(3);
      for (const name of ['G1 B2B', 'G1 B2CL', 'G1 B2CS', 'G1 Other']) expect(rows(workbook.getWorksheet(name)!)[0]?.['total (INR)']).toBeUndefined();
      const purchases = periodRows('Purchase Register');
      const inward = monthly.find(row => row.section === 'inwardNet')!;
      for (const kind of ['DOCUMENT', 'RATE', 'HSN']) {
        for (const key of heads) {
          const column = key.replace('_paise', ' (INR)');
          expect(sum(purchases.filter(row => row.row_kind === kind), column)).toBe(Math.round(Number(inward[column]) * 100));
        }
      }
      expect(sum(purchases, 'total (INR)')).toBe(5900);
      expect(sum(periodRows('Sales Notes'), 'total (INR)')).toBe(-11800);
      expect(sum(periodRows('Purchase Returns'), 'total (INR)')).toBe(-5900);
      expect(sum(periodRows('Books ITC'), 'books_tax (INR)')).toBe(900);
      expect(sum(periodRows('Books ITC'), 'approved (INR)')).toBe(0);
      expect(periodRows('Documents')[0].total_issued).toBe(1);
      expect(periodRows('GSTR3B Working')[0]).toMatchObject({ 'calculated (INR)': 28, 'ca_adjustment (INR)': 0.01, 'final_working (INR)': 28.01 });
      expect(periodRows('GSTR3B Working')[1]['final_working (INR)']).toBeNull();
      expect(periodRows('GSTR3B Working')[2]).toMatchObject({ row_kind: 'INTERSTATE', table_code: '3.2', place_of_supply: '01' });
    }
  });

  it('exports explicit tax totals rather than invoice values for GST-only summaries', async () => {
    const result = fixture();
    result.totals.outputLiability = amounts(10000, 1800);
    result.totals.booksItc.NET_APPROVED = { ...zero(), igst_paise: 900 };
    result.totals.indicativeWorkingBalance = { ...zero(), igst_paise: 900 };
    const { workbook } = await reopen([result]);
    const monthly = rows(workbook.getWorksheet('Monthly Summary')!);
    expect(monthly.find(row => row.section === 'outputLiability')!['tax_total (INR)']).toBe(18);
    expect(monthly.find(row => row.section === 'ITC:NET_APPROVED')!['tax_total (INR)']).toBe(9);
    expect(monthly.find(row => row.section === 'indicativeWorkingBalance')!['tax_total (INR)']).toBe(9);
  });

  it('preserves leading-zero identifiers, source IDs, injection guards, UTC dates and numeric money', async () => {
    const { workbook } = await reopen([fixture()]);
    const sheet = workbook.getWorksheet('Sales Register')!;
    const data = rows(sheet)[0];
    expect(data).toMatchObject({ document_number: '000001', party_gstin: '001234567890123', party_id: '00001', source_entity_id: 'invoice', 'total (INR)': 346 });
    expect(data.party_name).toBe('\'=HYPERLINK("https://example.invalid","Injected")');
    const date = data.document_date as Date;
    expect(date).toBeInstanceOf(Date);
    expect(date.toISOString()).toBe('2025-05-01T00:00:00.000Z');
    const headers = sheet.getRow(1).values as string[];
    expect(sheet.getCell(2, headers.indexOf('document_date')).numFmt).toBe('dd-mmm-yyyy');
    expect(sheet.getCell(2, headers.indexOf('document_number')).numFmt).toBe('@');
    expect(sheet.getCell(2, headers.indexOf('total (INR)')).numFmt).toContain('0.00');
    expect(rows(workbook.getWorksheet('HSN B2B')!)[0]).toMatchObject({ hsn: '00123456', description: "'+Historical description", Quantity: 1.234567, source_line_ids: '["line-0001"]' });
    expect(rows(workbook.getWorksheet('Issues')!)[0].message).toBe("'@Review purchase tax");
    for (const current of workbook.worksheets) current.eachRow(row => row.eachCell(cell => {
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
      if (typeof cell.value === 'number') expect(Number.isFinite(cell.value)).toBe(true);
    }));
  });

  it('does not recalculate stale summaries and preserves producer ERROR evidence', async () => {
    const result = fixture();
    result.totals.outwardNet.taxable_paise = 999;
    result.reconciliations[0].status = 'ERROR';
    result.reconciliations[0].variance.taxable_paise = 1;
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Monthly Summary')!).find(row => row.section === 'outwardNet')!['taxable (INR)']).toBe(9.99);
    expect(rows(workbook.getWorksheet('Reconciliation')!)[0]).toMatchObject({ status: 'ERROR', 'variance_taxable (INR)': 0.01 });
    expect(sum(rows(workbook.getWorksheet('Sales Register')!), 'taxable (INR)')).not.toBe(999);
  });

  it('keeps excluded documents visible without inventing section rows and retains historical combined HSN', async () => {
    const result = fixture();
    result.outwardDocuments.push({ ...result.outwardDocuments[0], source_entity_id: 'cancelled', document_number: '000002', included: false, cancelled: true, exclusion_reason: 'CANCELLED' });
    result.outwardHsnRows[0].recipient_group = 'COMBINED';
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Sales Register')!)).toHaveLength(3);
    expect(rows(workbook.getWorksheet('G1 B2B')!)).toHaveLength(2);
    expect(rows(workbook.getWorksheet('HSN B2B')!)[0].recipient_group).toBe('COMBINED');
  });

  it('renders B2CL, B2CS, special/unclassified sections and B2C HSN without relabelling or repeated invoice value', async () => {
    const result = fixture();
    for (const section of ['B2CL', 'B2CS', 'EXPORT_WITH_PAYMENT', 'UNCLASSIFIED_INVALID_GSTIN'] as const) {
      const document = { ...result.outwardDocuments[0], source_entity_id: `source-${section}`, classification: section, document_number: `${section}-000001` };
      const rate = { ...result.outwardRateRows[0], source_entity_id: document.source_entity_id, classification: section };
      result.outwardDocuments.push(document);
      result.gstr1Sections.rateRows[section] = [rate];
      result.gstr1Sections.summaries[section] = summary(amounts(10001, 1800), [document.source_entity_id], 1);
    }
    result.outwardHsnRows[0].recipient_group = 'B2C';
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('G1 B2CL')!)[0]).toMatchObject({ section: 'B2CL', source_entity_id: 'source-B2CL', document_number: 'B2CL-000001' });
    expect(rows(workbook.getWorksheet('G1 B2CS')!)[0]).toMatchObject({ section: 'B2CS', source_entity_id: 'source-B2CS' });
    expect(rows(workbook.getWorksheet('G1 Other')!).map(row => row.section)).toEqual(['REGISTERED_NOTES', 'EXPORT_WITH_PAYMENT', 'UNCLASSIFIED_INVALID_GSTIN']);
    expect(rows(workbook.getWorksheet('HSN B2C')!)[0].recipient_group).toBe('B2C');
    expect(rows(workbook.getWorksheet('G1 B2CL')!)[0]['total (INR)']).toBeUndefined();
  });

  it('produces every month-aware CSV detail file with exact money strings and guarded user strings', async () => {
    await downloadMonthlyGstCsv([fixture(), fixture('2025-06')]);
    expect(downloads).toHaveBeenCalledTimes(18);
    for (const [blob, name] of downloads.mock.calls) {
      expect(name).toMatch(/\.csv$/);
      const text = await blob.text();
      expect(text).not.toMatch(/NaN|Infinity|\d\.\d{8,}/);
      const csv = parseCsv(text);
      expect(csv.headers[0]).toBe('Tax Period');
      for (const row of csv.rows) {
        expect(['2025-05', '2025-06']).toContain(row['Tax Period']);
        for (const column of csv.headers.filter(key => key.endsWith('_inr'))) if (row[column]) expect(row[column]).toMatch(/^'?[-]?\d+\.\d{2}$/);
      }
      if (name.endsWith('.sales-register.csv')) {
        expect(csv.rows[0]).toMatchObject({ document_number: '000001', source_entity_id: 'invoice', document_date: '2025-05-01', total_inr: '346.00' });
        expect(csv.rows[0].party_name.startsWith("'=")).toBe(true);
      }
    }
  });

  it('downloads internal JSON with integer paise and unchanged source evidence', async () => {
    const result = fixture();
    await downloadMonthlyGstJson([result]);
    const data = JSON.parse(await downloads.mock.calls[0][0].text());
    expect(data).toMatchObject({ schema: 'businessvault.gst-working.v1', money_unit: 'paise', disclaimer: GST_WORKING_DISCLAIMER });
    expect(data.calculations).toEqual([result]);
    expect(Number.isSafeInteger(data.calculations[0].totals.outwardNet.total_paise)).toBe(true);
  });

  it('exports the public synthetic example without a real GSTIN or fabricated readiness', async () => {
    const calculations = example.calculations as MonthlyGstCalculation[];
    expect(example.schema).toBe('businessvault.gst-working.v1');
    expect(example.disclaimer).toBe(GST_WORKING_DISCLAIMER);
    expect(calculations[0].gstinSnapshot).toBe('SYNTHETIC-NOT-A-GSTIN');
    expect(calculations[0].status).toBe('INCOMPLETE');
    expect(calculations[0].sourceDataHash).toContain('placeholder');
    const { workbook } = await reopen(calculations);
    for (const name of ['Sales Register', 'G1 B2CS', 'HSN B2C']) {
      expect(sum(rows(workbook.getWorksheet(name)!), 'taxable (INR)')).toBe(100);
      expect(sum(rows(workbook.getWorksheet(name)!), 'igst (INR)')).toBe(18);
    }
    expect(sum(rows(workbook.getWorksheet('Sales Register')!), 'total (INR)')).toBe(118);
    expect(rows(workbook.getWorksheet('Overview')!)[0]).toMatchObject({ status: 'INCOMPLETE', blocking_errors: 1 });
    expect(rows(workbook.getWorksheet('Issues')!)[0].code).toBe('INVALID_BUSINESS_GSTIN');
    await downloadMonthlyGstJson(calculations);
    expect(JSON.parse(await downloads.mock.calls[0][0].text())).toEqual(example);
  });

  it('preserves all four Table 5 codes and adjusted 4C fields across Excel, CSV, JSON and PDF', async () => {
    const result = fixture();
    const codes = ['5.NIL_EXEMPT.INTRASTATE', '5.NIL_EXEMPT.INTERSTATE', '5.NON_GST.INTRASTATE', '5.NON_GST.INTERSTATE'];
    const template = result.gstr3bSections.fields[0];
    result.gstr3bSections.fields = codes.map((code, index) => ({ ...template, table_code: code, measure: 'taxable_paise', books_derived_paise: index + 1, gstr1_working_paise: null, calculated_paise: index + 1, ca_adjustment_paise: 0, final_working_paise: index + 1, source_status: 'PURCHASE_BOOKS', adjustment_ids: [], notes: '' }));
    result.gstr3bSections.fields.push({ ...template, table_code: '4(C)', calculated_paise: 900, books_derived_paise: null, approved_books_itc_paise: 900, gstr1_working_paise: null, ca_adjustment_paise: -1, final_working_paise: 899, adjustment_ids: ['synthetic-4A-adjustment'], notes: 'Final 4(C) derived from adjusted 4A minus 4B.' });
    const { workbook } = await reopen([result]);
    const fields = rows(workbook.getWorksheet('GSTR3B Working')!).filter(row => row.row_kind === 'FIELD');
    expect(fields.map(row => row.table_code)).toEqual([...codes, '4(C)']);
    expect(fields.slice(0, 4).map(row => row['calculated (INR)'])).toEqual([0.01, 0.02, 0.03, 0.04]);
    expect(fields[4]).toMatchObject({ 'calculated (INR)': 9, 'ca_adjustment (INR)': -0.01, 'final_working (INR)': 8.99, adjustment_ids: '["synthetic-4A-adjustment"]' });
    await downloadMonthlyGstCsv([result]);
    const csv = downloads.mock.calls.find(([, name]) => name.endsWith('.gstr3b-working.csv'))!;
    expect(parseCsv(await csv[0].text()).rows.slice(0, 4).map(row => row.table_code)).toEqual(codes);
    downloads.mockClear();
    await downloadMonthlyGstJson([result]);
    expect(JSON.parse(await downloads.mock.calls[0][0].text()).calculations[0].gstr3bSections.fields).toEqual(result.gstr3bSections.fields);
    downloads.mockClear();
    await downloadMonthlyGstPdf([result]);
    const pdf = Buffer.from(await downloads.mock.calls[0][0].arrayBuffer()).toString('latin1');
    for (const code of codes) expect(pdf).toContain(code);
    expect(pdf).toContain('8.99');
    expect(pdf).toContain('synthetic-4A-adjustment');
  });

  it('keeps blocked metadata evidence visible without adding supported statutory figures', async () => {
    const result = fixture();
    const codes = ['UNSUPPORTED_RECIPIENT', 'OUTWARD_RCM_REVIEW_REQUIRED', 'ADVANCE_GST_DETAIL_REQUIRED', 'AMENDMENT_PREVIOUS_VALUES_REQUIRED'];
    result.status = 'INCOMPLETE';
    result.issues = codes.map(code => ({ ...result.issues[0], code, severity: 'BLOCKING_ERROR', source_entity_type: 'INVOICE', source_entity_id: 'invoice', message: `Blocked synthetic ${code}`, amount_impact: null }));
    result.outwardDocuments[0].classification = 'UNCLASSIFIED';
    result.outwardDocuments[0].included = false;
    result.outwardDocuments[0].exclusion_reason = 'AMENDMENT_PREVIOUS_VALUES_REQUIRED';
    result.gstr1Sections.rateRows = {};
    result.gstr1Sections.summaries = {};
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Overview')!)[0]).toMatchObject({ status: 'INCOMPLETE', blocking_errors: 4 });
    expect(rows(workbook.getWorksheet('Issues')!).map(row => row.code)).toEqual(codes);
    expect(rows(workbook.getWorksheet('Sales Register')!)[0]).toMatchObject({ classification: 'UNCLASSIFIED', included: 'false', exclusion_reason: 'AMENDMENT_PREVIOUS_VALUES_REQUIRED' });
    for (const name of ['G1 B2B', 'G1 B2CL', 'G1 B2CS', 'G1 Other']) expect(rows(workbook.getWorksheet(name)!)).toEqual([]);
    expect(result.status).toBe('INCOMPLETE');
  });

  it('preserves Unicode exactly in XLSX/CSV/JSON without claiming standard-font PDF glyph coverage', async () => {
    const result = fixture();
    // Intentional synthetic non-Latin text tests lossless data outputs, not PDF fonts.
    const name = '\u092a\u0930\u0940\u0915\u094d\u0937\u0923 \u5546\u5e97';
    result.businessName = name;
    result.outwardDocuments[0].party_name = name;
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Metadata')!)[0].business_name).toBe(name);
    expect(rows(workbook.getWorksheet('Sales Register')!)[0].party_name).toBe(name);
    await downloadMonthlyGstCsv([result]);
    const csv = downloads.mock.calls.find(([, filename]) => filename.endsWith('.sales-register.csv'))!;
    expect(parseCsv(await csv[0].text()).rows[0].party_name).toBe(name);
    downloads.mockClear();
    await downloadMonthlyGstJson([result]);
    expect(JSON.parse(await downloads.mock.calls[0][0].text()).calculations[0].businessName).toBe(name);
  });

  it('downloads the Excel wrapper without any durable writes', async () => {
    await downloadMonthlyGstExcel([fixture()]);
    expect(downloads).toHaveBeenCalledTimes(1);
    expect(downloads.mock.calls[0][1]).toMatch(/\.xlsx$/);
  });

  it('creates a paginated readable PDF containing adjustments, reversals, issues and unavailable ledger values', async () => {
    const result = fixture();
    result.issues.push(...Array.from({ length: 80 }, (_, index) => ({ ...result.issues[0], code: `SYNTHETIC_ISSUE_${index}` })));
    await downloadMonthlyGstPdf([result]);
    const blob = downloads.mock.calls[0][0];
    expect(blob.type).toBe('application/pdf');
    const content = Buffer.from(await blob.arrayBuffer()).toString('latin1');
    expect(content).toMatch(/\/Count [2-9]\d*/);
    for (const phrase of ['CA adjustment', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED', 'RECLAIMED', 'NOT_AVAILABLE', 'SYNTHETIC_ISSUE_79', 'adjustment-1']) expect(content).toContain(phrase);
    expect(content).not.toContain('Final GST Payable');
  });

  it('rejects empty, duplicate, cross-business and unsafe inputs without downloads', async () => {
    await expect(buildMonthlyGstWorkbook([])).rejects.toThrow('Select');
    await expect(buildMonthlyGstWorkbook([fixture(), fixture()])).rejects.toThrow('Duplicate');
    await expect(buildMonthlyGstWorkbook([fixture(), { ...fixture('2025-06'), businessId: 'other' }])).rejects.toThrow('one business');
    for (const bad of [NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      const result = fixture(); result.outwardDocuments[0].total_paise = bad;
      await expect(buildMonthlyGstWorkbook([result])).rejects.toThrow('safe integer');
      await expect(downloadMonthlyGstJson([result])).rejects.toThrow('safe integer');
    }
    expect(downloads).not.toHaveBeenCalled();
  });

  it('exports thousands of one-paise rows and large safe integers without decimal artifacts', async () => {
    const result = fixture();
    const template = result.outwardDocuments[0];
    result.outwardDocuments = Array.from({ length: 2000 }, (_, index) => ({ ...template, ...amounts(1, 0), source_entity_id: `small-${index}` }));
    result.totals.outwardGross = summary(amounts(2000, 0), result.outwardDocuments.map(row => row.source_entity_id), 2000);
    const { workbook } = await reopen([result]);
    expect(sum(rows(workbook.getWorksheet('Sales Register')!), 'total (INR)')).toBe(2000);
    result.outwardDocuments[0].total_paise = Number.MAX_SAFE_INTEGER;
    await downloadMonthlyGstCsv([result]);
    const csv = downloads.mock.calls.find(([, name]) => name.endsWith('.sales-register.csv'))!;
    expect(parseCsv(await csv[0].text()).rows[0].total_inr).toBe('90071992547409.91');
  });

  it.each([9007199254740893, -9007199254740893, 1_000_000_000_000_000])('rejects precision-losing XLSX paise %s with exact CSV/JSON alternatives', async value => {
    const result = fixture();
    result.outwardDocuments[0].total_paise = value;
    await expect(buildMonthlyGstWorkbook([result])).rejects.toThrow(/Excel 15-digit precision.*CSV.*JSON/);
    await downloadMonthlyGstJson([result]);
    expect(JSON.parse(await downloads.mock.calls[0][0].text()).calculations[0].outwardDocuments[0].total_paise).toBe(value);
  });

  it('round-trips the supported Excel precision boundary including negative money', async () => {
    const result = fixture();
    result.outwardDocuments[0].total_paise = 999_999_999_999_999;
    result.outwardDocuments[1].total_paise = -999_999_999_999_999;
    const { workbook } = await reopen([result]);
    const written = rows(workbook.getWorksheet('Sales Register')!);
    expect(Math.round(Number(written[0]['total (INR)']) * 100)).toBe(999_999_999_999_999);
    expect(Math.round(Number(written[1]['total (INR)']) * 100)).toBe(-999_999_999_999_999);
  });

  it('retains frozen saved run identity/status and emits aggregate B2CS with special document metadata', async () => {
    const result = fixture() as MonthlyGstCalculation & { savedReportRunId: string; savedStatus: string };
    result.savedReportRunId = 'saved-00001'; result.savedStatus = 'FINALIZED_WORKING';
    result.outwardDocuments = result.outwardDocuments.slice(0, 1);
    Object.assign(result.outwardDocuments[0], { classification: 'B2CS', party_gstin: '', recipient_category: 'UNREGISTERED', shipping_bill_number: '000012', shipping_bill_date: '2025-05-02', port_code: '0001', section_9_5_role: 'NONE', section_52_tcs: 0 });
    result.outwardNotes = []; result.outwardRateRows = result.outwardRateRows.slice(0, 2);
    result.outwardHsnRows = result.outwardHsnRows.slice(0, 2);
    const summaryValue = result.totals.outwardGross;
    result.totals.outwardNet = summaryValue; result.totals.outwardNotes = summary(zero(), [], 0);
    result.totals.outputLiability = summaryValue;
    result.gstr1Sections.summaries = { B2CS: summaryValue };
    result.gstr1Sections.rateRows = { B2CS: result.outwardRateRows };
    result.gstr1Sections.b2csAggregates = [{ ...summaryValue, tax_period_key: '2025-05', place_of_supply: '01', tax_rate_bps: 1800, supply_type: 'INTERSTATE', ecommerce_operator_gstin: null, source_entity_ids: ['invoice'], source_entity_types: ['INVOICE'], source_line_ids: ['line-0001', 'line-0002'] }];
    result.gstr1Sections.documents = { B2CS: result.outwardDocuments };
    result.gstr3bSections.fields = heads.filter(key => key !== 'pre_round_total_paise').map(measure => ({ ...fixture().gstr3bSections.fields[0], measure, calculated_paise: summaryValue[measure], books_derived_paise: summaryValue[measure], gstr1_working_paise: summaryValue[measure], ca_adjustment_paise: 0, final_working_paise: summaryValue[measure], adjustment_ids: [], source_status: 'SALES_BOOKS' }));
    result.gstr3bSections.interstateSupplies = [];
    result.reconciliations = [];
    const before = JSON.stringify(result);
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('G1 B2CS')!)).toHaveLength(1);
    expect(rows(workbook.getWorksheet('G1 B2CS')!)[0]).toMatchObject({ source_entity_ids: '["invoice"]', 'taxable (INR)': 300.03 });
    expect(rows(workbook.getWorksheet('Sales Register')!)[0]).toMatchObject({ shipping_bill_number: '000012', port_code: '0001', section_9_5_role: 'NONE', section_52_tcs: 0 });
    expect((rows(workbook.getWorksheet('Sales Register')!)[0].shipping_bill_date as Date).toISOString()).toBe('2025-05-02T00:00:00.000Z');
    expect(rows(workbook.getWorksheet('Metadata')!)[0]).toMatchObject({ saved_report_run_id: 'saved-00001', saved_status: 'FINALIZED_WORKING', status: 'INCOMPLETE', export_status: 'INCOMPLETE' });
    await downloadMonthlyGstJson([result]);
    const saved = JSON.parse(await downloads.mock.calls[0][0].text()).calculations[0];
    expect(saved.savedReportRunId).toBe('saved-00001'); expect(saved.savedStatus).toBe('FINALIZED_WORKING');
    expect(JSON.stringify(result)).toBe(before);
  });

  it('independently verifies every monetary detail sheet, ITC movements/partitions, liabilities and presentation controls', async () => {
    const result = fixture();
    const template = result.gstr3bSections.fields[0];
    result.gstr3bSections.fields = heads.filter(key => key !== 'pre_round_total_paise').flatMap(measure => [
      { ...template, table_code: '3.1(a)', measure, calculated_paise: result.totals.outputLiability[measure], ca_adjustment_paise: 0, final_working_paise: result.totals.outputLiability[measure] },
      { ...template, table_code: '3.1(d)', measure, calculated_paise: 0, ca_adjustment_paise: 0, final_working_paise: 0 },
    ]);
    const base = result.booksItcRows[0];
    result.booksItcRows = [
      { ...base, status: 'TEMPORARILY_REVERSED', books_tax_paise: 900, eligible_paise: 900, temporarily_reversed_paise: 200, reclaimable_paise: 150, approved_paise: 700 },
      { ...base, ledger_entry_id: 'reclaim', status: 'RECLAIMED', books_tax_paise: 0, eligible_paise: 50, reclaimed_paise: 50, approved_paise: 50 },
    ];
    Object.assign(result.totals.booksItc, { UNREVIEWED: zero(), ELIGIBLE_IN_BOOKS: { ...zero(), igst_paise: 900 }, TEMPORARILY_REVERSED: { ...zero(), igst_paise: 200 }, RECLAIMABLE: { ...zero(), igst_paise: 150 }, RECLAIMED: { ...zero(), igst_paise: 50 }, NET_APPROVED: { ...zero(), igst_paise: 750 } });
    result.totals.indicativeWorkingBalance.igst_paise = 2050;
    result.totals.booksItcStatusPartitions = Object.fromEntries(['UNREVIEWED', 'ELIGIBLE_IN_BOOKS', 'INELIGIBLE', 'TEMPORARILY_REVERSED', 'PERMANENTLY_REVERSED', 'RECLAIMABLE', 'RECLAIMED'].map(status => [status, { ...zero(), igst_paise: status === 'TEMPORARILY_REVERSED' ? 900 : 0 }])) as NonNullable<typeof result.totals.booksItcStatusPartitions>;
    const { workbook } = await reopen([result]);
    const controls = rows(workbook.getWorksheet('Reconciliation')!).filter(row => row.control_origin === 'EXPORT');
    expect(controls.filter(row => row.status === 'ERROR')).toEqual([]);
    const actualSheetNames = new Set(controls.map(row => row.sheet));
    for (const sheet of ['Sales Register', 'G1 B2B', 'G1 Other', 'Sales Notes', 'HSN B2B', 'HSN B2C', 'Purchase Register', 'Purchase Returns', 'Books ITC', 'GSTR3B Working', 'Documents', 'Issues']) expect(actualSheetNames.has(sheet)).toBe(true);
    for (const control of controls) {
      for (const [key, value] of Object.entries(control)) if (key.startsWith('export_variance_') && value !== null) expect(value).toBe(0);
    }
    const detail = (sheet: string) => rows(workbook.getWorksheet(sheet)!);
    const monthly = detail('Monthly Summary');
    for (const [sheet, section] of [['Sales Register', 'outwardNet'], ['Sales Notes', 'outwardNotes'], ['Purchase Returns', 'inwardNotes']] as const) {
      const summaryRow = monthly.find(row => row.section === section)!;
      for (const key of [...heads, 'total_paise', 'round_off_paise']) {
        const column = key.replace('_paise', ' (INR)');
        expect(sum(detail(sheet).filter(row => row.included === 'true'), column)).toBe(Math.round(Number(summaryRow[column]) * 100));
      }
    }
    for (const [sheet, section] of [['G1 B2B', 'G1:B2B'], ['G1 Other', 'G1:REGISTERED_NOTES']] as const) {
      for (const key of heads) {
        const column = key.replace('_paise', ' (INR)');
        expect(sum(detail(sheet), column)).toBe(Math.round(Number(monthly.find(row => row.section === section)![column]) * 100));
      }
    }
    const itc = detail('Books ITC');
    expect(sum(itc, 'eligible (INR)') - sum(itc, 'reclaimed (INR)')).toBe(900);
    expect(sum(itc, 'eligible (INR)') - sum(itc, 'temporarily_reversed (INR)') - sum(itc, 'permanently_reversed (INR)')).toBe(sum(itc, 'approved (INR)'));
    expect(sum(itc.filter(row => row.status === 'TEMPORARILY_REVERSED'), 'books_tax (INR)')).toBe(900);
    for (const code of ['3.1(a)', '3.1(d)']) {
      const summaryRow = monthly.find(row => row.section === (code === '3.1(a)' ? 'outputLiability' : 'rcmLiability'))!;
      for (const head of ['igst', 'cgst', 'sgst', 'cess']) expect(sum(detail('GSTR3B Working').filter(row => row.table_code === code && row.measure === `${head}_paise`), 'calculated (INR)')).toBe(Math.round(Number(summaryRow[`${head} (INR)`]) * 100));
    }
    expect(detail('Documents').reduce((sum, row) => sum + Number(row.total_issued) - Number(row.cancelled), 0)).toBe(1);
    expect(sum(detail('Issues'), 'impact_igst (INR)')).toBe(900);
  });

  it('marks corrupted export controls ERROR and metadata incomplete without repairing frozen source or engine evidence', async () => {
    const result = fixture();
    result.totals.outwardNet.taxable_paise = 1;
    const original = JSON.stringify(result);
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Reconciliation')!).find(row => row.code === 'EXPORT:Sales Register:INCLUDED')).toMatchObject({ status: 'ERROR', 'source_taxable (INR)': 0.01, 'export_taxable (INR)': 200.02, 'export_variance_taxable (INR)': 200.01, export_document_count: 2, export_detail_row_count: 2 });
    expect(rows(workbook.getWorksheet('Reconciliation')!).find(row => row.control_origin === 'ENGINE')!.status).toBe('PASS');
    expect(rows(workbook.getWorksheet('Metadata')!)[0]).toMatchObject({ calculation_status: 'READY_FOR_CA_REVIEW', export_status: 'INCOMPLETE', status: 'INCOMPLETE' });
    expect(JSON.stringify(result)).toBe(original);
  });

  it('detects equal-count source substitution and duplicate document rows even with unchanged amounts', async () => {
    for (const duplicate of [false, true]) {
      const result = fixture();
      if (duplicate) {
        result.outwardDocuments.push({ ...result.outwardDocuments[0], ...zero() });
      } else {
        result.outwardDocuments[0].source_entity_id = 'substituted-source';
      }
      const { workbook } = await reopen([result]);
      const control = rows(workbook.getWorksheet('Reconciliation')!).find(row => row.code === 'EXPORT:Sales Register:INCLUDED')!;
      expect(control.status).toBe('ERROR');
      expect(control['export_variance_total (INR)']).toBe(0);
      expect(control.expected_source_entity_ids).toBe('["invoice","return"]');
      expect(rows(workbook.getWorksheet('Metadata')!)[0].export_status).toBe('INCOMPLETE');
    }
  });

  it('preserves normalized extension metadata and date cells in registers and CSV without statutory recalculation', async () => {
    const result = fixture();
    Object.assign(result.outwardDocuments[0], {
      party_uin: '000000000000001', original_document_date: '2024-03-31',
      tax_on_advance_applicable: true, advance_source_entity_ids: ['advance-00001'],
      amendment_reporting_period: '2025-05', note_reason: '\t=unsafe',
    });
    Object.assign(result.outwardRateRows[0], { supply_components: ['TAXABLE', 'EXEMPT'] });
    Object.assign(result.booksItcRows[0], { reason_code: 'PARTIAL_REVIEW', unreviewed_paise: 900 });
    const { workbook } = await reopen([result]);
    const sales = rows(workbook.getWorksheet('Sales Register')!)[0];
    expect(sales).toMatchObject({ party_uin: '000000000000001', advance_source_entity_ids: '["advance-00001"]', tax_on_advance_applicable: 'true', note_reason: "'\t=unsafe" });
    expect((sales.original_document_date as Date).toISOString()).toBe('2024-03-31T00:00:00.000Z');
    const headers = workbook.getWorksheet('Sales Register')!.getRow(1).values as string[];
    expect(workbook.getWorksheet('Sales Register')!.getCell(2, headers.indexOf('original_document_date')).numFmt).toBe('dd-mmm-yyyy');
    expect(rows(workbook.getWorksheet('G1 B2B')!)[0].party_uin).toBe('000000000000001');
    expect(rows(workbook.getWorksheet('G1 B2B')!)[0].supply_components).toBe('["TAXABLE","EXEMPT"]');
    expect(rows(workbook.getWorksheet('Books ITC')!)[0]).toMatchObject({ reason_code: 'PARTIAL_REVIEW', 'unreviewed (INR)': 9 });
    await downloadMonthlyGstCsv([result]);
    const register = downloads.mock.calls.find(([, name]) => name.endsWith('.sales-register.csv'))!;
    expect(parseCsv(await register[0].text()).rows[0]).toMatchObject({ party_uin: '000000000000001', original_document_date: '2024-03-31', note_reason: "'\t=unsafe" });
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])('guards every spreadsheet injection prefix %j in user metadata', async prefix => {
    const result = fixture();
    result.businessName = `${prefix}SUM(1,2)`;
    result.outwardDocuments[0].document_number = `${prefix}SUM(1,2)`;
    const { workbook } = await reopen([result]);
    // XML normalizes CR to LF; the safety prefix must still survive reopening.
    const excelPrefix = prefix === '\r' ? '\n' : prefix;
    expect(rows(workbook.getWorksheet('Metadata')!)[0].business_name).toBe(`'${excelPrefix}SUM(1,2)`);
    expect(rows(workbook.getWorksheet('Sales Register')!)[0].document_number).toBe(`'${excelPrefix}SUM(1,2)`);
    await downloadMonthlyGstCsv([result]);
    const register = downloads.mock.calls.find(([, name]) => name.endsWith('.sales-register.csv'))!;
    expect(parseCsv(await register[0].text()).rows[0].document_number).toBe(`'${prefix}SUM(1,2)`);
  });

  it('writes exact CSV money and quantity at safe-integer boundaries and rejects precision-losing Excel quantities', async () => {
    const result = fixture();
    result.outwardDocuments[0].total_paise = Number.MAX_SAFE_INTEGER - 1;
    result.outwardDocuments[1].total_paise = -(Number.MAX_SAFE_INTEGER - 1);
    result.outwardHsnRows[0].quantity_micros = Number.MAX_SAFE_INTEGER;
    await downloadMonthlyGstCsv([result]);
    const register = downloads.mock.calls.find(([, name]) => name.endsWith('.sales-register.csv'))!;
    expect(parseCsv(await register[0].text()).rows.map(row => row.total_inr)).toEqual(['90071992547409.90', "'-90071992547409.90"]);
    const hsn = downloads.mock.calls.find(([, name]) => name.endsWith('.hsn-b2b.csv'))!;
    expect(parseCsv(await hsn[0].text()).rows[0].quantity).toBe('9007199254.740991');
    result.outwardDocuments = fixture().outwardDocuments;
    result.outwardNotes = fixture().outwardNotes;
    await expect(buildMonthlyGstWorkbook([result])).rejects.toThrow('rate/quantity cannot preserve fixed-point precision');
    downloads.mockClear();
    result.outwardHsnRows[0].quantity_micros = 1.5;
    await expect(downloadMonthlyGstJson([result])).rejects.toThrow('safe fixed-point');
    expect(downloads).not.toHaveBeenCalled();
  });

  it('independently verifies document source counts, gross/net notes, ITC, fields and CSV registers', async () => {
    const result = fixture();
    const { workbook } = await reopen([result]);
    const monthly = rows(workbook.getWorksheet('Monthly Summary')!);
    for (const [sheet, gross, note] of [['Sales Register', 'outwardGross', 'outwardNotes'], ['Purchase Register', 'inwardGross', 'inwardNotes']] as const) {
      const detail = rows(workbook.getWorksheet(sheet)!).filter(row => row.included === 'true' && (sheet !== 'Purchase Register' || row.row_kind === 'DOCUMENT'));
      const noteSheet = sheet === 'Sales Register' ? 'Sales Notes' : 'Purchase Returns';
      const notes = rows(workbook.getWorksheet(noteSheet)!);
      const noteIds = new Set(notes.map(row => `${row.source_entity_type}:${row.source_entity_id}`));
      const invoices = detail.filter(row => !noteIds.has(`${row.source_entity_type}:${row.source_entity_id}`));
      for (const [data, section] of [[invoices, gross], [notes, note]] as const) {
        const control = monthly.find(row => row.section === section)!;
        expect(new Set(data.map(row => `${row.source_entity_type}:${row.source_entity_id}`)).size).toBe(control.document_count);
        for (const key of [...heads, 'round_off_paise', 'total_paise']) expect(sum(data, key.replace('_paise', ' (INR)'))).toBe(Math.round(Number(control[key.replace('_paise', ' (INR)')]) * 100));
      }
    }
    await downloadMonthlyGstCsv([result]);
    for (const sheet of GST_WORKBOOK_SHEETS) {
      const suffix = `.${sheet.toLowerCase().replace(/ /g, '-')}.csv`;
      const csv = parseCsv(await downloads.mock.calls.find(([, name]) => name.endsWith(suffix))![0].text());
      expect(csv.rows).toHaveLength(rows(workbook.getWorksheet(sheet)!).length);
      expect(csv.rows.map(row => row.source_entity_id ?? '')).toEqual(rows(workbook.getWorksheet(sheet)!).map(row => String(row.source_entity_id ?? '')));
    }
    const fields = rows(workbook.getWorksheet('GSTR3B Working')!).filter(row => row.row_kind === 'FIELD');
    for (const field of fields.filter(row => row['calculated (INR)'] !== null)) expect(sum([field], 'calculated (INR)') + sum([field], 'ca_adjustment (INR)')).toBe(sum([field], 'final_working (INR)'));
  });

  it('includes export failure evidence, books-derived fields and saved identity in the PDF summary', async () => {
    const result = fixture() as MonthlyGstCalculation & { savedReportRunId: string; savedStatus: string };
    result.savedReportRunId = 'saved-pdf-00001'; result.savedStatus = 'FINALIZED_WORKING';
    result.totals.outwardNet.taxable_paise = 1;
    await downloadMonthlyGstPdf([result]);
    const content = Buffer.from(await downloads.mock.calls[0][0].arrayBuffer()).toString('latin1');
    for (const phrase of ['saved-pdf-00001', 'INCOMPLETE', 'Export reconciliation', 'books INR 28.00', 'GSTR-1 INR 28.00', 'approved Books ITC NOT_AVAILABLE', 'final working INR 28.01']) expect(content).toContain(phrase);
  });

  it('retains reviewed status for a coherent saved v1 result without new optional fields', async () => {
    const result = Object.assign(fixture(), { savedReportRunId: 'saved-v1', savedStatus: 'REVIEWED' });
    const before = JSON.stringify(result);
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Reconciliation')!).filter(row => row.status === 'ERROR')).toEqual([]);
    expect(rows(workbook.getWorksheet('Metadata')!)[0]).toMatchObject({ saved_report_run_id: 'saved-v1', saved_status: 'REVIEWED', export_status: 'REVIEWED', status: 'REVIEWED' });
    expect(JSON.stringify(result)).toBe(before);
  });

  it('flags stale party counts and section document values without altering written summaries', async () => {
    const result = fixture();
    result.totals.outwardNet.party_count = 2;
    result.gstr1Sections.summaries.B2B.total_paise++;
    const { workbook } = await reopen([result]);
    const controls = rows(workbook.getWorksheet('Reconciliation')!);
    expect(controls.find(row => row.code === 'EXPORT:Sales Register:INCLUDED')).toMatchObject({ status: 'ERROR', party_count: 2, export_party_count: 1, party_count_variance: -1 });
    expect(controls.find(row => row.code === 'EXPORT:Sales Register:G1:B2B:DOCUMENT_VALUES')).toMatchObject({ status: 'ERROR', 'export_variance_total (INR)': -0.01 });
    expect(rows(workbook.getWorksheet('Monthly Summary')!).find(row => row.section === 'G1:B2B')!['total (INR)']).toBe(346.01);
  });

  it('rejects invalid date-only cells and validates an entire CSV pack before downloading', async () => {
    const result = fixture();
    result.outwardDocuments[0].document_date = '2025-02-30';
    await expect(buildMonthlyGstWorkbook([result])).rejects.toThrow('invalid date');
    const invalid = fixture();
    Object.assign(invalid.issues[0], { external_impact_paise: 1.5 });
    await expect(downloadMonthlyGstCsv([invalid])).rejects.toThrow('safe integer paise');
    expect(downloads).not.toHaveBeenCalled();
  });

  it('exports first-class normalized notes, UIN, outward RCM and advances generically', async () => {
    const result = fixture();
    const note = result.outwardNotes[0];
    note.source_entity_type = 'GST_NOTE';
    note.direction = 'OUTWARD';
    note.document_number = 'DN/000001';
    const noteRate = result.outwardRateRows[2];
    noteRate.source_entity_type = 'GST_NOTE';
    result.inwardNotes[0].source_entity_type = 'GST_NOTE';
    result.inwardNotes[0].direction = 'INWARD';
    result.inwardRateRows[1].source_entity_type = 'GST_NOTE';
    result.outwardDocuments[0].recipient_category = 'UIN';
    result.outwardDocuments[0].reverse_charge = true;
    const { workbook } = await reopen([result]);
    expect(rows(workbook.getWorksheet('Sales Notes')!)[0]).toMatchObject({ source_entity_type: 'GST_NOTE', document_number: 'DN/000001', direction: 'OUTWARD' });
    expect(rows(workbook.getWorksheet('Purchase Returns')!)[0]).toMatchObject({ source_entity_type: 'GST_NOTE', direction: 'INWARD' });
    expect(rows(workbook.getWorksheet('G1 B2B')!)[0]).toMatchObject({ recipient_category: 'UIN', reverse_charge: 'true' });
    expect(rows(workbook.getWorksheet('Reconciliation')!).filter(row => row.status === 'ERROR')).toEqual([]);
    // The producer supplies advance calculations and classifications, not exports.
    result.outwardDocuments[0].source_entity_type = 'ADVANCE';
    result.outwardRateRows.slice(0, 2).forEach(row => { row.source_entity_type = 'ADVANCE'; });
    result.gstr1Sections.summaries.ADVANCES = result.gstr1Sections.summaries.B2B;
    result.gstr1Sections.documents.ADVANCES = result.gstr1Sections.documents.B2B;
    result.gstr1Sections.rateRows.ADVANCES = result.gstr1Sections.rateRows.B2B;
    delete result.gstr1Sections.summaries.B2B;
    delete result.gstr1Sections.documents.B2B;
    delete result.gstr1Sections.rateRows.B2B;
    const advance = await reopen([result]);
    expect(rows(advance.workbook.getWorksheet('G1 Other')!).filter(row => row.section === 'ADVANCES')).toHaveLength(2);
    expect(rows(advance.workbook.getWorksheet('G1 Other')!).find(row => row.section === 'ADVANCES')!.source_entity_type).toBe('ADVANCE');
    expect(rows(advance.workbook.getWorksheet('Reconciliation')!).filter(row => row.status === 'ERROR')).toEqual([]);
  });

  it.each([false, true])('independently reopens engine-generated counts and same-group B2CS invoices/partial note (%s)', async groupedB2cs => {
    const gstin = (index: number) => { const base = `27AAAAA${String(index).padStart(4, '0')}A1Z`; return base + computeGstinCheckChar(base); };
    const stamp = { created_at: '2025-05-01T00:00:00Z', updated_at: '2025-05-01T00:00:00Z', entity_version: 1 };
    const sources = {
      business: { ...stamp, id: 'synthetic-b', name: 'Synthetic Count Fixture', gstin: gstin(999), state_code: '27' },
      customers: Array.from({ length: 16 }, (_, index) => ({ ...stamp, id: `synthetic-c-${index}`, business_id: 'synthetic-b', name: `Synthetic Customer ${index}`, gstin: index === 15 ? null : gstin(index), state_code: '27' })),
      suppliers: Array.from({ length: 3 }, (_, index) => ({ ...stamp, id: `synthetic-s-${index}`, business_id: 'synthetic-b', name: `Synthetic Supplier ${index}`, gstin: gstin(index + 100), state_code: '27' })),
      profiles: [{ ...stamp, id: 'synthetic-profile', business_id: 'synthetic-b', gstin: gstin(999), active: 1, registration_type: 'REGULAR', filing_frequency: 'MONTHLY', gst_reporting_enabled: 1, effective_from: '2020-01-01', effective_to: null }],
      aato: [{ ...stamp, id: 'synthetic-aato', business_id: 'synthetic-b', financial_year: '2024-25', aato_paise: 1000000, source: 'USER_CONFIRMED', confirmed_at: stamp.created_at }],
      invoices: [], invoiceLines: [], purchases: [], purchaseLines: [], salesReturns: [], salesReturnItems: [], originalInvoices: [], metadata: [], itcEntries: [], adjustments: [], expenses: [], advances: [], legacyAudits: [],
    } as unknown as GstMonthlySources;
    const values = { ...zero(), taxable_paise: 10000, cgst_paise: 900, sgst_paise: 900, pre_round_total_paise: 11800, total_paise: 11800 };
    for (let index = 0; index < 46; index++) {
      const id = `synthetic-i-${index}`;
      sources.invoices.push({ ...stamp, ...values, id, business_id: 'synthetic-b', invoice_number: `SYN-${String(index + 1).padStart(6, '0')}`, invoice_date: '2025-05-15', customer_id: `synthetic-c-${index === 45 ? 15 : index % 15}`, place_of_supply: '27', is_interstate: 0, status: 'issued', financial_year: '2025-26' } as GstMonthlySources['invoices'][number]);
      sources.invoiceLines.push({ ...values, id: `synthetic-il-${index}`, business_id: 'synthetic-b', invoice_id: id, item_id: 'synthetic-item', warehouse_id: 'synthetic-warehouse', unit_price_paise: 10000, discount_pct_bps: 0, discount_paise: 0, line_no: 1, description: 'Synthetic persisted goods', hsn: '84713000', uqc_code: 'NOS', goods_or_service: 'GOODS', taxability: 'TAXABLE', snapshot_source: 'NATIVE', qty_micros: 1000000, tax_rate_bps: 1800, line_total_paise: 11800 } as GstMonthlySources['invoiceLines'][number]);
    }
    for (let index = 0; index < 5; index++) {
      const id = `synthetic-p-${index}`;
      sources.purchases.push({ ...stamp, ...values, id, business_id: 'synthetic-b', bill_number: `BILL-${index}`, supplier_bill_number: `SYN-SUP-${String(index + 1).padStart(6, '0')}`, bill_date: '2025-05-15', supplier_id: `synthetic-s-${index % 3}`, supplier_state_code: '27', is_interstate: 0, status: 'received' } as GstMonthlySources['purchases'][number]);
      sources.purchaseLines.push({ ...values, id: `synthetic-pl-${index}`, business_id: 'synthetic-b', purchase_id: id, item_id: 'synthetic-item', warehouse_id: 'synthetic-warehouse', unit_cost_paise: 10000, discount_paise: 0, line_no: 1, description: 'Synthetic persisted purchase', hsn: '84713000', uqc_code: 'NOS', goods_or_service: 'GOODS', taxability: 'TAXABLE', snapshot_source: 'NATIVE', qty_micros: 1000000, tax_rate_bps: 1800, line_total_paise: 11800 } as GstMonthlySources['purchaseLines'][number]);
    }
    if (groupedB2cs) {
      sources.invoices = sources.invoices.slice(0, 2).map(invoice => ({ ...invoice, customer_id: 'synthetic-c-15' }));
      sources.invoiceLines = sources.invoiceLines.slice(0, 2);
      sources.purchases = []; sources.purchaseLines = [];
      const original = sources.invoices[0], originalLine = sources.invoiceLines[0];
      const partial = { ...values, taxable_paise: 5000, cgst_paise: 450, sgst_paise: 450, pre_round_total_paise: 5900, total_paise: 5900 };
      sources.salesReturns.push({ ...stamp, ...partial, id: 'synthetic-return', business_id: 'synthetic-b', return_number: 'SR-000001', return_date: '2025-05-20', original_invoice_id: original.id, customer_id: original.customer_id, status: 'posted', legacy_migration_classification: null, reversed_credit_note_invoice_id: null } as GstMonthlySources['salesReturns'][number]);
      sources.salesReturnItems.push({ ...originalLine, ...partial, id: 'synthetic-return-line', sales_return_id: 'synthetic-return', original_invoice_id: original.id, original_invoice_line_id: originalLine.id, qty_micros: 500000, line_total_paise: 5900 } as GstMonthlySources['salesReturnItems'][number]);
    }
    const calculation = calculateMonthlyGst(sources, monthPeriod('synthetic-b', gstin(999), '2025-05'), stamp.created_at);
    expect(calculation.issues.filter(row => row.severity === 'BLOCKING_ERROR')).toEqual([]);
    const { workbook } = await reopen([calculation]);
    const monthly = rows(workbook.getWorksheet('Monthly Summary')!);
    if (groupedB2cs) {
      expect(calculation.status).toBe('READY_FOR_CA_REVIEW');
      expect(calculation.gstr1Sections.b2csAggregates).toHaveLength(1);
      expect(calculation.gstr1Sections.b2csAggregates![0].source_entity_ids).toHaveLength(3);
      expect(calculation.gstr1Sections.b2csAggregates![0].source_entity_types).toHaveLength(2);
      expect(monthly.find(row => row.section === 'outwardGross')!.document_count).toBe(2);
      expect(monthly.find(row => row.section === 'G1:B2CS')!.document_count).toBe(3);
      const controls = rows(workbook.getWorksheet('Reconciliation')!);
      expect(controls.filter(row => row.control_origin === 'EXPORT' && row.status === 'ERROR')).toEqual([]);
      expect(controls.find(row => row.code === 'EXPORT:G1 B2CS:B2CS')).toMatchObject({ export_document_count: 3, export_detail_row_count: 1, status: 'PASS' });
      expect(controls.find(row => row.code === 'EXPORT:Sales Register:INCLUDED')!.export_document_count).toBe(3);
      expect(rows(workbook.getWorksheet('Metadata')!)[0].export_status).toBe('READY_FOR_CA_REVIEW');
      expect(sum(rows(workbook.getWorksheet('G1 B2CS')!), 'taxable (INR)')).toBe(15000);
      return;
    }
    expect(monthly.find(row => row.section === 'outwardNet')).toMatchObject({ document_count: 46, party_count: 15 });
    expect(monthly.find(row => row.section === 'G1:B2B')).toMatchObject({ document_count: 45, party_count: 15 });
    expect(monthly.find(row => row.section === 'G1:B2CS')).toMatchObject({ document_count: 1 });
    expect(monthly.find(row => row.section === 'inwardNet')).toMatchObject({ document_count: 5, party_count: 3 });
    const sales = rows(workbook.getWorksheet('Sales Register')!);
    expect(new Set(sales.map(row => row.source_entity_id)).size).toBe(46);
    expect(new Set(sales.map(row => row.party_gstin).filter(Boolean)).size).toBe(15);
    expect(rows(workbook.getWorksheet('G1 B2B')!)).toHaveLength(45);
    expect(rows(workbook.getWorksheet('G1 B2CS')!)).toHaveLength(1);
    for (const key of heads) {
      const column = key.replace('_paise', ' (INR)');
      expect(sum(sales, column)).toBe(calculation.totals.outwardNet[key]);
      expect(sum([...rows(workbook.getWorksheet('HSN B2B')!), ...rows(workbook.getWorksheet('HSN B2C')!)], column)).toBe(calculation.totals.outwardNet[key]);
    }
    expect(rows(workbook.getWorksheet('Reconciliation')!).filter(row => row.status === 'ERROR')).toEqual([]);
  });
});
