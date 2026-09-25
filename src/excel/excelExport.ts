import ExcelJS from 'exceljs';
import { db as defaultDb } from '../db';
import type { BusinessVaultDB } from '../db/database';
import type {
  Account,
  Business,
  Customer,
  Expense,
  Invoice,
  InvoiceLine,
  Item,
  ItemStock,
  Payment,
  Purchase,
  Advance,
  SalesReturn,
  Supplier,
} from '../db/types';
import { fromMoney, type Money } from '../domain/money';
import {
  balanceSheet,
  profitAndLoss,
  trialBalance,
} from '../domain/AccountingService';
import {
  computePayables,
  computeReceivables,
  isActivePurchase,
} from '../domain/partyLedger';

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function safeCell(v: unknown): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = typeof v === 'string' ? v : String(v);
  if (s.length === 0) return '';
  if (FORMULA_PREFIXES.includes(s.charAt(0))) return "'" + s;
  return s;
}

function rupees(paise: number | null | undefined): number {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return 0;
  return Number((paise / 100).toFixed(2));
}

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): void {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(12, Math.min(40, c.length + 4)) }));
  for (const row of rows) {
    const sanitized: Record<string, unknown> = {};
    for (const col of columns) sanitized[col] = safeCell(row[col]);
    ws.addRow(sanitized);
  }
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

export interface ExcelExportOptions {
  db?: BusinessVaultDB;
  asOf?: Date;
  fromDate?: Date;
  toDate?: Date;
}

export interface ExcelExportResult {
  blob: Blob;
  filename: string;
}

export async function buildBusinessExcelExport(
  businessId: string,
  opts: ExcelExportOptions = {},
): Promise<ExcelExportResult> {
  const db = opts.db ?? (defaultDb as unknown as BusinessVaultDB);
  const asOf = opts.asOf ?? new Date();
  const fromDate =
    opts.fromDate ?? new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
  const toDate = opts.toDate ?? asOf;

  const business = await db.businesses.get(businessId);
  const customers = await db.customers.where('business_id').equals(businessId).toArray();
  const suppliers = await db.suppliers.where('business_id').equals(businessId).toArray();
  const items = await db.items.where('business_id').equals(businessId).toArray();
  const stocks = await db.item_stock.where('business_id').equals(businessId).toArray();
  const invoices = await db.invoices.where('business_id').equals(businessId).toArray();
  const invoiceLines = await db.invoice_lines.where('business_id').equals(businessId).toArray();
  const purchases = await db.purchases.where('business_id').equals(businessId).toArray();
  const payments = await db.payments.where('business_id').equals(businessId).toArray();
  const advances = await db.advances.where('business_id').equals(businessId).toArray();
  const salesReturns = await db.sales_returns.where('business_id').equals(businessId).toArray();
  const expenses = await db.expenses.where('business_id').equals(businessId).toArray();
  const accounts = await db.accounts.where('business_id').equals(businessId).toArray();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BusinessVault';
  wb.created = new Date();

  buildDashboardSheet(wb, business, invoices, purchases, payments, advances, salesReturns, customers, suppliers, expenses, asOf);
  buildCustomersSheet(wb, customers);
  buildSuppliersSheet(wb, suppliers);
  buildItemsSheet(wb, items);
  buildInventorySheet(wb, items, stocks);
  buildInvoicesSheet(wb, invoices);
  buildInvoiceItemsSheet(wb, invoiceLines, items);
  buildPurchasesSheet(wb, purchases);
  buildPaymentsSheet(wb, payments);
  buildExpensesSheet(wb, expenses, accounts);
  buildReceivablesSheet(wb, invoices, customers, advances, salesReturns, asOf);
  buildPayablesSheet(wb, purchases, suppliers, advances, asOf);

  const pl = await profitAndLoss(businessId, fromDate, toDate, { db });
  buildProfitLossSheet(wb, pl);

  const bs = await balanceSheet(businessId, asOf, { db, financialYearStart: fromDate });
  buildBalanceSheetSheet(wb, bs);

  buildGstSummarySheet(wb, invoices, invoiceLines, items);

  const trial = await trialBalance(businessId, asOf, { db });
  buildTrialBalanceSheet(wb, trial);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const filename = `Business-Export-${toDateString(asOf)}.xlsx`;
  return { blob, filename };
}

function buildDashboardSheet(
  wb: ExcelJS.Workbook,
  business: Business | undefined,
  invoices: Invoice[],
  purchases: Purchase[],
  payments: Payment[],
  advances: Advance[],
  salesReturns: SalesReturn[],
  customers: Customer[],
  suppliers: Supplier[],
  expenses: Expense[],
  asOf: Date,
): void {
  const totalSales = invoices
    .filter((i) => i.status !== 'cancelled' && i.status !== 'draft' && !i.deleted_at && !i.reverses_invoice_id && !i.reversed_by_invoice_id)
    .reduce((s, i) => s + (i.total_paise || 0), 0);
  const totalPurchases = purchases
    .filter((p) => isActivePurchase(p))
    .reduce((s, p) => s + (p.total_paise || 0), 0);
  const totalReceived = payments
    .filter((p) => p.direction === 'in')
    .reduce((s, p) => s + p.amount_paise, 0);
  const totalPaid = payments
    .filter((p) => p.direction === 'out')
    .reduce((s, p) => s + p.amount_paise, 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.total_paise || 0), 0);
  const outstandingReceivable = computeReceivables(invoices, toDateString(asOf), advances, customers, salesReturns).totals.outstanding_paise;
  const outstandingPayable = computePayables(purchases, toDateString(asOf), advances, suppliers).totals.outstanding_paise;

  const rows: Array<Record<string, unknown>> = [
    { Metric: 'Business', Value: business?.name ?? '' },
    { Metric: 'Legal Name', Value: business?.legal_name ?? '' },
    { Metric: 'GSTIN', Value: business?.gstin ?? '' },
    { Metric: 'Financial Year', Value: business?.current_financial_year ?? '' },
    { Metric: 'Export Date', Value: toDateString(asOf) },
    { Metric: 'Total Sales', Value: rupees(totalSales) },
    { Metric: 'Total Purchases', Value: rupees(totalPurchases) },
    { Metric: 'Total Received (In)', Value: rupees(totalReceived) },
    { Metric: 'Total Paid (Out)', Value: rupees(totalPaid) },
    { Metric: 'Total Expenses', Value: rupees(totalExpenses) },
    { Metric: 'Outstanding Receivable', Value: rupees(outstandingReceivable) },
    { Metric: 'Outstanding Payable', Value: rupees(outstandingPayable) },
    { Metric: 'Invoice Count', Value: invoices.length },
    { Metric: 'Purchase Count', Value: purchases.length },
    { Metric: 'Payment Count', Value: payments.length },
    { Metric: 'Expense Count', Value: expenses.length },
  ];
  addSheet(wb, 'Dashboard', ['Metric', 'Value'], rows);
}

function buildCustomersSheet(wb: ExcelJS.Workbook, customers: Customer[]): void {
  const cols = ['id', 'name', 'phone', 'email', 'gstin', 'state', 'state_code', 'opening_balance', 'credit_limit', 'active'];
  const rows = customers.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    gstin: c.gstin ?? '',
    state: c.state,
    state_code: c.state_code,
    opening_balance: rupees(c.opening_balance_paise),
    credit_limit: rupees(c.credit_limit_paise),
    active: c.active ? 'Yes' : 'No',
  }));
  addSheet(wb, 'Customers', cols, rows);
}

function buildSuppliersSheet(wb: ExcelJS.Workbook, suppliers: Supplier[]): void {
  const cols = ['id', 'name', 'phone', 'email', 'gstin', 'state', 'state_code', 'opening_balance', 'active'];
  const rows = suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    email: s.email,
    gstin: s.gstin ?? '',
    state: s.state,
    state_code: s.state_code,
    opening_balance: rupees(s.opening_balance_paise),
    active: s.active ? 'Yes' : 'No',
  }));
  addSheet(wb, 'Suppliers', cols, rows);
}

function buildItemsSheet(wb: ExcelJS.Workbook, items: Item[]): void {
  const cols = ['id', 'sku', 'name', 'hsn', 'sale_price', 'purchase_price', 'tax_rate_pct', 'is_service', 'track_inventory', 'active'];
  const rows = items.map((i) => ({
    id: i.id,
    sku: i.sku,
    name: i.name,
    hsn: i.hsn,
    sale_price: rupees(i.sale_price_paise),
    purchase_price: rupees(i.purchase_price_paise),
    tax_rate_pct: i.tax_rate_bps / 100,
    is_service: i.is_service ? 'Yes' : 'No',
    track_inventory: i.track_inventory ? 'Yes' : 'No',
    active: i.active ? 'Yes' : 'No',
  }));
  addSheet(wb, 'Items', cols, rows);
}

function buildInventorySheet(wb: ExcelJS.Workbook, items: Item[], stocks: ItemStock[]): void {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const cols = ['item_id', 'item_name', 'sku', 'warehouse_id', 'quantity', 'avg_cost', 'value'];
  const rows = stocks.map((s) => {
    const it = itemById.get(s.item_id);
    const qty = s.qty_micros / 1_000_000;
    return {
      item_id: s.item_id,
      item_name: it?.name ?? '',
      sku: it?.sku ?? '',
      warehouse_id: s.warehouse_id,
      quantity: qty,
      avg_cost: rupees(s.avg_cost_paise),
      value: Number(((s.qty_micros * s.avg_cost_paise) / (1_000_000 * 100)).toFixed(2)),
    };
  });
  addSheet(wb, 'Inventory', cols, rows);
}

function buildInvoicesSheet(wb: ExcelJS.Workbook, invoices: Invoice[]): void {
  const cols = ['invoice_number', 'invoice_date', 'due_date', 'customer_id', 'place_of_supply', 'is_interstate',
    'subtotal', 'discount', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'round_off', 'total', 'paid', 'balance', 'status'];
  const rows = invoices.map((i) => ({
    invoice_number: i.invoice_number,
    invoice_date: i.invoice_date,
    due_date: i.due_date ?? '',
    customer_id: i.customer_id,
    place_of_supply: i.place_of_supply,
    is_interstate: i.is_interstate ? 'Yes' : 'No',
    subtotal: rupees(i.subtotal_paise),
    discount: rupees(i.discount_paise),
    taxable: rupees(i.taxable_paise),
    cgst: rupees(i.cgst_paise),
    sgst: rupees(i.sgst_paise),
    igst: rupees(i.igst_paise),
    cess: rupees(i.cess_paise),
    round_off: rupees(i.round_off_paise),
    total: rupees(i.total_paise),
    paid: rupees(i.paid_paise),
    balance: rupees(i.balance_paise),
    status: i.status,
  }));
  addSheet(wb, 'Invoices', cols, rows);
}

function buildInvoiceItemsSheet(wb: ExcelJS.Workbook, lines: InvoiceLine[], items: Item[]): void {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const cols = ['invoice_id', 'line_no', 'item_id', 'item_name', 'hsn', 'quantity', 'unit_price',
    'discount', 'taxable', 'tax_rate_pct', 'cgst', 'sgst', 'igst', 'cess', 'line_total'];
  const rows = lines.map((l) => ({
    invoice_id: l.invoice_id,
    line_no: l.line_no,
    item_id: l.item_id,
    item_name: itemById.get(l.item_id)?.name ?? l.description,
    hsn: l.hsn,
    quantity: l.qty_micros / 1_000_000,
    unit_price: rupees(l.unit_price_paise),
    discount: rupees(l.discount_paise),
    taxable: rupees(l.taxable_paise),
    tax_rate_pct: l.tax_rate_bps / 100,
    cgst: rupees(l.cgst_paise),
    sgst: rupees(l.sgst_paise),
    igst: rupees(l.igst_paise),
    cess: rupees(l.cess_paise),
    line_total: rupees(l.line_total_paise),
  }));
  addSheet(wb, 'Invoice Items', cols, rows);
}

function buildPurchasesSheet(wb: ExcelJS.Workbook, purchases: Purchase[]): void {
  const cols = ['bill_number', 'supplier_bill_number', 'bill_date', 'due_date', 'supplier_id',
    'is_interstate', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'total', 'paid', 'balance', 'status'];
  const rows = purchases.map((p) => ({
    bill_number: p.bill_number,
    supplier_bill_number: p.supplier_bill_number,
    bill_date: p.bill_date,
    due_date: p.due_date ?? '',
    supplier_id: p.supplier_id,
    is_interstate: p.is_interstate ? 'Yes' : 'No',
    taxable: rupees(p.taxable_paise),
    cgst: rupees(p.cgst_paise),
    sgst: rupees(p.sgst_paise),
    igst: rupees(p.igst_paise),
    cess: rupees(p.cess_paise),
    total: rupees(p.total_paise),
    paid: rupees(p.paid_paise),
    balance: rupees(p.balance_paise),
    status: p.status,
  }));
  addSheet(wb, 'Purchases', cols, rows);
}

function buildPaymentsSheet(wb: ExcelJS.Workbook, payments: Payment[]): void {
  const cols = ['payment_number', 'payment_date', 'direction', 'party_type', 'party_id',
    'method', 'account_id', 'amount', 'reference'];
  const rows = payments.map((p) => ({
    payment_number: p.payment_number,
    payment_date: p.payment_date,
    direction: p.direction,
    party_type: p.party_type,
    party_id: p.party_id,
    method: p.method,
    account_id: p.account_id,
    amount: rupees(p.amount_paise),
    reference: p.reference,
  }));
  addSheet(wb, 'Payments', cols, rows);
}

function buildExpensesSheet(wb: ExcelJS.Workbook, expenses: Expense[], accounts: Account[]): void {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const cols = ['expense_number', 'expense_date', 'category', 'supplier_id',
    'description', 'amount', 'tax', 'total'];
  const rows = expenses.map((e) => ({
    expense_number: e.expense_number,
    expense_date: e.expense_date,
    category: acctById.get(e.category_account_id)?.name ?? e.category_account_id,
    supplier_id: e.supplier_id ?? '',
    description: e.description,
    amount: rupees(e.amount_paise),
    tax: rupees(e.tax_paise),
    total: rupees(e.total_paise),
  }));
  addSheet(wb, 'Expenses', cols, rows);
}

function buildReceivablesSheet(wb: ExcelJS.Workbook, invoices: Invoice[], customers: Customer[], advances: Advance[], salesReturns: SalesReturn[], asOf: Date): void {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const derived = computeReceivables(invoices, toDateString(asOf), advances, customers, salesReturns);
  const cols = ['invoice_number', 'invoice_date', 'due_date', 'customer_name', 'total', 'paid', 'balance', 'status'];
  const rows = derived.perInvoice
    .filter((r) => r.outstanding_paise > 0)
    .map((r) => ({
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      due_date: r.due_date ?? '',
      customer_name: custById.get(r.customer_id)?.name ?? r.customer_id,
      total: rupees(r.grand_total_paise),
      paid: rupees(r.paid_paise),
      balance: rupees(r.outstanding_paise),
      status: 'active',
    }));
  addSheet(wb, 'Receivables', cols, rows);
}

function buildPayablesSheet(wb: ExcelJS.Workbook, purchases: Purchase[], suppliers: Supplier[], advances: Advance[], asOf: Date): void {
  const suppById = new Map(suppliers.map((s) => [s.id, s]));
  const derived = computePayables(purchases, toDateString(asOf), advances, suppliers);
  const cols = ['bill_number', 'bill_date', 'due_date', 'supplier_name', 'total', 'paid', 'balance', 'status'];
  const rows = derived.perPurchase
    .filter((r) => r.outstanding_paise > 0)
    .map((r) => ({
      bill_number: r.bill_number,
      bill_date: r.bill_date,
      due_date: r.due_date ?? '',
      supplier_name: suppById.get(r.supplier_id)?.name ?? r.supplier_id,
      total: rupees(r.grand_total_paise),
      paid: rupees(r.paid_paise),
      balance: rupees(r.outstanding_paise),
      status: 'active',
    }));
  addSheet(wb, 'Payables', cols, rows);
}

function buildProfitLossSheet(
  wb: ExcelJS.Workbook,
  pl: Awaited<ReturnType<typeof profitAndLoss>>,
): void {
  const rows: Array<Record<string, unknown>> = [];
  rows.push({ Section: 'Period', Account: `${pl.from} to ${pl.to}`, Amount: '' });
  rows.push({ Section: 'Revenue', Account: '', Amount: '' });
  for (const a of pl.by_account.filter((x) => x.type === 'income')) {
    rows.push({ Section: '', Account: `  ${a.code} ${a.name}`, Amount: rupees(a.amount_paise) });
  }
  rows.push({ Section: 'Total Revenue', Account: '', Amount: rupees(pl.revenue_paise + pl.other_income_paise) });
  rows.push({ Section: 'COGS', Account: '', Amount: rupees(pl.cogs_paise) });
  rows.push({ Section: 'Gross Profit', Account: '', Amount: rupees(pl.gross_profit_paise) });
  rows.push({ Section: 'Operating Expenses', Account: '', Amount: '' });
  for (const a of pl.by_account.filter((x) => x.type === 'expense')) {
    rows.push({ Section: '', Account: `  ${a.code} ${a.name}`, Amount: rupees(a.amount_paise) });
  }
  rows.push({ Section: 'Total Operating Expenses', Account: '', Amount: rupees(pl.operating_expenses_paise) });
  rows.push({ Section: 'Net Income', Account: '', Amount: rupees(pl.net_income_paise) });
  addSheet(wb, 'Profit & Loss', ['Section', 'Account', 'Amount'], rows);
}

function buildBalanceSheetSheet(
  wb: ExcelJS.Workbook,
  bs: Awaited<ReturnType<typeof balanceSheet>>,
): void {
  const rows: Array<Record<string, unknown>> = [];
  rows.push({ Section: 'As Of', Account: bs.as_of, Amount: '' });
  rows.push({ Section: 'ASSETS', Account: '', Amount: '' });
  for (const a of bs.assets.by_account) {
    rows.push({ Section: '', Account: `  ${a.code} ${a.name}`, Amount: rupees(a.balance_paise) });
  }
  rows.push({ Section: 'Total Assets', Account: '', Amount: rupees(bs.assets.total_paise) });
  rows.push({ Section: 'LIABILITIES', Account: '', Amount: '' });
  for (const a of bs.liabilities.by_account) {
    rows.push({ Section: '', Account: `  ${a.code} ${a.name}`, Amount: rupees(a.balance_paise) });
  }
  rows.push({ Section: 'Total Liabilities', Account: '', Amount: rupees(bs.liabilities.total_paise) });
  rows.push({ Section: 'EQUITY', Account: '', Amount: '' });
  for (const a of bs.equity.by_account) {
    rows.push({ Section: '', Account: `  ${a.code} ${a.name}`, Amount: rupees(a.balance_paise) });
  }
  rows.push({ Section: 'Total Equity', Account: '', Amount: rupees(bs.equity.total_paise) });
  rows.push({ Section: 'Balanced', Account: bs.balanced ? 'Yes' : 'No', Amount: rupees(bs.difference_paise) });
  addSheet(wb, 'Balance Sheet', ['Section', 'Account', 'Amount'], rows);
}

function buildGstSummarySheet(
  wb: ExcelJS.Workbook,
  invoices: Invoice[],
  lines: InvoiceLine[],
  items: Item[],
): void {
  type Slab = { rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; count: number };
  const bySlab = new Map<number, Slab>();
  const itemById = new Map(items.map((i) => [i.id, i]));

  const invById = new Map(invoices.map((i) => [i.id, i]));

  for (const line of lines) {
    const inv = invById.get(line.invoice_id);
    if (
      !inv ||
      inv.status === 'cancelled' ||
      inv.status === 'draft' ||
      inv.deleted_at
    ) continue;
    const rate = line.tax_rate_bps > 0 ? line.tax_rate_bps : (itemById.get(line.item_id)?.tax_rate_bps ?? 0);
    const s = bySlab.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, count: 0 };
    s.taxable += line.taxable_paise;
    s.cgst += line.cgst_paise;
    s.sgst += line.sgst_paise;
    s.igst += line.igst_paise;
    s.cess += line.cess_paise;
    s.count += 1;
    bySlab.set(rate, s);
  }

  const cols = ['tax_rate_pct', 'line_count', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'total_tax'];
  const rows: Array<Record<string, unknown>> = [];
  const slabs = Array.from(bySlab.values()).sort((a, b) => a.rate - b.rate);
  let totTaxable = 0;
  let totCgst = 0;
  let totSgst = 0;
  let totIgst = 0;
  let totCess = 0;
  for (const s of slabs) {
    rows.push({
      tax_rate_pct: s.rate / 100,
      line_count: s.count,
      taxable: rupees(s.taxable),
      cgst: rupees(s.cgst),
      sgst: rupees(s.sgst),
      igst: rupees(s.igst),
      cess: rupees(s.cess),
      total_tax: rupees(s.cgst + s.sgst + s.igst + s.cess),
    });
    totTaxable += s.taxable;
    totCgst += s.cgst;
    totSgst += s.sgst;
    totIgst += s.igst;
    totCess += s.cess;
  }
  rows.push({
    tax_rate_pct: 'TOTAL',
    line_count: lines.length,
    taxable: rupees(totTaxable),
    cgst: rupees(totCgst),
    sgst: rupees(totSgst),
    igst: rupees(totIgst),
    cess: rupees(totCess),
    total_tax: rupees(totCgst + totSgst + totIgst + totCess),
  });
  addSheet(wb, 'GST Summary', cols, rows);
}

function buildTrialBalanceSheet(
  wb: ExcelJS.Workbook,
  rows: Awaited<ReturnType<typeof trialBalance>>,
): void {
  const cols = ['code', 'name', 'type', 'debits', 'credits', 'balance'];
  const out = rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: r.type,
    debits: rupees(r.debits_paise),
    credits: rupees(r.credits_paise),
    balance: rupees(r.balance_paise),
  }));
  addSheet(wb, 'Trial Balance', cols, out);
}

function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatPaise(paise: number): string {
  return fromMoney(paise as Money);
}
