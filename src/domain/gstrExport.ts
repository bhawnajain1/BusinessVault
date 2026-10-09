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
  SalesReturnItem,
  Supplier,
  Unit,
} from '../db/types';
import { isValidGstin, isValidStateCode } from '../lib/gst';
import { log } from '../lib/log';
import { streamCsvToBlob, triggerDownload } from '../csv/streamCsvExport';
import ExcelJS from 'exceljs';

export type GstrReportKind = 'gstr1' | 'purchaseRegister';

export interface GstrRow {
  [key: string]: string | number | null;
}

export interface GstrSection {
  columns: string[];
  rows: GstrRow[];
}

export interface GstrReport {
  schema_name: 'BusinessVaultGSTWorkpaper';
  money_unit: 'paise';
  disclaimer: 'Internal BusinessVault workpaper; not GSTN upload JSON and not proof of filing.';
  report: GstrReportKind;
  schema_version: 1;
  status: 'INCOMPLETE';
  generated_at: string;
  period: { from: string; to: string };
  business: { gstin: string | null; legal_name: string; trade_name: string };
  sections: Record<string, GstrSection>;
  reconciliationIssues?: GstrValidationIssue[];
}

export interface GstrExportOptions {
  db?: BusinessVaultDB;
}

export interface GstSlabSummaryRow {
  rate_bps: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  cess_paise: number;
  line_count: number;
  invoice_count: number;
}

export interface GstrValidationIssue {
  severity: 'blocking_error' | 'warning' | 'information';
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
  b2clThresholdBefore20240801Paise: 25_000_000,
  b2clThresholdFrom20240801Paise: 10_000_000,
  b2clThresholdEffectiveFrom: '2024-08-01',
  hsnTurnoverThresholdPaise: 5_000_000_000,
  hsnShortLength: 4,
  hsnLongLength: 6,
} as const;

export function hsnRequiredLengthForTurnover(previousYearTurnoverPaise: number): 4 | 6 {
  return previousYearTurnoverPaise > GSTR_RULES.hsnTurnoverThresholdPaise
    ? GSTR_RULES.hsnLongLength
    : GSTR_RULES.hsnShortLength;
}

export function isB2cLargeValue(date: string, invoiceValuePaise: number, interstate: boolean): boolean {
  if (!Number.isSafeInteger(invoiceValuePaise) || invoiceValuePaise < 0) throw new Error('B2C Large invoice value must be non-negative integer paise');
  if (!interstate) return false;
  const threshold = date < GSTR_RULES.b2clThresholdEffectiveFrom
    ? GSTR_RULES.b2clThresholdBefore20240801Paise
    : GSTR_RULES.b2clThresholdFrom20240801Paise;
  return invoiceValuePaise > threshold;
}

const UNSUPPORTED_CATEGORIES = [
  'SEZ/deemed exports', 'reverse charge', 'shipping bills/exports', 'imports',
  'e-commerce supplies', 'ITC reversals', 'nil/exempt classification',
] as const;

export const GSTR1_SHEET_ORDER = [
  'Summary', 'B2B', 'B2C Large', 'B2C Other', 'Credit Notes B2B', 'Credit Notes B2C',
  'HSN B2B', 'HSN B2C', 'Documents Issued', 'Exceptions',
] as const;

export const PURCHASE_REGISTER_SHEET_ORDER = [
  'Summary', 'Supplier Bills', 'HSN Summary', 'Exceptions',
] as const;

function excelDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function moneyValue(paise: number): number {
  if (!Number.isSafeInteger(paise)) throw new Error(`GST amount is not safe integer paise: ${paise}`);
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
  b2b: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
  b2cl: ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'E-Commerce GSTIN'],
  b2cs: ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'E-Commerce GSTIN'],
  hsn: ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
};

const PURCHASE_REGISTER_COLUMNS = {
  b2b: ['GSTIN/UIN of Supplier', 'Supplier Name', 'Bill Number', 'Bill date', 'Bill Value', 'Place Of Supply', 'Reverse Charge', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
  hsn: GSTR1_COLUMNS.hsn,
};

function rupees(paise: number): number {
  return moneyValue(paise);
}

function rate(bps: number): number {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new Error('GST rate must be non-negative integer basis points');
  return bps / 100;
}

function hsnLengthIsSupported(hsn: string): boolean {
  return /^\d{4}(\d{2})?(\d{2})?$/.test(hsn.trim());
}

export function isHsnLengthSupported(hsn: string): boolean {
  return hsnLengthIsSupported(hsn);
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
    if (!doc || doc.status === 'cancelled' || ('deleted_at' in doc && doc.deleted_at) || ('reverses_invoice_id' in doc && doc.reverses_invoice_id) || ('replaced_by_purchase_id' in doc && doc.replaced_by_purchase_id)) continue;
    const amountFields = [line.line_total_paise, line.taxable_paise, line.igst_paise, line.cgst_paise, line.sgst_paise, line.cess_paise];
    for (const amount of amountFields) addSafeInteger(0, amount, 'HSN amount in paise');
    addSafeInteger(0, line.qty_micros, 'HSN quantity micros');
    const item = itemsById.get(line.item_id);
    const unit = item ? unitsById.get(item.unit_id) : undefined;
    const key = `${line.hsn}|${line.tax_rate_bps}|${unit?.code ?? ''}`;
    const row = grouped.get(key) ?? {
      HSN: line.hsn,
      Description: line.description,
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
    const totalQuantity = row['Total Quantity'];
    const totalValue = row['Total Value'];
    const taxable = row['Taxable Value'];
    const igst = row['Integrated Tax Amount'];
    const cgst = row['Central Tax Amount'];
    const sgst = row['State/UT Tax Amount'];
    const cess = row['Cess Amount'];
    if ([totalQuantity, totalValue, taxable, igst, cgst, sgst, cess].some((value) => typeof value !== 'number')) {
      throw new Error('GST HSN aggregation encountered a non-numeric accumulator');
    }
    row['Total Quantity'] = addSafeInteger(totalQuantity as number, line.qty_micros, 'quantity micros');
    row['Total Value'] = addPaise(totalValue as number, line.line_total_paise);
    row['Taxable Value'] = addPaise(taxable as number, line.taxable_paise);
    row['Integrated Tax Amount'] = addPaise(igst as number, line.igst_paise);
    row['Central Tax Amount'] = addPaise(cgst as number, line.cgst_paise);
    row['State/UT Tax Amount'] = addPaise(sgst as number, line.sgst_paise);
    row['Cess Amount'] = addPaise(cess as number, line.cess_paise);
    grouped.set(key, row);
  }
  return Array.from(grouped.values(), (row) => ({
    ...row,
    'Total Quantity': typeof row['Total Quantity'] === 'number'
      ? row['Total Quantity'] / 1_000_000
      : row['Total Quantity'],
  }));
}

function addSafeInteger(total: number, value: number, label: string): number {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(value)) {
    throw new Error(`GST ${label} must be a safe integer`);
  }
  const result = total + value;
  if (!Number.isSafeInteger(result)) throw new Error(`GST ${label} total exceeds the safe integer range`);
  return result;
}

export function addPaise(total: number, value: number): number {
  return addSafeInteger(total, value, 'amount in paise');
}

export function sumPaise(values: number[]): number {
  return values.reduce((total, value) => addPaise(total, value), 0);
}

export async function loadGstSlabSummary(
  businessId: string,
  report: GstrReportKind,
  from: string,
  to: string,
  opts: GstrExportOptions = {},
): Promise<GstSlabSummaryRow[]> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const isSales = report === 'gstr1';
  const documents = isSales
    ? await db.invoices.where('[business_id+invoice_date]').between([businessId, from], [businessId, to], true, true).toArray()
    : await db.purchases.where('[business_id+bill_date]').between([businessId, from], [businessId, to], true, true).toArray();
  const activeIds = documents
    .filter((document) => document.status !== 'draft' && document.status !== 'cancelled' && !('deleted_at' in document && document.deleted_at) && !('reversed_by_invoice_id' in document && document.reversed_by_invoice_id) && !('reverses_invoice_id' in document && document.reverses_invoice_id) && !('reversed_by_purchase_id' in document && document.reversed_by_purchase_id) && !('replaced_by_purchase_id' in document && document.replaced_by_purchase_id))
    .map((document) => document.id);
  const lineKeys = activeIds.map((id) => [businessId, id]);
  const lines = !activeIds.length
    ? []
    : isSales
      ? await db.invoice_lines.where('[business_id+invoice_id]').anyOf(lineKeys).toArray()
      : await db.purchase_lines.where('[business_id+purchase_id]').anyOf(lineKeys).toArray();
  const grouped = new Map<number, GstSlabSummaryRow & { documentIds: Set<string> }>();
  for (const line of lines) {
    const documentId = 'invoice_id' in line ? line.invoice_id : line.purchase_id;
    const row = grouped.get(line.tax_rate_bps) ?? {
      rate_bps: line.tax_rate_bps,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
      line_count: 0,
      invoice_count: 0,
      documentIds: new Set<string>(),
    };
    for (const value of [row.taxable_paise, row.cgst_paise, row.sgst_paise, row.igst_paise, row.cess_paise]) {
      addSafeInteger(0, value, 'GST slab accumulator in paise');
    }
    row.taxable_paise = addPaise(row.taxable_paise, line.taxable_paise);
    row.cgst_paise = addPaise(row.cgst_paise, line.cgst_paise);
    row.sgst_paise = addPaise(row.sgst_paise, line.sgst_paise);
    row.igst_paise = addPaise(row.igst_paise, line.igst_paise);
    row.cess_paise = addPaise(row.cess_paise, line.cess_paise);
    row.line_count += 1;
    row.documentIds.add(documentId);
    grouped.set(line.tax_rate_bps, row);
  }
  return Array.from(grouped.values())
    .map(({ documentIds, ...row }) => ({ ...row, invoice_count: documentIds.size }))
    .sort((a, b) => a.rate_bps - b.rate_bps);
}

function isB2cLarge(invoice: Invoice): boolean {
  return isB2cLargeValue(invoice.invoice_date, invoice.total_paise, invoice.is_interstate === 1);
}

function checkDocumentInvariant(
  document: { taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; cess_paise: number; pre_round_total_paise: number; round_off_paise: number; total_paise: number },
  label: string,
  documentNumber: string,
  issues: GstrValidationIssue[],
): void {
  try {
    const componentPreRound = [document.taxable_paise, document.cgst_paise, document.sgst_paise, document.igst_paise, document.cess_paise]
      .reduce((sum, value) => addPaise(sum, value), 0);
    const totalFromRoundOff = addPaise(document.pre_round_total_paise, document.round_off_paise);
    if (document.pre_round_total_paise !== componentPreRound || totalFromRoundOff !== document.total_paise) {
      issues.push({ severity: 'blocking_error', message: `${label} paise invariant failed: component sum ${componentPreRound}, pre-round ${document.pre_round_total_paise}, round-off ${document.round_off_paise}, total ${document.total_paise}.`, documentNumber });
    }
  } catch (error) {
    issues.push({ severity: 'blocking_error', message: `${label} paise invariant could not be checked: ${error instanceof Error ? error.message : String(error)}.`, documentNumber });
  }
}

const MONEY_COLUMNS = new Set([
  'Invoice Value', 'Bill Value', 'Note Value', 'Taxable Value', 'Taxable value',
  'Total Value', 'Integrated Tax Amount', 'Central Tax Amount',
  'State/UT Tax Amount', 'Cess Amount', 'Round Off Amount',
]);

function rupeeRows(rows: GstrRow[]): Array<Record<string, string | number | null>> {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    MONEY_COLUMNS.has(key) && typeof value === 'number' ? moneyValue(value) : value,
  ])));
}

function paiseValue(row: GstrRow, ...keys: string[]): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number') return value;
    if (value !== null && value !== undefined && value !== '') throw new Error(`GST money field '${key}' is not integer paise`);
  }
  return 0;
}

function reportFilename(data: GstrReport, extension: string): string {
  const period = data.period.from.slice(0, 7) === data.period.to.slice(0, 7)
    ? data.period.from.slice(0, 7)
    : `${data.period.from}-to-${data.period.to}`;
  const reportName = data.report === 'gstr1' ? 'gstr1-workpaper' : 'purchase-register';
  return `bv-${reportName}-${period}.${extension}`;
}

export function parseDocumentSeries(
  documents: Array<{ number: string; cancelled: boolean }>,
): Array<{ prefix: string; from: string; to: string; total: number; cancelled: number; net: number; gaps: string[]; duplicates: string[] }> {
  const groups = new Map<string, Array<{ number: string; serial: number; cancelled: boolean }>>();
  for (const document of documents) {
    const match = /^(.*?)(\d+)$/.exec(document.number);
    if (!match) continue;
    const prefix = match[1];
    const rows = groups.get(prefix) ?? [];
    rows.push({ number: document.number, serial: Number(match[2]), cancelled: document.cancelled });
    groups.set(prefix, rows);
  }
  return Array.from(groups.entries()).map(([prefix, rows]) => {
    rows.sort((a, b) => a.serial - b.serial || a.number.localeCompare(b.number));
    const seen = new Set<number>();
    const gaps: string[] = [];
    const duplicates: string[] = [];
    let previous: number | undefined;
    for (const row of rows) {
      if (seen.has(row.serial)) duplicates.push(row.number);
      seen.add(row.serial);
      if (previous !== undefined && row.serial > previous + 1) {
        gaps.push(`${prefix}${previous + 1}-${prefix}${row.serial - 1}`);
      }
      previous = row.serial;
    }
    const cancelled = rows.filter((row) => row.cancelled).length;
    return {
      prefix,
      from: rows[0].number,
      to: rows[rows.length - 1].number,
      total: rows.length,
      cancelled,
      net: rows.length - cancelled,
      gaps,
      duplicates,
    };
  });
}

export async function buildGstrReport(
  businessId: string,
  report: GstrReportKind,
  from: string,
  to: string,
  opts: GstrExportOptions = {},
): Promise<GstrReport> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const [business, customers, suppliers, items, units, invoices, purchases, salesReturns] = await Promise.all([
    db.businesses.get(businessId),
    db.customers.where('business_id').equals(businessId).toArray(),
    db.suppliers.where('business_id').equals(businessId).toArray(),
    db.items.where('business_id').equals(businessId).toArray(),
    db.units.where('business_id').equals(businessId).toArray(),
    db.invoices.where('[business_id+invoice_date]').between([businessId, from], [businessId, to], true, true).toArray(),
    db.purchases.where('[business_id+bill_date]').between([businessId, from], [businessId, to], true, true).toArray(),
    db.sales_returns.where('[business_id+return_date]').between([businessId, from], [businessId, to], true, true).toArray(),
  ]);
  if (!business) throw new Error('Business not found');
  const businessInvoices = await db.invoices.where('business_id').equals(businessId).toArray();
  const businessPurchases = await db.purchases.where('business_id').equals(businessId).toArray();
  const activeSalesReturns = (salesReturns as SalesReturn[]).filter((r) => r.status === 'posted' && !r.deleted_at);
  const originalsOutsidePeriod = await db.invoices.bulkGet(
    [...new Set(activeSalesReturns.map((note) => note.original_invoice_id))].filter((id) => !invoices.some((invoice) => invoice.id === id)),
  );
  const invoiceContext = [...invoices, ...originalsOutsidePeriod.filter((invoice): invoice is Invoice => Boolean(invoice && invoice.business_id === businessId))];
  const activeInvoices = invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled' && !i.deleted_at && !i.reversed_by_invoice_id && !i.reverses_invoice_id);
  const activePurchases = purchases.filter((p) => p.status !== 'draft' && p.status !== 'cancelled' && !p.reversed_by_purchase_id && !p.replaced_by_purchase_id);
  const invoiceLineKeys = activeInvoices.map((invoice) => [businessId, invoice.id] as [string, string]);
  const purchaseLineKeys = activePurchases.map((purchase) => [businessId, purchase.id] as [string, string]);
  const [invoiceLines, purchaseLines] = await Promise.all([
    invoiceLineKeys.length ? db.invoice_lines.where('[business_id+invoice_id]').anyOf(invoiceLineKeys).toArray() : Promise.resolve([] as InvoiceLine[]),
    purchaseLineKeys.length ? db.purchase_lines.where('purchase_id').anyOf(purchaseLineKeys.map((key) => key[1])).filter((line) => line.business_id === businessId).toArray() : Promise.resolve([] as PurchaseLine[]),
  ]);
  const salesReturnItemKeys = activeSalesReturns.map((note) => [businessId, note.id] as [string, string]);
  const salesReturnItems = salesReturnItemKeys.length
    ? await db.sales_return_items.where('[business_id+sales_return_id]').anyOf(salesReturnItemKeys).toArray()
    : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const invoiceById = new Map(invoiceContext.map((i) => [i.id, i]));
  const purchaseById = new Map(activePurchases.map((p) => [p.id, p]));
  const linesByInvoice = new Map<string, InvoiceLine[]>();
  const invalidLineIds = new Set<string>();
  for (const line of invoiceLines) {
    if (!invoiceById.has(line.invoice_id)) continue;
    const rows = linesByInvoice.get(line.invoice_id) ?? [];
    rows.push(line);
    linesByInvoice.set(line.invoice_id, rows);
  }
  const linesByPurchase = new Map<string, PurchaseLine[]>();
  for (const line of purchaseLines) {
    if (!purchaseById.has(line.purchase_id)) continue;
    const rows = linesByPurchase.get(line.purchase_id) ?? [];
    rows.push(line);
    linesByPurchase.set(line.purchase_id, rows);
  }
  const sourceIssues: GstrValidationIssue[] = [];
  const invalidGstinDocuments = new Set<string>();
  const validateSourceAmounts = (amounts: number[], label: string, documentNumber: string): boolean => {
    try {
      for (const amount of amounts) addSafeInteger(0, amount, `${label} source amount in paise`);
      return true;
    } catch (error) {
      sourceIssues.push({ severity: 'blocking_error', message: error instanceof Error ? error.message : String(error), documentNumber });
      return false;
    }
  };
  const hsnReturnLinesB2b: InvoiceLine[] = [];
  const hsnReturnLinesB2c: InvoiceLine[] = [];
  const hsnReturnContextById = new Map(invoiceById);
  const returnItemsByReturn = new Map<string, SalesReturnItem[]>();
  for (const item of salesReturnItems) {
    const rows = returnItemsByReturn.get(item.sales_return_id) ?? [];
    rows.push(item);
    returnItemsByReturn.set(item.sales_return_id, rows);
  }
  for (const note of activeSalesReturns) {
    const noteItems = returnItemsByReturn.get(note.id) ?? [];
    const original = invoiceById.get(note.original_invoice_id);
    const customer = customerById.get(note.customer_id);
    if (!original || !customer) continue;
    if (noteItems.length === 0) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Posted credit note has no line details; HSN summary cannot be reconciled.', documentNumber: note.return_number });
      continue;
    }
    const customerGstin = customer.gstin?.trim() ?? '';
    if (customerGstin && !isValidGstin(customerGstin)) {
      invalidGstinDocuments.add(note.return_number);
      continue;
    }
    hsnReturnContextById.set(original.id, {
      ...original,
      status: 'issued',
      deleted_at: null,
      reverses_invoice_id: null,
    });
    for (const item of noteItems) {
      const validAmounts = validateSourceAmounts(
        [item.unit_price_paise, item.discount_paise, item.taxable_paise, item.cgst_paise, item.sgst_paise, item.igst_paise, item.cess_paise, item.line_total_paise],
        'sales-return line',
        note.return_number,
      );
      if (!validAmounts || !Number.isSafeInteger(item.qty_micros) || item.qty_micros < 0) {
        sourceIssues.push({ severity: 'blocking_error', message: `Sales-return line ${item.id} has invalid quantity data.`, documentNumber: note.return_number });
        continue;
      }
      const returnLine: InvoiceLine = {
        id: `sales-return:${item.id}`,
        business_id: item.business_id,
        invoice_id: original.id,
        line_no: item.line_no,
        item_id: item.item_id,
        description: item.description,
        hsn: item.hsn,
        warehouse_id: item.warehouse_id,
        qty_micros: -item.qty_micros,
        unit_price_paise: item.unit_price_paise,
        discount_pct_bps: item.discount_pct_bps,
        discount_paise: -item.discount_paise,
        taxable_paise: -item.taxable_paise,
        tax_rate_bps: item.tax_rate_bps,
        cgst_paise: -item.cgst_paise,
        sgst_paise: -item.sgst_paise,
        igst_paise: -item.igst_paise,
        cess_paise: -item.cess_paise,
        line_total_paise: -item.line_total_paise,
      };
      (customerGstin ? hsnReturnLinesB2b : hsnReturnLinesB2c).push(returnLine);
    }
  }
  for (const line of invoiceLines) {
    const amounts = [line.unit_price_paise, line.discount_paise, line.taxable_paise, line.cgst_paise, line.sgst_paise, line.igst_paise, line.cess_paise, line.line_total_paise];
    const document = invoiceById.get(line.invoice_id);
    if (!document) continue;
    if (!validateSourceAmounts(amounts, 'invoice line', document.invoice_number)) {
      invalidLineIds.add(line.id);
      continue;
    }
    if (!Number.isSafeInteger(line.qty_micros) || (line.qty_micros < 0 && !document.reverses_invoice_id) || !Number.isSafeInteger(line.tax_rate_bps) || line.tax_rate_bps < 0) {
      invalidLineIds.add(line.id);
      sourceIssues.push({ severity: 'blocking_error', message: `Invoice line ${line.id} has invalid quantity or tax-rate data.`, documentNumber: document.invoice_number });
    }
  }
  for (const line of purchaseLines) {
    const amounts = [line.unit_cost_paise, line.discount_paise, line.taxable_paise, line.cgst_paise, line.sgst_paise, line.igst_paise, line.cess_paise, line.line_total_paise];
    const document = purchaseById.get(line.purchase_id);
    if (!document) continue;
    if (!validateSourceAmounts(amounts, 'purchase line', document.supplier_bill_number || document.bill_number)) {
      invalidLineIds.add(line.id);
      continue;
    }
    if (!Number.isSafeInteger(line.qty_micros) || (line.qty_micros < 0 && !document.reverses_purchase_id) || !Number.isSafeInteger(line.tax_rate_bps) || line.tax_rate_bps < 0) {
      invalidLineIds.add(line.id);
      sourceIssues.push({ severity: 'blocking_error', message: `Purchase line ${line.id} has invalid quantity or tax-rate data.`, documentNumber: document.supplier_bill_number || document.bill_number });
    }
  }
  const b2cInvoiceIds = new Set<string>();
  const classifiedInvoiceIds = new Set<string>();

  const gstr1B2b: GstrRow[] = [];
  const gstr1B2cl: GstrRow[] = [];
  const gstr1B2cs: GstrRow[] = [];
  const b2csByKey = new Map<string, GstrRow>();
  for (const invoice of activeInvoices) {
    const customer = customerById.get(invoice.customer_id);
    if (!customer) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Invoice customer record is missing; recipient category cannot be classified.', documentNumber: invoice.invoice_number });
      continue;
    }
    const gstin = customer?.gstin?.trim() ?? '';
    if (gstin && !isValidGstin(gstin)) {
      invalidGstinDocuments.add(invoice.invoice_number);
      continue;
    }
    const lines = linesByInvoice.get(invoice.id) ?? [];
    if (!validateSourceAmounts([invoice.subtotal_paise, invoice.discount_paise, invoice.taxable_paise, invoice.cgst_paise, invoice.sgst_paise, invoice.igst_paise, invoice.cess_paise, invoice.round_off_paise, invoice.pre_round_total_paise, invoice.total_paise], 'invoice', invoice.invoice_number)) continue;
    const registered = gstin !== '';
    const isB2cl = !registered && isB2cLarge(invoice);
    const target = registered ? gstr1B2b : isB2cl ? gstr1B2cl : gstr1B2cs;
    if (lines.some((line) => invalidLineIds.has(line.id))) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Invoice contains invalid line data; all lines are excluded from report totals.', documentNumber: invoice.invoice_number });
      continue;
    }
    if (!lines.length) continue;
    classifiedInvoiceIds.add(invoice.id);
    if (!registered) b2cInvoiceIds.add(invoice.id);
    for (const [lineIndex, line] of lines.entries()) {
      const base = {
        'Invoice Number': invoice.invoice_number,
        'Invoice date': invoice.invoice_date,
        // Rate-wise rows repeat an invoice. Carry its inclusive total only once.
        'Invoice Value': lineIndex === 0 ? invoice.total_paise : null,
        'Place Of Supply': invoice.place_of_supply,
        'Rate': rate(line.tax_rate_bps),
        'Taxable Value': line.taxable_paise,
        'Integrated Tax Amount': line.igst_paise,
        'Central Tax Amount': line.cgst_paise,
        'State/UT Tax Amount': line.sgst_paise,
        'Cess Amount': line.cess_paise,
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
        const row = b2csByKey.get(key) ?? { Type: 'OE', 'Place Of Supply': invoice.place_of_supply, 'Applicable % of Tax Rate': '', Rate: rate(line.tax_rate_bps), 'Taxable Value': 0, 'Integrated Tax Amount': 0, 'Central Tax Amount': 0, 'State/UT Tax Amount': 0, 'Cess Amount': 0, 'E-Commerce GSTIN': '' };
        row['Taxable Value'] = addPaise(paiseValue(row, 'Taxable Value'), line.taxable_paise);
        row['Integrated Tax Amount'] = addPaise(paiseValue(row, 'Integrated Tax Amount'), line.igst_paise);
        row['Central Tax Amount'] = addPaise(paiseValue(row, 'Central Tax Amount'), line.cgst_paise);
        row['State/UT Tax Amount'] = addPaise(paiseValue(row, 'State/UT Tax Amount'), line.sgst_paise);
        row['Cess Amount'] = addPaise(paiseValue(row, 'Cess Amount'), line.cess_paise);
        b2csByKey.set(key, row);
      }
    }
  }
  gstr1B2cs.push(...b2csByKey.values());
  const purchaseRegisterRows: GstrRow[] = [];
  const purchaseRegisterLineIds = new Set<string>();
  for (const purchase of activePurchases) {
    const supplier = supplierById.get(purchase.supplier_id);
    if (!supplier) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Purchase supplier record is missing; supplier category cannot be classified.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
      continue;
    }
    const supplierGstin = supplier.gstin?.trim() ?? '';
    if (supplierGstin && !isValidGstin(supplierGstin)) {
      invalidGstinDocuments.add(purchase.supplier_bill_number || purchase.bill_number);
      continue;
    }
    if (supplierGstin && !isValidStateCode(supplierGstin.slice(0, 2))) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Supplier GSTIN state code is invalid.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
      continue;
    }
    if (!validateSourceAmounts([purchase.subtotal_paise, purchase.discount_paise, purchase.taxable_paise, purchase.cgst_paise, purchase.sgst_paise, purchase.igst_paise, purchase.cess_paise, purchase.round_off_paise, purchase.pre_round_total_paise, purchase.total_paise], 'purchase', purchase.supplier_bill_number || purchase.bill_number)) continue;
    const purchaseAmounts = [purchase.subtotal_paise, purchase.discount_paise, purchase.taxable_paise, purchase.cgst_paise, purchase.sgst_paise, purchase.igst_paise, purchase.cess_paise, purchase.pre_round_total_paise, purchase.total_paise];
    if (purchaseAmounts.some((amount) => amount < 0) && !purchase.reverses_purchase_id) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Negative purchase values require a linked debit note or purchase reversal.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
      continue;
    }
    const purchaseLinesForReport = linesByPurchase.get(purchase.id) ?? [];
    if (purchaseLinesForReport.some((line) => invalidLineIds.has(line.id))) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Purchase contains invalid line data; all lines are excluded from report totals.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
      continue;
    }
    for (const [lineIndex, line] of purchaseLinesForReport.entries()) {
      purchaseRegisterLineIds.add(line.id);
      purchaseRegisterRows.push({
        'GSTIN/UIN of Supplier': supplier?.gstin ?? '', 'Supplier Name': supplier?.name ?? '', 'Bill Number': purchase.supplier_bill_number || purchase.bill_number,
        // Rate-wise rows repeat a bill. Carry its inclusive total only once.
        'Bill date': purchase.bill_date, 'Bill Value': lineIndex === 0 ? purchase.total_paise : null, 'Place Of Supply': purchase.supplier_state_code,
        'Reverse Charge': 'N', Rate: rate(line.tax_rate_bps), 'Taxable Value': line.taxable_paise,
        'Integrated Tax Amount': line.igst_paise, 'Central Tax Amount': line.cgst_paise, 'State/UT Tax Amount': line.sgst_paise, 'Cess Amount': line.cess_paise,
      });
    }
  }
  const cdnrB2b: GstrRow[] = activeSalesReturns.flatMap((note) => {
    const customer = customerById.get(note.customer_id);
    const original = invoiceById.get(note.original_invoice_id);
    if (!customer) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Credit-note customer record is missing; recipient category cannot be classified.', documentNumber: note.return_number });
      return [];
    }
    if (customer?.gstin && !isValidGstin(customer.gstin.trim())) {
      invalidGstinDocuments.add(note.return_number);
      return [];
    }
    if (!customer.gstin?.trim()) return [];
    if (!validateSourceAmounts([note.subtotal_paise, note.discount_paise, note.taxable_paise, note.cgst_paise, note.sgst_paise, note.igst_paise, note.cess_paise, note.round_off_paise, note.pre_round_total_paise, note.total_paise], 'sales note', note.return_number)) return [];
    if (!original) {
      sourceIssues.push({ severity: 'blocking_error', message: 'Credit note is missing place of supply and original invoice context; original supply details cannot be reported.', documentNumber: note.return_number });
      return [];
    }
    if (!customer?.gstin?.trim()) return [];
    const noteTaxPaise = sumPaise([note.cgst_paise, note.sgst_paise, note.igst_paise]);
    return [{
      'GSTIN/UIN of Recipient': customer.gstin,
      'Receiver Name': customer.name,
      'Note Number': note.return_number,
      'Note Date': note.return_date,
      'Note Type': 'C',
      'Place Of Supply': original?.place_of_supply ?? '',
      'Reverse Charge': 'N',
      'Note Supply Type': 'Regular',
        'Note Value': note.total_paise,
       'Applicable % of Tax Rate': '',
        Rate: note.taxable_paise ? rate(noteTaxPaise * 10000 / note.taxable_paise) : 0,
        'Taxable Value': note.taxable_paise,
        'Integrated Tax Amount': note.igst_paise,
        'Central Tax Amount': note.cgst_paise,
        'State/UT Tax Amount': note.sgst_paise,
        'Cess Amount': note.cess_paise,
        'Round Off Amount': note.round_off_paise,
     }];
  });
  const cdnurB2c: GstrRow[] = [];
  const b2csNoteWarnings: GstrValidationIssue[] = [];
  for (const note of activeSalesReturns) {
    const customer = customerById.get(note.customer_id);
    if (!customer) continue;
    if (customer?.gstin?.trim()) {
      if (!isValidGstin(customer.gstin.trim())) invalidGstinDocuments.add(note.return_number);
      continue;
    }
    if (!validateSourceAmounts([note.subtotal_paise, note.discount_paise, note.taxable_paise, note.cgst_paise, note.sgst_paise, note.igst_paise, note.cess_paise, note.round_off_paise, note.pre_round_total_paise, note.total_paise], 'sales note', note.return_number)) continue;
    const original = note.original_invoice_id ? invoiceById.get(note.original_invoice_id) : undefined;
    const placeOfSupply = original?.place_of_supply;
    if (!original) {
      b2csNoteWarnings.push({ severity: 'blocking_error', message: 'Credit note is missing place of supply and original invoice context; the note is excluded from classified totals.', documentNumber: note.return_number });
      continue;
    }
    const qualifiesB2cl = Boolean(original && isB2cLargeValue(note.return_date, note.total_paise, original.is_interstate === 1));
    const noteTaxPaise = sumPaise([note.cgst_paise, note.sgst_paise, note.igst_paise]);
    const rateValue = note.taxable_paise ? rate(Math.round(noteTaxPaise * 10000 / note.taxable_paise)) : 0;
    if (qualifiesB2cl && placeOfSupply) {
      cdnurB2c.push({ 'UR Type': 'B2CL', 'Note Number': note.return_number, 'Note Date': note.return_date, 'Note Type': 'C', 'Place Of Supply': placeOfSupply, 'Note Value': note.total_paise, 'Applicable % of Tax Rate': '', Rate: rateValue, 'Taxable Value': note.taxable_paise, 'Integrated Tax Amount': note.igst_paise, 'Central Tax Amount': note.cgst_paise, 'State/UT Tax Amount': note.sgst_paise, 'Cess Amount': note.cess_paise, 'Round Off Amount': note.round_off_paise });
      continue;
    }
    if (placeOfSupply && original) {
      const key = `${placeOfSupply}|${rateValue * 100}`;
      const row = b2csByKey.get(key) ?? { Type: 'OE', 'Place Of Supply': placeOfSupply, 'Applicable % of Tax Rate': '', Rate: rateValue, 'Taxable Value': 0, 'Integrated Tax Amount': 0, 'Central Tax Amount': 0, 'State/UT Tax Amount': 0, 'Cess Amount': 0, 'E-Commerce GSTIN': '' };
      row['Taxable Value'] = addPaise(paiseValue(row, 'Taxable Value'), -note.taxable_paise);
      row['Integrated Tax Amount'] = addPaise(paiseValue(row, 'Integrated Tax Amount'), -note.igst_paise);
      row['Central Tax Amount'] = addPaise(paiseValue(row, 'Central Tax Amount'), -note.cgst_paise);
      row['State/UT Tax Amount'] = addPaise(paiseValue(row, 'State/UT Tax Amount'), -note.sgst_paise);
      row['Cess Amount'] = addPaise(paiseValue(row, 'Cess Amount'), -note.cess_paise);
      b2csByKey.set(key, row);
      continue;
    }
    b2csNoteWarnings.push({ severity: 'warning', message: `Sales note ${note.return_number} is unclassified: missing ${placeOfSupply ? 'original supply classification' : 'place of supply'}${original ? '' : ' and original invoice context'}. No CDNUR or B2CS values were fabricated.`, documentNumber: note.return_number });
  }
  gstr1B2cs.length = 0;
  gstr1B2cs.push(...b2csByKey.values());
  const validationIssues: GstrValidationIssue[] = [];
  if (!business.gstin || !isValidGstin(business.gstin.trim())) {
    validationIssues.push({ severity: 'blocking_error', message: 'Business GSTIN is missing or invalid; this workpaper cannot be finalized.' });
  }
  if (business.gstin && isValidGstin(business.gstin.trim()) && !isValidStateCode(business.gstin.trim().slice(0, 2))) {
    validationIssues.push({ severity: 'blocking_error', message: 'Business GSTIN contains an invalid state code.' });
  }
  if (business.gstin && isValidGstin(business.gstin.trim()) && business.state_code && business.gstin.slice(0, 2) !== business.state_code) {
    validationIssues.push({ severity: 'blocking_error', message: 'Business GSTIN state code does not match the selected business state.' });
  }
  if (business.state_code && !isValidStateCode(business.state_code)) {
    validationIssues.push({ severity: 'blocking_error', message: 'Business state code is invalid.' });
  }
  for (const invoice of activeInvoices) {
    const customer = customerById.get(invoice.customer_id);
    if (!customer) continue;
    const recipientGstin = customer.gstin?.trim() ?? '';
    if (recipientGstin && !isValidGstin(recipientGstin)) {
      invalidGstinDocuments.add(invoice.invoice_number);
      continue;
    }
    if (recipientGstin && !isValidStateCode(recipientGstin.slice(0, 2))) {
      validationIssues.push({ severity: 'blocking_error', message: 'Recipient GSTIN state code is invalid.', documentNumber: invoice.invoice_number });
      continue;
    }
    const gstin = customer?.gstin?.trim() ?? '';
    if (gstin && !isValidGstin(gstin)) continue;
    if (invoice.is_interstate !== 0 && invoice.is_interstate !== 1) validationIssues.push({ severity: 'blocking_error', message: 'Invoice interstate flag is invalid.', documentNumber: invoice.invoice_number });
    checkDocumentInvariant(invoice, 'Invoice', invoice.invoice_number, validationIssues);
    if (gstin && !isValidStateCode(gstin.slice(0, 2))) validationIssues.push({ severity: 'blocking_error', message: 'Recipient GSTIN contains an invalid state code.', documentNumber: invoice.invoice_number });
    if (invoice.place_of_supply.trim() === '') {
      validationIssues.push({ severity: 'blocking_error', message: 'Missing place of supply.', documentNumber: invoice.invoice_number });
    }
    if (invoice.customer_state_code && !isValidStateCode(invoice.customer_state_code)) {
      validationIssues.push({ severity: 'blocking_error', message: 'Recipient state code is invalid.', documentNumber: invoice.invoice_number });
    }
    if (customer?.state_code && !isValidStateCode(customer.state_code)) {
      validationIssues.push({ severity: 'blocking_error', message: 'Customer profile state code is invalid.', documentNumber: invoice.invoice_number });
    }
    const placeState = /^\s*(\d{2})/.exec(invoice.place_of_supply)?.[1];
    if (placeState && !isValidStateCode(placeState)) {
      validationIssues.push({ severity: 'blocking_error', message: 'Place-of-supply state code is invalid.', documentNumber: invoice.invoice_number });
    }
    if (placeState && invoice.customer_state_code && placeState !== invoice.customer_state_code) {
      validationIssues.push({ severity: 'warning', message: 'Place of supply and stored customer state code differ.', documentNumber: invoice.invoice_number });
    }
    if (gstin && gstin.slice(0, 2) !== (customer?.state_code ?? invoice.customer_state_code)) {
      validationIssues.push({ severity: 'warning', message: 'Recipient GSTIN state code and selected customer state differ.', documentNumber: invoice.invoice_number });
    }
    const lineTaxable = (linesByInvoice.get(invoice.id) ?? []).filter((line) => !invalidLineIds.has(line.id)).reduce((sum, line) => addPaise(sum, line.taxable_paise), 0);
    if (linesByInvoice.has(invoice.id) && lineTaxable !== invoice.taxable_paise) {
      validationIssues.push({ severity: 'blocking_error', message: 'Invoice lines do not reconcile to the persisted invoice taxable amount.', documentNumber: invoice.invoice_number });
    }
  }
  for (const purchase of activePurchases) {
    const supplier = supplierById.get(purchase.supplier_id);
    const gstin = supplier?.gstin?.trim() ?? '';
    checkDocumentInvariant(purchase, 'Purchase', purchase.supplier_bill_number || purchase.bill_number, validationIssues);
    if (gstin && isValidGstin(gstin) && purchase.supplier_state_code && gstin.slice(0, 2) !== purchase.supplier_state_code) {
      validationIssues.push({ severity: 'warning', message: 'Supplier GSTIN state code and selected supplier state differ.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
    if (purchase.supplier_state_code && !isValidStateCode(purchase.supplier_state_code)) {
      validationIssues.push({ severity: 'blocking_error', message: 'Supplier state code is invalid.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
    if (purchase.is_interstate !== 0 && purchase.is_interstate !== 1) validationIssues.push({ severity: 'blocking_error', message: 'Purchase interstate flag is invalid.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    if (supplier?.gstin?.trim() && !isValidGstin(supplier.gstin.trim())) {
      validationIssues.push({ severity: 'blocking_error', message: 'Supplier has a non-empty invalid GSTIN; purchase is excluded from report totals.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
    if (supplier?.gstin?.trim() && isValidGstin(supplier.gstin.trim()) && !isValidStateCode(supplier.gstin.trim().slice(0, 2))) {
      validationIssues.push({ severity: 'blocking_error', message: 'Supplier GSTIN contains an invalid state code.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
    if (supplier?.state_code && !isValidStateCode(supplier.state_code)) {
      validationIssues.push({ severity: 'blocking_error', message: 'Supplier profile state code is invalid.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
    const lineTaxable = (linesByPurchase.get(purchase.id) ?? []).filter((line) => !invalidLineIds.has(line.id)).reduce((sum, line) => addPaise(sum, line.taxable_paise), 0);
    if (linesByPurchase.has(purchase.id) && lineTaxable !== purchase.taxable_paise) {
      validationIssues.push({ severity: 'blocking_error', message: 'Purchase lines do not reconcile to the persisted purchase taxable amount.', documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
  }
  for (const documentNumber of invalidGstinDocuments) {
    validationIssues.push({ severity: 'blocking_error', message: 'Non-empty GSTIN is invalid; source is UNCLASSIFIED_INVALID_GSTIN and excluded from report totals.', documentNumber });
  }
  const documentSeriesRows = [
    ...parseDocumentSeries(businessInvoices.filter((invoice) => invoice.status !== 'draft' && !invoice.deleted_at).map((invoice) => ({ number: invoice.invoice_number, cancelled: invoice.status === 'cancelled' })))
      .map((series) => ({ 'Nature of Document': 'Invoices for outward supply', series })),
    ...parseDocumentSeries(salesReturns.filter((note) => note.status === 'posted' || note.status === 'cancelled').map((note) => ({ number: note.return_number, cancelled: note.status === 'cancelled' })))
      .map((series) => ({ 'Nature of Document': 'Credit notes', series })),
    ...parseDocumentSeries(businessPurchases.filter((purchase) => purchase.status !== 'draft').map((purchase) => ({ number: purchase.supplier_bill_number || purchase.bill_number, cancelled: purchase.status === 'cancelled' })))
      .map((series) => ({ 'Nature of Document': 'Purchase bills and debit notes', series })),
  ].map(({ 'Nature of Document': nature, series }) => ({
    'Nature of Document': nature,
    Prefix: series.prefix,
    'Serial number from': series.from,
    'Serial number to': series.to,
    'Total documents issued': series.total,
    'Cancelled documents': series.cancelled,
    'Net documents issued': series.net,
    'Sequence gaps': series.gaps.join(', '),
    'Duplicate numbers': series.duplicates.join(', '),
  }));
  const reportData: GstrReport = {
    schema_name: 'BusinessVaultGSTWorkpaper',
    money_unit: 'paise',
    disclaimer: 'Internal BusinessVault workpaper; not GSTN upload JSON and not proof of filing.',
    report, schema_version: 1, generated_at: new Date().toISOString(), period: { from, to },
    status: 'INCOMPLETE',
    business: { gstin: business.gstin, legal_name: business.legal_name, trade_name: business.name },
    sections: report === 'gstr1' ? {
      Summary: { columns: ['Metric', 'Value'], rows: [] },
      B2B: { columns: GSTR1_COLUMNS.b2b, rows: gstr1B2b },
      'B2C Large': { columns: GSTR1_COLUMNS.b2cl, rows: gstr1B2cl },
      'B2C Other': { columns: GSTR1_COLUMNS.b2cs, rows: gstr1B2cs },
      'Credit Notes B2B': { columns: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Round Off Amount'], rows: cdnrB2b },
      'Credit Notes B2C': { columns: ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Round Off Amount'], rows: cdnurB2c },
      'HSN B2B': { columns: GSTR1_COLUMNS.hsn, rows: hsnRows([
        ...invoiceLines.filter((line) => !invalidLineIds.has(line.id) && classifiedInvoiceIds.has(line.invoice_id) && !b2cInvoiceIds.has(line.invoice_id)),
        ...hsnReturnLinesB2b,
      ], hsnReturnContextById, itemsById, unitsById) },
      'HSN B2C': { columns: GSTR1_COLUMNS.hsn, rows: hsnRows([
        ...invoiceLines.filter((line) => !invalidLineIds.has(line.id) && classifiedInvoiceIds.has(line.invoice_id) && b2cInvoiceIds.has(line.invoice_id)),
        ...hsnReturnLinesB2c,
      ], hsnReturnContextById, itemsById, unitsById) },
      'Documents Issued': { columns: ['Nature of Document', 'Prefix', 'Serial number from', 'Serial number to', 'Total documents issued', 'Cancelled documents', 'Net documents issued', 'Sequence gaps', 'Duplicate numbers'], rows: documentSeriesRows },
      Exceptions: { columns: ['Severity', 'Document Number', 'Issue'], rows: [] },
    } : {
      Summary: { columns: ['Metric', 'Value'], rows: [] },
      'Supplier Bills': { columns: PURCHASE_REGISTER_COLUMNS.b2b, rows: purchaseRegisterRows },
      'HSN Summary': { columns: PURCHASE_REGISTER_COLUMNS.hsn, rows: hsnRows(purchaseLines.filter((line) => !invalidLineIds.has(line.id) && purchaseRegisterLineIds.has(line.id)), purchaseById, itemsById, unitsById) },
      Exceptions: { columns: ['Severity', 'Document Number', 'Issue'], rows: [] },
    },
  };
  const reconciliationIssues: GstrValidationIssue[] = [...validationIssues];
  const unsupported = UNSUPPORTED_CATEGORIES.join(', ');
  reconciliationIssues.push({ severity: 'blocking_error', message: `Unsupported source categories are not included in this workpaper: ${unsupported}.` });
  reconciliationIssues.push({ severity: 'warning', message: 'Preceding-year turnover is not stored by the application; HSN validation accepts 4-, 6-, or 8-digit numeric codes and cannot select the filing-required minimum length automatically.' });
  for (const invoice of activeInvoices) {
    if (invalidGstinDocuments.has(invoice.invoice_number)) continue;
    if (!(linesByInvoice.get(invoice.id)?.length)) reconciliationIssues.push({ severity: 'blocking_error', message: 'Invoice has no invoice lines and was not exported.', documentNumber: invoice.invoice_number });
  }
  for (const purchase of activePurchases) {
    if (invalidGstinDocuments.has(purchase.supplier_bill_number || purchase.bill_number)) continue;
    if (!(linesByPurchase.get(purchase.id)?.length)) reconciliationIssues.push({ severity: 'blocking_error', message: 'Purchase has no purchase lines and was not exported.', documentNumber: purchase.bill_number });
  }
  for (const note of activeSalesReturns) {
    const customer = customerById.get(note.customer_id);
    if (customer?.gstin?.trim() && !isValidGstin(customer.gstin.trim())) {
      reconciliationIssues.push({ severity: 'blocking_error', message: 'Credit-note recipient has a non-empty invalid GSTIN; note is excluded from report totals.', documentNumber: note.return_number });
    }
    checkDocumentInvariant(note, 'Credit note', note.return_number, reconciliationIssues);
  }
  for (const invoice of activeInvoices) {
    const customer = customerById.get(invoice.customer_id);
    if (customer?.gstin && !isValidGstin(customer.gstin.trim())) continue;
    const lines = linesByInvoice.get(invoice.id) ?? [];
    for (const line of lines) if (!invalidLineIds.has(line.id) && !hsnLengthIsSupported(line.hsn)) reconciliationIssues.push({ severity: 'blocking_error', message: `HSN '${line.hsn}' is not a 4-, 6-, or 8-digit numeric code.`, documentNumber: invoice.invoice_number });
  }
  for (const purchase of activePurchases) {
    const supplier = supplierById.get(purchase.supplier_id);
    if (supplier?.gstin?.trim() && !isValidGstin(supplier.gstin.trim())) continue;
    for (const line of linesByPurchase.get(purchase.id) ?? []) {
      if (invalidLineIds.has(line.id)) continue;
       if (!hsnLengthIsSupported(line.hsn)) reconciliationIssues.push({ severity: 'blocking_error', message: `HSN '${line.hsn}' is not a 4-, 6-, or 8-digit numeric code.`, documentNumber: purchase.supplier_bill_number || purchase.bill_number });
    }
  }
  for (const note of activeSalesReturns) {
    for (const item of returnItemsByReturn.get(note.id) ?? []) {
      if (!hsnLengthIsSupported(item.hsn)) reconciliationIssues.push({ severity: 'blocking_error', message: `HSN '${item.hsn}' is not a 4-, 6-, or 8-digit numeric code.`, documentNumber: note.return_number });
    }
  }
  reconciliationIssues.push(...sourceIssues);
  for (const series of reportData.sections['Documents Issued']?.rows ?? []) {
    if (String(series['Duplicate numbers'] ?? '')) reconciliationIssues.push({ severity: 'blocking_error', message: `Duplicate document number in series ${String(series.Prefix ?? '')}: ${String(series['Duplicate numbers'])}` });
    if (String(series['Sequence gaps'] ?? '')) reconciliationIssues.push({ severity: 'warning', message: `Document sequence gap in series ${String(series.Prefix ?? '')}: ${String(series['Sequence gaps'])}` });
  }
  reconciliationIssues.push(...b2csNoteWarnings);
  const exceptions = reconciliationIssues.map((issue) => ({
    Severity: issue.severity,
    'Document Number': issue.documentNumber ?? '',
    Issue: issue.message,
  }));
  reportData.sections.Exceptions.rows = exceptions;
  reportData.reconciliationIssues = reconciliationIssues;
  log.info('gstrExport', 'report built', { businessId, report, from, to, sectionCount: Object.keys(reportData.sections).length, activeInvoiceCount: activeInvoices.length, activePurchaseCount: activePurchases.length });
  return reportData;
}

export async function downloadGstrJson(data: GstrReport): Promise<void> {
  const output = {
    ...data,
    money_unit: 'INR decimal rupees' as const,
    report_format: 'BusinessVault internal JSON export' as const,
    sections: Object.fromEntries(Object.entries(data.sections).map(([name, section]) => [name, { ...section, rows: rupeeRows(section.rows) }])),
  };
  triggerDownload(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json;charset=utf-8' }), reportFilename(data, 'json'));
  log.info('gstrExport', 'JSON downloaded', { report: data.report, sectionCount: Object.keys(data.sections).length });
}

export async function downloadGstrCsv(data: GstrReport): Promise<void> {
  const rows = Object.entries(data.sections).flatMap(([section, value]) => rupeeRows(value.rows).map((row) => ({ section, ...row })));
  const columns = ['section', ...Array.from(new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== 'section'))))];
  await streamCsvToBlob({ columns, rows, toRow: (row) => row }, { bom: true }).then((blob) => triggerDownload(blob, reportFilename(data, 'csv')));
  log.info('gstrExport', 'CSV downloaded', { report: data.report, rowCount: rows.length });
}

function excelRows(section: GstrSection): Array<Record<string, string | number | Date | null>> {
  return rupeeRows(section.rows).map((row) => {
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
    ? [report.sections.B2B, report.sections['B2C Large'], report.sections['B2C Other']]
    : [report.sections['Supplier Bills']];
  return sections.flatMap((section) => (section?.rows ?? []).map((row) => {
    const formatted = rupeeRows([row])[0];
    const taxable = Number(formatted['Taxable Value'] ?? formatted['Taxable value'] ?? 0);
    const integrated = Number(formatted['Integrated Tax Amount'] ?? 0);
    const central = Number(formatted['Central Tax Amount'] ?? 0);
    const state = Number(formatted['State/UT Tax Amount'] ?? 0);
    const cess = Number(formatted['Cess Amount'] ?? 0);
    const rateValue = Number(row.Rate ?? 0);
    const invoiceValue = typeof formatted['Invoice Value'] === 'number'
      ? formatted['Invoice Value']
      : typeof formatted['Bill Value'] === 'number' ? formatted['Bill Value'] : null;
    const dateValue = report.report === 'gstr1' ? row['Invoice date'] : row['Bill date'];
    const result: Record<string, string | number | Date | null> = {
      'GSTIN/UIN': (report.report === 'gstr1' ? row['GSTIN/UIN of Recipient'] : row['GSTIN/UIN of Supplier']) ?? null,
      'Party Name': (report.report === 'gstr1' ? row['Receiver Name'] : row['Supplier Name']) ?? null,
      'Transaction Type': report.report === 'gstr1' ? row['Invoice Type'] ?? row.Type ?? 'Outward supply' : 'Purchase Register',
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

function sectionSummary(section: GstrSection, from: string, to: string): Array<[string, string | number | null]> {
  const total = (...keys: string[]): number => moneyValue(section.rows.reduce((sum, row) => {
    for (const key of keys) sum = addPaise(sum, paiseValue(row, key));
    return sum;
  }, 0));
  return [
    ['Period', `${from} to ${to}`],
    ['Rows', section.rows.length],
    ['Taxable Value', total('Taxable Value', 'Taxable value')],
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
  if (!data.business.gstin || !isValidGstin(data.business.gstin.trim())) {
    issues.push({ severity: 'blocking_error', message: 'Business GSTIN is missing or invalid; the workpaper remains incomplete.' });
  }
  const b2bGstins = new Set(main
    .filter((row) => typeof row['GSTIN/UIN'] === 'string' && isValidGstin(row['GSTIN/UIN'] as string))
    .map((row) => row['GSTIN/UIN'] as string));
  if (report === 'gstr1') issues.push({ severity: 'information', message: `Distinct valid B2B recipient GSTINs: ${b2bGstins.size}.` });

  const mainTitle = report === 'gstr1'
    ? 'GSTR-1 Preparation Workpaper (Incomplete)'
    : 'Purchase Register (Internal Workpaper; not GSTR-2B)';
  const sectionNames = report === 'gstr1' ? GSTR1_SHEET_ORDER : PURCHASE_REGISTER_SHEET_ORDER;
  for (const name of sectionNames) {
    if (name === 'Summary') {
      const summarySections = report === 'gstr1'
        ? ['B2B', 'B2C Large', 'B2C Other', 'Credit Notes B2B', 'Credit Notes B2C']
        : ['Supplier Bills'];
      const totals = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
      for (const sectionName of summarySections) {
        const sign = sectionName.startsWith('Credit Notes') ? -1 : 1;
        for (const row of data.sections[sectionName]?.rows ?? []) {
          totals.taxable = addPaise(totals.taxable, sign * paiseValue(row, 'Taxable Value', 'Taxable value'));
          totals.igst = addPaise(totals.igst, sign * paiseValue(row, 'Integrated Tax Amount'));
          totals.cgst = addPaise(totals.cgst, sign * paiseValue(row, 'Central Tax Amount'));
          totals.sgst = addPaise(totals.sgst, sign * paiseValue(row, 'State/UT Tax Amount'));
          totals.cess = addPaise(totals.cess, sign * paiseValue(row, 'Cess Amount'));
        }
      }
      const summary: Array<[string, string | number | null]> = [
        ['Business', data.business.trade_name], ['GSTIN', data.business.gstin],
        ['Period', `${from} to ${to}`], ['Status', 'INCOMPLETE WORKPAPER'],
        ['Not proof of filing', 'Review before filing'], ['Total Taxable Value', moneyValue(totals.taxable)],
        ['Integrated Tax', moneyValue(totals.igst)], ['Central Tax', moneyValue(totals.cgst)],
        ['State/UT Tax', moneyValue(totals.sgst)], ['Cess', moneyValue(totals.cess)],
        ['Round-off treatment', 'Persisted document round-off is included in invoice/note value only; taxable value and tax heads are unchanged.'],
        ['Blocking Issues', issues.filter((issue) => issue.severity === 'blocking_error').length],
      ];
      makeWorkbookSheet(workbook, name, mainTitle, summary, ['GSTIN/UIN', 'Party Name', 'Transaction Type', 'Invoice No.', 'Invoice Date', 'Invoice Value', 'Rate', 'Cess Rate', 'Taxable value', 'Reverse Charge', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Place of Supply(Name of state)'], main);
      continue;
    }
      const section = data.sections[name];
      if (section) {
      const caption = name === 'Exceptions' ? 'Validation Issues' : name;
      makeWorkbookSheet(workbook, name, caption, sectionSummary(section, from, to), section.columns, excelRows(section));
    }
  }
  for (const section of Object.values(data.sections)) {
    for (const row of section.rows) {
      const gstin = text(row['GSTIN/UIN of Recipient'] ?? row['GSTIN/UIN of Supplier']);
      if (gstin && !isValidGstin(gstin)) issues.push({ severity: 'blocking_error', message: `Party GSTIN failed checksum validation: ${gstin}` });
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = reportFilename(data, 'xlsx');
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
