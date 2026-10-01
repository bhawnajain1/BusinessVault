import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
  Business,
  Customer,
  Invoice,
  InvoiceLine,
  Item,
  Purchase,
  PurchaseLine,
  SalesReturn,
  Supplier,
  Unit,
} from '../db/types';
import { log } from '../lib/log';
import { streamCsvToBlob, triggerDownload } from '../csv/streamCsvExport';
import ExcelJS from 'exceljs';

export type GstrReportKind = 'gstr1' | 'gstr2';

export interface GstrRow {
  [key: string]: string | number | null;
}

export interface GstrSection {
  columns: string[];
  rows: GstrRow[];
}

export interface GstrReport {
  report: GstrReportKind;
  schema_version: 1;
  generated_at: string;
  period: { from: string; to: string };
  business: { gstin: string | null; legal_name: string; trade_name: string };
  sections: Record<string, GstrSection>;
  reconciliationIssues?: GstrValidationIssue[];
}

export interface GstrExportOptions {
  db?: BusinessVaultDB;
}

export interface GstrValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  documentNumber?: string;
}

export interface GstrExcelResult {
  blob: Blob;
  filename: string;
  issues: GstrValidationIssue[];
  xlsxBuffer: ArrayBuffer;
}

export const GSTR_RULES = {
  b2clThresholdPaise: 10_000_000,
  b2clThresholdEffectiveFrom: '2024-08-01',
  hsnTurnoverThresholdPaise: 50_000_000_000,
  hsnShortLength: 4,
  hsnLongLength: 6,
} as const;

export function hsnRequiredLengthForTurnover(previousYearTurnoverPaise: number): 4 | 6 {
  return previousYearTurnoverPaise > GSTR_RULES.hsnTurnoverThresholdPaise
    ? GSTR_RULES.hsnLongLength
    : GSTR_RULES.hsnShortLength;
}

const UNSUPPORTED_CATEGORIES = [
  'SEZ/deemed exports', 'reverse charge', 'shipping bills/exports', 'imports',
  'e-commerce supplies', 'ITC reversals', 'nil/exempt classification',
] as const;

export const GSTR1_SHEET_ORDER = [
  'GSTR1 Report', 'b2b,sez,de', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exp', 'at', 'atadj',
  'exemp', 'hsn(b2b)', 'hsn(b2c)', 'itemSummary', 'docs',
] as const;

export const GSTR2_SHEET_ORDER = [
  'b2b', 'GSTR2 Report', 'b2bur', 'imps', 'impg', 'cdnur', 'at', 'cdnr', 'atadj',
  'exemp', 'itcr', 'hsnsum', 'itemSummary',
] as const;

const MAIN_GSTR1_COLUMNS = ['GSTIN/UIN', 'Party Name', 'Transaction Type', 'Invoice No.', 'Invoice Date', 'Invoice Value', 'Rate', 'Cess Rate', 'Taxable value', 'Reverse Charge', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Place of Supply(Name of state)'];
const MAIN_GSTR2_COLUMNS = ['GSTIN/UIN', 'Party Name', 'Transaction Type', 'Invoice No.', 'Invoice Date', 'Invoice Value', 'Rate', 'Cess Rate', 'Taxable value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Place of Supply(Name of state)'];
const HSN_COLUMNS = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'];

function validGstin(gstin: string | null | undefined): boolean {
  if (!gstin || !/^[0-9A-Z]{15}$/.test(gstin)) return false;
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const code = chars.indexOf(gstin[i]);
    if (code < 0) return false;
    const factor = i % 2 === 0 ? 2 : 1;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === gstin[14];
}

function excelDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function moneyValue(paise: number): number {
  return paise / 100;
}

function makeWorkbookSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  title: string,
  summary: Array<[string, string | number | null]>,
  columns: string[],
  rows: Array<Record<string, string | number | Date | null>>,
  detailStartRow = 5,
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([title]);
  sheet.mergeCells(1, 1, 1, Math.max(1, columns.length));
  const summaryLabels = summary.map(([label]) => label);
  const summaryValues = summary.map(([, value]) => value ?? '');
  sheet.addRow(summaryLabels);
  sheet.addRow(summaryValues);
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(columns.map((column) => row[column] ?? ''));
  sheet.getRow(1).font = { bold: true, size: 12 };
  sheet.getRow(2).font = { bold: true };
  sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  sheet.views = [{ state: 'frozen', ySplit: detailStartRow - 1 }];
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, detailStartRow - 1 + rows.length), column: columns.length } };
  for (let i = 1; i <= columns.length; i += 1) sheet.getColumn(i).width = Math.min(36, Math.max(12, String(columns[i - 1]).length + 3));
  for (let row = detailStartRow; row <= detailStartRow - 1 + rows.length; row += 1) {
    for (let col = 1; col <= columns.length; col += 1) {
      const cell = sheet.getCell(row, col);
      if (cell.value instanceof Date) cell.numFmt = 'dd-mmm-yyyy';
      else if (typeof cell.value === 'number') cell.numFmt = '0.00';
    }
  }
}

const GSTR1_COLUMNS = {
  b2b: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
  b2cl: ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
  b2cs: ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
  hsn: ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
};

const GSTR2_COLUMNS = {
  b2b: ['GSTIN/UIN of Supplier', 'Supplier Name', 'Bill Number', 'Bill date', 'Bill Value', 'Place Of Supply', 'Reverse Charge', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
  hsn: GSTR1_COLUMNS.hsn,
};

function rupees(paise: number): number {
  return Math.round(paise) / 100;
}

function qty(micros: number): number {
  return Number((micros / 1_000_000).toFixed(6));
}

function rate(bps: number): number {
  return Math.round(bps) / 100;
}

function hsnLengthIsSupported(hsn: string): boolean {
  return /^\d{4}(\d{2})?$/.test(hsn.trim());
}

function empty(columns: string[]): GstrSection {
  return { columns, rows: [] };
}

function hsnRows(
  lines: Array<InvoiceLine | PurchaseLine>,
  invoicesById: Map<string, Invoice | Purchase>,
  itemsById: Map<string, Item>,
  unitsById: Map<string, Unit>,
): GstrRow[] {
  const grouped = new Map<string, GstrRow>();
  for (const line of lines) {
    const doc = invoicesById.get('invoice_id' in line ? line.invoice_id : line.purchase_id);
    if (!doc || doc.status === 'cancelled' || ('deleted_at' in doc && doc.deleted_at)) continue;
    const item = itemsById.get(line.item_id);
    const unit = item ? unitsById.get(item.unit_id) : undefined;
      const key = `${line.hsn}|${line.tax_rate_bps}|${unit?.code ?? ''}`;
    const row = grouped.get(key) ?? {
      HSN: line.hsn,
      Description: item?.name ?? line.description,
      UQC: unit?.code ?? '',
      'Total Quantity': 0,
      'Total Value': 0,
      Rate: rate(line.tax_rate_bps),
      'Taxable Value': 0,
      'Integrated Tax Amount': 0,
      'Central Tax Amount': 0,
      'State/UT Tax Amount': 0,
      'Cess Amount': 0,
    };
     row['Total Quantity'] = Number(row['Total Quantity']) + qty(line.qty_micros);
     row['Total Value'] = Math.round((Number(row['Total Value']) * 100 + line.line_total_paise) ) / 100;
     row['Taxable Value'] = Math.round((Number(row['Taxable Value']) * 100 + line.taxable_paise)) / 100;
     row['Integrated Tax Amount'] = Math.round((Number(row['Integrated Tax Amount']) * 100 + line.igst_paise)) / 100;
     row['Central Tax Amount'] = Math.round((Number(row['Central Tax Amount']) * 100 + line.cgst_paise)) / 100;
     row['State/UT Tax Amount'] = Math.round((Number(row['State/UT Tax Amount']) * 100 + line.sgst_paise)) / 100;
     row['Cess Amount'] = Math.round((Number(row['Cess Amount']) * 100 + line.cess_paise)) / 100;
    grouped.set(key, row);
  }
  return Array.from(grouped.values());
}

export async function buildGstrReport(
  businessId: string,
  report: GstrReportKind,
  from: string,
  to: string,
  opts: GstrExportOptions = {},
): Promise<GstrReport> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const [business, customers, suppliers, items, units, invoices, invoiceLines, purchases, purchaseLines, salesReturns] = await Promise.all([
    db.businesses.get(businessId),
    db.customers.where('business_id').equals(businessId).toArray(),
    db.suppliers.where('business_id').equals(businessId).toArray(),
    db.items.where('business_id').equals(businessId).toArray(),
    db.units.where('business_id').equals(businessId).toArray(),
    db.invoices.where('[business_id+invoice_date]').between([businessId, from], [businessId, to], true, true).toArray(),
    db.invoice_lines.where('business_id').equals(businessId).toArray(),
    db.purchases.where('[business_id+bill_date]').between([businessId, from], [businessId, to], true, true).toArray(),
    db.purchase_lines.where('business_id').equals(businessId).toArray(),
    db.sales_returns.where('[business_id+return_date]').between([businessId, from], [businessId, to], true, true).toArray(),
  ]);
  if (!business) throw new Error('Business not found');
  const activeInvoices = invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled' && !i.deleted_at);
  const activePurchases = purchases.filter((p) => p.status !== 'draft' && p.status !== 'cancelled');
  const activeSalesReturns = (salesReturns as SalesReturn[]).filter((r) => r.status === 'posted' && !r.deleted_at);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const invoiceById = new Map(activeInvoices.map((i) => [i.id, i]));
  const purchaseById = new Map(activePurchases.map((p) => [p.id, p]));
  const linesByInvoice = new Map<string, InvoiceLine[]>();
  for (const line of invoiceLines) {
    if (invoiceById.has(line.invoice_id)) linesByInvoice.set(line.invoice_id, [...(linesByInvoice.get(line.invoice_id) ?? []), line]);
  }
  const linesByPurchase = new Map<string, PurchaseLine[]>();
  for (const line of purchaseLines) {
    if (purchaseById.has(line.purchase_id)) linesByPurchase.set(line.purchase_id, [...(linesByPurchase.get(line.purchase_id) ?? []), line]);
  }
  const b2cInvoiceIds = new Set(
    activeInvoices
      .filter((invoice) => !validGstin(customerById.get(invoice.customer_id)?.gstin))
      .map((invoice) => invoice.id),
  );

  const gstr1B2b: GstrRow[] = [];
  const gstr1B2cl: GstrRow[] = [];
  const gstr1B2cs: GstrRow[] = [];
  const b2csByKey = new Map<string, GstrRow>();
  for (const invoice of activeInvoices) {
    const customer = customerById.get(invoice.customer_id);
    const lines = linesByInvoice.get(invoice.id) ?? [];
    const registered = validGstin(customer?.gstin);
    const isB2cl = invoice.is_interstate === 1
      && invoice.invoice_date >= GSTR_RULES.b2clThresholdEffectiveFrom
      && invoice.total_paise > GSTR_RULES.b2clThresholdPaise;
    const target = registered ? gstr1B2b : isB2cl ? gstr1B2cl : gstr1B2cs;
    for (const line of lines) {
      const base = {
        'Invoice Number': invoice.invoice_number,
        'Invoice date': invoice.invoice_date,
        'Invoice Value': rupees(invoice.total_paise),
        'Place Of Supply': invoice.place_of_supply,
        'Rate': rate(line.tax_rate_bps),
        'Taxable Value': rupees(line.taxable_paise),
        'Cess Amount': rupees(line.cess_paise),
      };
      if (target === gstr1B2b) target.push({
        'GSTIN/UIN of Recipient': customer?.gstin ?? '',
        'Receiver Name': customer?.name ?? '',
        ...base,
        'Reverse Charge': 'N',
        'Applicable % of Tax Rate': '',
        'Invoice Type': 'Regular B2B',
        'E-Commerce GSTIN': '',
      });
      else if (target === gstr1B2cl) target.push({ ...base, 'Applicable % of Tax Rate': '', 'E-Commerce GSTIN': '' });
      else {
        const key = `${invoice.place_of_supply}|${line.tax_rate_bps}`;
        const row = b2csByKey.get(key) ?? { Type: 'OE', 'Invoice Number': invoice.invoice_number, 'Place Of Supply': invoice.place_of_supply, 'Applicable % of Tax Rate': '', Rate: rate(line.tax_rate_bps), 'Taxable Value': 0, 'Cess Amount': 0, 'E-Commerce GSTIN': '' };
        row['Taxable Value'] = Number(row['Taxable Value']) + rupees(line.taxable_paise);
        row['Cess Amount'] = Number(row['Cess Amount']) + rupees(line.cess_paise);
        b2csByKey.set(key, row);
      }
    }
  }
  gstr1B2cs.push(...b2csByKey.values());
  const gstr2B2b: GstrRow[] = [];
  for (const purchase of activePurchases) {
    const supplier = supplierById.get(purchase.supplier_id);
    for (const line of linesByPurchase.get(purchase.id) ?? []) {
      gstr2B2b.push({
        'GSTIN/UIN of Supplier': supplier?.gstin ?? '', 'Supplier Name': supplier?.name ?? '', 'Bill Number': purchase.supplier_bill_number || purchase.bill_number,
        'Bill date': purchase.bill_date, 'Bill Value': rupees(purchase.total_paise), 'Place Of Supply': purchase.supplier_state_code,
        'Reverse Charge': 'N', Rate: rate(line.tax_rate_bps), 'Taxable Value': rupees(line.taxable_paise),
        'Integrated Tax Amount': rupees(line.igst_paise), 'Central Tax Amount': rupees(line.cgst_paise), 'State/UT Tax Amount': rupees(line.sgst_paise), 'Cess Amount': rupees(line.cess_paise),
      });
    }
  }
  const cdnr: GstrRow[] = activeSalesReturns.flatMap((note) => {
    const customer = customerById.get(note.customer_id);
    const original = invoiceById.get(note.original_invoice_id);
    if (!customer || !validGstin(customer.gstin)) return [];
    return [{
      'GSTIN/UIN of Recipient': customer.gstin,
      'Receiver Name': customer.name,
      'Note Number': note.return_number,
      'Note Date': note.return_date,
      'Note Type': 'C',
      'Place Of Supply': original?.place_of_supply ?? '',
      'Reverse Charge': 'N',
      'Note Supply Type': 'Regular',
       'Note Value': rupees(note.total_paise),
       'Applicable % of Tax Rate': '',
       Rate: note.taxable_paise ? rate((note.cgst_paise + note.sgst_paise + note.igst_paise) * 10000 / note.taxable_paise) : 0,
       'Taxable Value': rupees(note.taxable_paise),
       'Integrated Tax Amount': rupees(note.igst_paise),
       'Central Tax Amount': rupees(note.cgst_paise),
       'State/UT Tax Amount': rupees(note.sgst_paise),
       'Cess Amount': rupees(note.cess_paise),
       'Round Off Amount': rupees(note.round_off_paise),
     }];
  });
  const cdnur: GstrRow[] = [];
  const b2csNoteWarnings: GstrValidationIssue[] = [];
  for (const note of activeSalesReturns) {
    const customer = customerById.get(note.customer_id);
    if (validGstin(customer?.gstin)) continue;
    const original = note.original_invoice_id ? invoiceById.get(note.original_invoice_id) : undefined;
    const placeOfSupply = original?.place_of_supply;
    const qualifiesB2cl = Boolean(original && original.is_interstate === 1 && original.invoice_date >= GSTR_RULES.b2clThresholdEffectiveFrom && original.total_paise > GSTR_RULES.b2clThresholdPaise);
    const rateValue = note.taxable_paise ? rate(Math.round((note.cgst_paise + note.sgst_paise + note.igst_paise) * 10000 / note.taxable_paise)) : 0;
    if (qualifiesB2cl && placeOfSupply) {
      cdnur.push({ 'UR Type': 'B2CL', 'Note Number': note.return_number, 'Note Date': note.return_date, 'Note Type': 'C', 'Place Of Supply': placeOfSupply, 'Note Value': rupees(note.total_paise), 'Applicable % of Tax Rate': '', Rate: rateValue, 'Taxable Value': rupees(note.taxable_paise), 'Integrated Tax Amount': rupees(note.igst_paise), 'Central Tax Amount': rupees(note.cgst_paise), 'State/UT Tax Amount': rupees(note.sgst_paise), 'Cess Amount': rupees(note.cess_paise), 'Round Off Amount': rupees(note.round_off_paise) });
      continue;
    }
    if (placeOfSupply && original) {
      const key = `${placeOfSupply}|${rateValue * 100}`;
      const row = b2csByKey.get(key) ?? { Type: 'OE', 'Invoice Number': note.return_number, 'Place Of Supply': placeOfSupply, 'Applicable % of Tax Rate': '', Rate: rateValue, 'Taxable Value': 0, 'Cess Amount': 0, 'E-Commerce GSTIN': '' };
      row['Taxable Value'] = Number(row['Taxable Value']) - rupees(note.taxable_paise);
      row['Cess Amount'] = Number(row['Cess Amount']) - rupees(note.cess_paise);
      b2csByKey.set(key, row);
      continue;
    }
    b2csNoteWarnings.push({ severity: 'warning', message: `Sales note ${note.return_number} is unclassified: missing ${placeOfSupply ? 'original supply classification' : 'place of supply'}${original ? '' : ' and original invoice context'}. No CDNUR or B2CS values were fabricated.`, documentNumber: note.return_number });
  }
  gstr1B2cs.length = 0;
  gstr1B2cs.push(...b2csByKey.values());
  const reportData: GstrReport = {
    report, schema_version: 1, generated_at: new Date().toISOString(), period: { from, to },
    business: { gstin: business.gstin, legal_name: business.legal_name, trade_name: business.name },
    sections: report === 'gstr1' ? {
      'GSTR1 Report': { columns: ['GSTIN/UIN', 'Party Name', 'Transaction Type', 'Invoice No.', 'Invoice Date', 'Invoice Value', 'Rate', 'Cess Rate', 'Taxable value', 'Reverse Charge', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Place of Supply(Name of state)'], rows: [] },
      'b2b,sez,de': { columns: GSTR1_COLUMNS.b2b, rows: gstr1B2b }, b2cl: { columns: GSTR1_COLUMNS.b2cl, rows: gstr1B2cl }, b2cs: { columns: GSTR1_COLUMNS.b2cs, rows: gstr1B2cs },
      cdnr: { columns: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Round Off Amount'], rows: cdnr }, cdnur: { columns: ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Round Off Amount'], rows: cdnur }, exp: empty(['Export Type', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Port Code', 'Shipping Bill Number', 'Shipping Bill Date', 'Rate', 'Taxable Value']), at: empty(['Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Gross Advance Received', 'Cess Amount']), atadj: empty(['Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Gross Advance Adjusted', 'Cess Amount']), exemp: empty(['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies']),
      'hsn(b2b)': { columns: GSTR1_COLUMNS.hsn, rows: hsnRows(invoiceLines.filter((line) => !b2cInvoiceIds.has(line.invoice_id)), invoiceById, itemsById, unitsById) }, 'hsn(b2c)': { columns: GSTR1_COLUMNS.hsn, rows: hsnRows(invoiceLines.filter((line) => b2cInvoiceIds.has(line.invoice_id)), invoiceById, itemsById, unitsById) }, itemSummary: { columns: GSTR1_COLUMNS.hsn, rows: hsnRows(invoiceLines, invoiceById, itemsById, unitsById) }, docs: { columns: ['Nature of Document', 'Serial number from', 'Serial number to', 'Total documents issued', 'Cancelled documents', 'Net documents issued'], rows: [{ 'Nature of Document': 'Invoices for outward supply', 'Serial number from': activeInvoices[0]?.invoice_number ?? '', 'Serial number to': activeInvoices.at(-1)?.invoice_number ?? '', 'Total documents issued': activeInvoices.length + invoices.filter((i) => i.status === 'cancelled').length, 'Cancelled documents': invoices.filter((i) => i.status === 'cancelled').length, 'Net documents issued': activeInvoices.length }, { 'Nature of Document': 'Credit Note', 'Serial number from': activeSalesReturns[0]?.return_number ?? '', 'Serial number to': activeSalesReturns.at(-1)?.return_number ?? '', 'Total documents issued': activeSalesReturns.length + salesReturns.filter((r) => r.status === 'cancelled').length, 'Cancelled documents': salesReturns.filter((r) => r.status === 'cancelled').length, 'Net documents issued': activeSalesReturns.length }] },
    } : {
      'GSTR2 Report': { columns: ['GSTIN/UIN', 'Supplier Name', 'Bill Number', 'Bill Date', 'Bill Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'], rows: [] }, b2b: { columns: GSTR2_COLUMNS.b2b, rows: gstr2B2b }, hsn: { columns: GSTR2_COLUMNS.hsn, rows: hsnRows(purchaseLines, purchaseById, itemsById, unitsById) }, docs: { columns: ['Nature of Document', 'Bill Number From', 'Bill Number To', 'Total Number', 'Cancelled'], rows: [{ 'Nature of Document': 'Bills for inward supply', 'Bill Number From': activePurchases[0]?.supplier_bill_number || activePurchases[0]?.bill_number || '', 'Bill Number To': activePurchases.at(-1)?.supplier_bill_number || activePurchases.at(-1)?.bill_number || '', 'Total Number': activePurchases.length, Cancelled: purchases.filter((p) => p.status === 'cancelled').length }] },
    },
  };
  const reconciliationIssues: GstrValidationIssue[] = [];
  const unsupported = UNSUPPORTED_CATEGORIES.join(', ');
  reconciliationIssues.push({ severity: 'warning', message: `Unsupported source categories left empty: ${unsupported}.` });
  reconciliationIssues.push({ severity: 'warning', message: 'Preceding-year turnover is not stored by the application; HSN validation accepts 4- or 6-digit numeric codes and cannot select the filing-required length automatically.' });
  for (const invoice of activeInvoices) {
    if (!(linesByInvoice.get(invoice.id)?.length)) reconciliationIssues.push({ severity: 'warning', message: 'Invoice has no invoice lines and was not exported.', documentNumber: invoice.invoice_number });
  }
  for (const purchase of activePurchases) {
    if (!(linesByPurchase.get(purchase.id)?.length)) reconciliationIssues.push({ severity: 'warning', message: 'Purchase has no purchase lines and was not exported.', documentNumber: purchase.bill_number });
  }
  for (const note of activeSalesReturns) {
    const components = note.taxable_paise + note.igst_paise + note.cgst_paise + note.sgst_paise + note.cess_paise + note.round_off_paise;
    if (components !== note.total_paise) {
      reconciliationIssues.push({
        severity: 'warning',
        message: `Credit note components (${rupees(components)}) do not reconcile to Note Value (${rupees(note.total_paise)}); verify taxable, GST, cess, and round-off values.`,
        documentNumber: note.return_number,
      });
    }
  }
  for (const invoice of activeInvoices) {
    const customer = customerById.get(invoice.customer_id);
    if (customer?.gstin && !validGstin(customer.gstin)) reconciliationIssues.push({ severity: 'warning', message: 'Invalid customer GSTIN; classified as B2C rather than B2B.', documentNumber: invoice.invoice_number });
    const lines = linesByInvoice.get(invoice.id) ?? [];
    for (const line of lines) if (!hsnLengthIsSupported(line.hsn)) reconciliationIssues.push({ severity: 'warning', message: `HSN '${line.hsn}' is not a 4- or 6-digit numeric code.`, documentNumber: invoice.invoice_number });
  }
  reconciliationIssues.push(...b2csNoteWarnings);
  reportData.reconciliationIssues = reconciliationIssues;
  log.info('gstrExport', 'report built', { businessId, report, from, to, sectionCount: Object.keys(reportData.sections).length, activeInvoiceCount: activeInvoices.length, activePurchaseCount: activePurchases.length });
  return reportData;
}

export async function downloadGstrJson(data: GstrReport): Promise<void> {
  triggerDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), `${data.report}-${data.period.from}-to-${data.period.to}.json`);
  log.info('gstrExport', 'JSON downloaded', { report: data.report, sectionCount: Object.keys(data.sections).length });
}

export async function downloadGstrCsv(data: GstrReport): Promise<void> {
  const rows = Object.entries(data.sections).flatMap(([section, value]) => value.rows.map((row) => ({ section, ...row })));
  const columns = ['section', ...Array.from(new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== 'section'))))];
  await streamCsvToBlob({ columns, rows, toRow: (row) => row }, { bom: true }).then((blob) => triggerDownload(blob, `${data.report}-${data.period.from}-to-${data.period.to}.csv`));
  log.info('gstrExport', 'CSV downloaded', { report: data.report, rowCount: rows.length });
}

function excelRows(section: GstrSection): Array<Record<string, string | number | Date | null>> {
  return section.rows.map((row) => {
    const result: Record<string, string | number | Date | null> = {};
    for (const [key, value] of Object.entries(row)) {
      result[key] = key.toLowerCase().includes('date') && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? excelDate(value)
        : value;
    }
    return result;
  });
}

function mainRows(report: GstrReport): Array<Record<string, string | number | Date | null>> {
  const sections = report.report === 'gstr1'
    ? [report.sections['b2b,sez,de'], report.sections.b2cl, report.sections.b2cs]
    : [report.sections.b2b];
  return sections.flatMap((section) => (section?.rows ?? []).map((row) => {
    const taxable = Number(row['Taxable Value'] ?? row['Taxable value'] ?? 0);
    const integrated = Number(row['Integrated Tax Amount'] ?? 0);
    const central = Number(row['Central Tax Amount'] ?? 0);
    const state = Number(row['State/UT Tax Amount'] ?? 0);
    const cess = Number(row['Cess Amount'] ?? 0);
    const rateValue = Number(row.Rate ?? 0);
    const invoiceValue = Number(row['Invoice Value'] ?? row['Bill Value'] ?? 0);
    const dateValue = report.report === 'gstr1' ? row['Invoice date'] : row['Bill date'];
    const result: Record<string, string | number | Date | null> = {
      'GSTIN/UIN': (report.report === 'gstr1' ? row['GSTIN/UIN of Recipient'] : row['GSTIN/UIN of Supplier']) ?? null,
      'Party Name': (report.report === 'gstr1' ? row['Receiver Name'] : row['Supplier Name']) ?? null,
      'Transaction Type': report.report === 'gstr1' ? row['Invoice Type'] ?? row.Type ?? 'Outward supply' : 'Inward supply / ITC',
      'Invoice No.': (report.report === 'gstr1' ? row['Invoice Number'] : row['Bill Number']) ?? null,
      'Invoice Date': typeof dateValue === 'string' ? excelDate(dateValue) : dateValue ?? null,
      'Invoice Value': invoiceValue,
      Rate: rateValue,
      'Cess Rate': null,
      'Taxable value': taxable,
      'Integrated Tax Amount': integrated,
      'Central Tax Amount': central,
      'State/UT Tax Amount': state,
      'Cess Amount': cess,
      'Place of Supply(Name of state)': row['Place Of Supply'] ?? null,
      'Reverse Charge': report.report === 'gstr1' ? row['Reverse Charge'] ?? 'N' : null,
    };
    return result;
  }));
}

function summaryRows(rows: Array<Record<string, string | number | Date | null>>): Array<[string, string | number | null]> {
  const total = (key: string): number => rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
  const documents = new Set(rows.map((row) => String(row['Invoice No.'] ?? '')).filter(Boolean));
  const invoiceValues = new Map<string, number>();
  for (const row of rows) {
    const number = String(row['Invoice No.'] ?? '');
    if (number && !invoiceValues.has(number)) invoiceValues.set(number, Number(row['Invoice Value'] ?? 0));
  }
  return [
    ['Total Documents', documents.size],
    ['Total Invoice/Bill Value', Array.from(invoiceValues.values()).reduce((sum, value) => sum + value, 0)],
    ['Total Taxable Value', total('Taxable value')],
    ['Integrated Tax', total('Integrated Tax Amount')],
    ['Central Tax', total('Central Tax Amount')],
    ['State/UT Tax', total('State/UT Tax Amount')],
    ['Cess', total('Cess Amount')],
  ];
}

function addBlankGstrSheet(workbook: ExcelJS.Workbook, name: string, title: string): void {
  makeWorkbookSheet(workbook, name, title, [['Status', 'No source data available']], ['Description'], []);
}

function sectionSummary(section: GstrSection, from: string, to: string): Array<[string, string | number | null]> {
  const total = (key: string): number => section.rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
  return [
    ['Period', `${from} to ${to}`],
    ['Rows', section.rows.length],
    ['Taxable Value', total('Taxable Value') || total('Taxable value')],
    ['Integrated Tax', total('Integrated Tax Amount')],
    ['Central Tax', total('Central Tax Amount')],
    ['State/UT Tax', total('State/UT Tax Amount')],
    ['Cess', total('Cess Amount')],
  ];
}

export async function buildGstrExcel(
  businessId: string,
  report: GstrReportKind,
  from: string,
  to: string,
  opts: GstrExportOptions = {},
): Promise<GstrExcelResult> {
  const data = await buildGstrReport(businessId, report, from, to, opts);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BusinessVault';
  workbook.created = new Date();
  const issues: GstrValidationIssue[] = [...(data.reconciliationIssues ?? [])];
  const main = mainRows(data);
  if (!validGstin(data.business.gstin)) {
    issues.push({ severity: 'warning', message: 'Business GSTIN is missing or failed checksum validation; verify before filing.' });
  }
  const b2bGstins = new Set(main
    .filter((row) => typeof row['GSTIN/UIN'] === 'string' && validGstin(row['GSTIN/UIN'] as string))
    .map((row) => row['GSTIN/UIN'] as string));
  if (report === 'gstr1') issues.push({ severity: 'warning', message: `Distinct valid B2B recipient GSTINs: ${b2bGstins.size}.` });

  const mainTitle = report === 'gstr1'
    ? 'GSTR-1 Outward Supplies Report'
    : 'GSTR-2 Internal Purchase and Input Tax Credit Report (not a filed GSTR-2A/2B return)';
  const sectionNames = report === 'gstr1' ? GSTR1_SHEET_ORDER : GSTR2_SHEET_ORDER;
  for (const name of sectionNames) {
    if (name === 'GSTR1 Report' || name === 'GSTR2 Report') {
      makeWorkbookSheet(workbook, name, mainTitle,
        [['Business', data.business.trade_name], ['GSTIN', data.business.gstin], ['Period', `${from} to ${to}`], ...summaryRows(main)],
        report === 'gstr1' ? MAIN_GSTR1_COLUMNS : MAIN_GSTR2_COLUMNS, main);
      continue;
    }
    const sectionKey = name === 'hsn(b2b)' || name === 'hsn(b2c)' ? name : name;
      const section = name === 'hsnsum' ? data.sections.hsn : data.sections[sectionKey];
    if (section) {
      makeWorkbookSheet(workbook, name, name, sectionSummary(section, from, to), section.columns, excelRows(section));
    } else {
      addBlankGstrSheet(workbook, name, name);
    }
  }
  for (const section of Object.values(data.sections)) {
    for (const row of section.rows) {
      const gstin = text(row['GSTIN/UIN of Recipient'] ?? row['GSTIN/UIN of Supplier']);
      if (gstin && !validGstin(gstin)) issues.push({ severity: 'warning', message: `Party GSTIN failed checksum validation: ${gstin}` });
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${report}-${from}-to-${to}.xlsx`;
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBufferLike);
  const xlsxBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { blob: new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename, issues, xlsxBuffer };
}

export async function downloadGstrExcel(
  businessId: string,
  report: GstrReportKind,
  from: string,
  to: string,
  opts: GstrExportOptions = {},
): Promise<GstrExcelResult> {
  const result = await buildGstrExcel(businessId, report, from, to, opts);
  triggerDownload(result.blob, result.filename);
  log.info('gstrExport', 'Excel downloaded', { businessId, report, from, to, issueCount: result.issues.length });
  return result;
}
