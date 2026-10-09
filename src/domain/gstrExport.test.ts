import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { BusinessVaultDB } from '../db/database';
import ExcelJS from 'exceljs';
import type { Business, Customer, Item, Invoice, InvoiceLine, Purchase, PurchaseLine, SalesReturn, SalesReturnItem, Supplier, Unit } from '../db/types';
import { computeGstinCheckChar } from '../lib/gst';
import { addPaise, buildGstrExcel, buildGstrReport, GSTR1_SHEET_ORDER, PURCHASE_REGISTER_SHEET_ORDER, hsnRequiredLengthForTurnover, isB2cLargeValue, isHsnLengthSupported, parseDocumentSeries, sumPaise } from './gstrExport';

const now = '2026-08-31T00:00:00.000Z';
const businessId = 'gstr-business';
const gstin = (first14 = '08AAAAA0000A1Z'): string => `${first14}${computeGstinCheckChar(first14)}`;

function invoice(id: string, customerId: string, number: string, totalPaise: number, interstate: number): Invoice {
  const taxable = Math.round(totalPaise / 1.18);
  const tax = totalPaise - taxable;
  return { id, business_id: businessId, invoice_number: number, invoice_date: '2026-08-10', due_date: null, customer_id: customerId, customer_state_code: interstate ? '09' : '08', place_of_supply: interstate ? '09-Uttar Pradesh' : '08-Rajasthan', is_interstate: interstate, financial_year: '2026-27', subtotal_paise: taxable, discount_paise: 0, taxable_paise: taxable, cgst_paise: interstate ? 0 : Math.floor(tax / 2), sgst_paise: interstate ? 0 : tax - Math.floor(tax / 2), igst_paise: interstate ? tax : 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: totalPaise, total_paise: totalPaise, paid_paise: 0, balance_paise: totalPaise, status: 'issued', reversed_by_invoice_id: null, reverses_invoice_id: null, notes: '', terms: '', pdf_attachment_id: null, journal_entry_id: `je-${id}`, created_at: now, updated_at: now, entity_version: 1 };
}

function invoiceLine(id: string, invoiceId: string, taxablePaise: number, taxRateBps = 1800): InvoiceLine {
  const tax = Math.round(taxablePaise * taxRateBps / 10000);
  return { id, business_id: businessId, invoice_id: invoiceId, line_no: 1, item_id: 'item', description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_price_paise: taxablePaise, discount_pct_bps: 0, discount_paise: 0, taxable_paise: taxablePaise, tax_rate_bps: taxRateBps, cgst_paise: Math.floor(tax / 2), sgst_paise: tax - Math.floor(tax / 2), igst_paise: 0, cess_paise: 0, line_total_paise: taxablePaise + tax };
}

function salesReturn(id: string, number: string, customerId: string, originalInvoiceId: string, taxablePaise: number): SalesReturn {
  const tax = Math.round(taxablePaise * 1800 / 10000);
  return { id, business_id: businessId, return_number: number, return_date: '2026-08-20', original_invoice_id: originalInvoiceId, customer_id: customerId, subtotal_paise: taxablePaise, discount_paise: 0, taxable_paise: taxablePaise, cgst_paise: Math.floor(tax / 2), sgst_paise: tax - Math.floor(tax / 2), igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: taxablePaise + tax, total_paise: taxablePaise + tax, apply_to_balance_paise: taxablePaise + tax, customer_credit_paise: 0, status: 'posted', reason: 'Return', notes: '', journal_entry_id: `je-${id}`, reversed_credit_note_invoice_id: null, legacy_migration_classification: null, device_id: 'test', created_at: now, updated_at: now, entity_version: 1 };
}

async function seedCatalog(db: BusinessVaultDB, customers: Customer[] = []): Promise<void> {
  const item: Item = { id: 'item', business_id: businessId, sku: 'SKU', name: 'Widget', description: 'Widget', hsn: '8471', category_id: null, unit_id: 'unit', sale_price_paise: 10000, purchase_price_paise: 8000, tax_rate_bps: 1800, cess_rate_bps: 0, is_service: 0, track_inventory: 0, opening_qty_micros: 0, opening_value_paise: 0, reorder_level_micros: 0, barcode: null, image_ref: null, active: 1, created_at: now, updated_at: now, entity_version: 1 };
  const unit: Unit = { id: 'unit', business_id: businessId, code: 'PCS', name: 'Pieces', decimal_places: 0, created_at: now, updated_at: now, entity_version: 1 };
  await db.businesses.add(business()); await db.items.add(item); await db.units.add(unit);
  for (const customer of customers) await db.customers.add(customer);
}

function business(): Business {
  return { id: businessId, name: 'Test Trade', legal_name: 'Test Trade Legal', gstin: gstin(), pan: null, address_line1: '', address_line2: '', city: 'Jaipur', state: 'Rajasthan', state_code: '08', pincode: '', country: 'IN', phone: '', email: '', financial_year_start_month: 4, current_financial_year: '2026-27', currency: 'INR', logo_ref: null, invoice_prefix: 'INV', invoice_next_seq: 1, drive_folder_id: null, drive_connected_email: null, schema_version: 1, created_at: now, updated_at: now, entity_version: 1 };
}

describe('GSTR report export', () => {
  it('covers every supplied GSTR1 worksheet and classifies outward supplies', async () => {
    const db = new BusinessVaultDB(`gstr-${Date.now()}`);
    const customer: Customer = { id: 'cust', business_id: businessId, name: 'Registered Buyer', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const item: Item = { id: 'item', business_id: businessId, sku: 'SKU', name: 'Widget', description: 'Widget', hsn: '8471', category_id: null, unit_id: 'unit', sale_price_paise: 10000, purchase_price_paise: 8000, tax_rate_bps: 1800, cess_rate_bps: 0, is_service: 0, track_inventory: 0, opening_qty_micros: 0, opening_value_paise: 0, reorder_level_micros: 0, barcode: null, image_ref: null, active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unit: Unit = { id: 'unit', business_id: businessId, code: 'PCS', name: 'Pieces', decimal_places: 0, created_at: now, updated_at: now, entity_version: 1 };
    const invoice: Invoice = { id: 'inv', business_id: businessId, invoice_number: '1001', invoice_date: '2026-08-10', due_date: null, customer_id: customer.id, customer_state_code: '08', place_of_supply: '08-Rajasthan', is_interstate: 0, financial_year: '2026-27', subtotal_paise: 10000, discount_paise: 0, taxable_paise: 10000, cgst_paise: 575, sgst_paise: 575, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 11150, total_paise: 11150, paid_paise: 0, balance_paise: 11150, status: 'issued', reversed_by_invoice_id: null, reverses_invoice_id: null, notes: '', terms: '', pdf_attachment_id: null, journal_entry_id: 'je', created_at: now, updated_at: now, entity_version: 1 };
    const lines: InvoiceLine[] = [
      { id: 'line-5', business_id: businessId, invoice_id: invoice.id, line_no: 1, item_id: item.id, description: 'Widget 5%', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_price_paise: 5000, discount_pct_bps: 0, discount_paise: 0, taxable_paise: 5000, tax_rate_bps: 500, cgst_paise: 125, sgst_paise: 125, igst_paise: 0, cess_paise: 0, line_total_paise: 5250 },
      { id: 'line-18', business_id: businessId, invoice_id: invoice.id, line_no: 2, item_id: item.id, description: 'Widget 18%', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_price_paise: 5000, discount_pct_bps: 0, discount_paise: 0, taxable_paise: 5000, tax_rate_bps: 1800, cgst_paise: 450, sgst_paise: 450, igst_paise: 0, cess_paise: 0, line_total_paise: 5900 },
    ];
    await db.businesses.add(business()); await db.customers.add(customer); await db.items.add(item); await db.units.add(unit); await db.invoices.add(invoice); await db.invoice_lines.bulkAdd(lines);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(Object.keys(report.sections)).toEqual([...GSTR1_SHEET_ORDER]);
    expect(report.sections.B2B.rows).toHaveLength(2);
    expect(report.sections.B2B.rows[0]['GSTIN/UIN of Recipient']).toBe(customer.gstin);
    expect(report.sections.B2B.rows.map((row) => row['Invoice Value'])).toEqual([11150, null]);
    expect(report.sections['HSN B2B'].rows).toHaveLength(2);
    expect(report.sections['HSN B2B'].rows[0]['HSN']).toBe('8471');
    expect(report.reconciliationIssues?.some((issue) => issue.message.includes('Unsupported source categories'))).toBe(true);
    const workbookResult = await buildGstrExcel(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookResult.xlsxBuffer);
    const b2bSheet = workbook.getWorksheet('B2B')!;
    expect(b2bSheet.getCell('E5').value).toBe(111.5);
    expect(b2bSheet.getCell('E6').value).toBe('');
    expect(b2bSheet.getCell('K5').value).toBe(18);
    expect(b2bSheet.getCell('K6').value).toBe(5);
    expect(b2bSheet.getCell('L5').value).toBe(50);
    expect(b2bSheet.getCell('L6').value).toBe(50);
    const combinedSheet = workbook.getWorksheet('Summary')!;
    expect(combinedSheet.getCell('G5').value).toBe(18);
    expect(combinedSheet.getCell('I5').value).toBe(50);
    expect(combinedSheet.getCell('G6').value).toBe(5);
    expect(combinedSheet.getCell('I6').value).toBe(50);
    await db.delete();
  });

  it('builds Purchase Register rows and HSN data from purchases', async () => {
    const db = new BusinessVaultDB(`gstr2-${Date.now()}`);
    const supplier: Supplier = { id: 'supplier', business_id: businessId, name: 'Supplier', phone: '', email: '', gstin: gstin('08CCCCC0000C1Z'), address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const purchase: Purchase = { id: 'purchase', business_id: businessId, bill_number: 'PB-1', supplier_bill_number: 'SUP-1', bill_date: '2026-08-10', due_date: null, supplier_id: supplier.id, supplier_state_code: '08', is_interstate: 0, financial_year: '2026-27', subtotal_paise: 10000, discount_paise: 0, taxable_paise: 10000, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 11800, total_paise: 11800, paid_paise: 0, balance_paise: 11800, status: 'received', reversed_by_purchase_id: null, reverses_purchase_id: null, notes: '', attachment_id: null, journal_entry_id: 'je', created_at: now, updated_at: now, entity_version: 1 };
    const line: PurchaseLine = { id: 'purchase-line', business_id: businessId, purchase_id: purchase.id, line_no: 1, item_id: 'item', description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_cost_paise: 10000, discount_paise: 0, taxable_paise: 10000, tax_rate_bps: 1800, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0, line_total_paise: 11800 };
    const item: Item = { id: 'item', business_id: businessId, sku: 'SKU', name: 'Widget', description: 'Widget', hsn: '8471', category_id: null, unit_id: 'unit', sale_price_paise: 10000, purchase_price_paise: 8000, tax_rate_bps: 1800, cess_rate_bps: 0, is_service: 0, track_inventory: 0, opening_qty_micros: 0, opening_value_paise: 0, reorder_level_micros: 0, barcode: null, image_ref: null, active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unit: Unit = { id: 'unit', business_id: businessId, code: 'PCS', name: 'Pieces', decimal_places: 0, created_at: now, updated_at: now, entity_version: 1 };
    await db.businesses.add(business()); await db.suppliers.add(supplier); await db.items.add(item); await db.units.add(unit); await db.purchases.add(purchase); await db.purchase_lines.add(line);
    const report = await buildGstrReport(businessId, 'purchaseRegister', '2026-08-01', '2026-08-31', { db });
    expect(report.schema_name).toBe('BusinessVaultGSTWorkpaper');
    expect(report.disclaimer).toContain('not GSTN upload JSON');
    expect(report.sections['Supplier Bills'].rows).toHaveLength(1);
    expect(report.sections['Supplier Bills'].rows[0]['GSTIN/UIN of Supplier']).toBe(supplier.gstin);
    expect(report.sections['HSN Summary'].rows[0]['Taxable Value']).toBe(10000);
    await db.delete();
  });

  it('hardens classifications, reconciles workbook structure, and reopens both XLSX files', async () => {
    const db = new BusinessVaultDB(`gstr-hardening-${Date.now()}`);
    const registered: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unregistered: Customer = { ...registered, id: 'unregistered', name: 'Cash buyer', gstin: null };
    await seedCatalog(db, [registered, unregistered]);
    const b2b = invoice('b2b', registered.id, '0001', 11800, 0);
    const b2cs = invoice('b2cs', unregistered.id, '0002', 10000000, 1);
    const b2cl = invoice('b2cl', unregistered.id, '0003', 10000001, 1);
    await db.invoices.bulkAdd([b2b, b2cs, b2cl]);
    await db.invoice_lines.bulkAdd([invoiceLine('l1', b2b.id, 10000), invoiceLine('l2', b2cs.id, 8474576), invoiceLine('l3', b2cl.id, 8474577)]);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.B2B.rows).toHaveLength(1);
    expect(report.sections['B2C Other'].rows).toHaveLength(1);
    expect(report.sections['B2C Other'].rows[0]['Taxable Value']).toBe(8474576);
    expect(report.sections['B2C Large'].rows.map((row) => row['Invoice Number'])).toEqual(['0003']);
    expect(report.sections['HSN B2B'].rows[0]['Taxable Value']).toBe(10000);
    expect(report.sections['HSN B2C'].rows.reduce((sum, row) => sum + Number(row['Taxable Value']), 0)).toBe(16949153);
    expect(report.sections['Documents Issued'].rows[0]['Total documents issued']).toBe(3);
    expect(hsnRequiredLengthForTurnover(5_000_000_000)).toBe(4);
    expect(hsnRequiredLengthForTurnover(5_000_000_001)).toBe(6);
    expect(isHsnLengthSupported('8471')).toBe(true);
    expect(isHsnLengthSupported('123456')).toBe(true);
    expect(isHsnLengthSupported('12345678')).toBe(true);
    expect(isHsnLengthSupported('847')).toBe(false);
    expect(isHsnLengthSupported('12345')).toBe(false);

    const gstr1 = await buildGstrExcel(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    const wb1 = new ExcelJS.Workbook(); await wb1.xlsx.load(gstr1.xlsxBuffer);
    expect(wb1.worksheets.map((sheet) => sheet.name)).toEqual(GSTR1_SHEET_ORDER);
    expect(wb1.getWorksheet('Summary')?.getCell('E5').value).toBeInstanceOf(Date);
    expect(wb1.getWorksheet('Summary')?.getCell('F5').value).toBe(118);
    const cellValues = wb1.worksheets.flatMap((sheet) => sheet.getRows(1, sheet.rowCount)?.flatMap((row) => row.values as unknown[]) ?? []);
    expect(cellValues.some((value) => value === undefined || value === null || value === 'undefined' || value === 'null' || value === 'NaN' || value === 'Infinity')).toBe(false);

    const gstr2 = await buildGstrExcel(businessId, 'purchaseRegister', '2026-08-01', '2026-08-31', { db });
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(gstr2.xlsxBuffer);
    expect(wb2.worksheets.map((sheet) => sheet.name)).toEqual(PURCHASE_REGISTER_SHEET_ORDER);
    expect(wb2.getWorksheet('Summary')?.getCell('A1').value).toMatch(/Purchase Register/);
    expect(gstr2.filename).toBe('bv-purchase-register-2026-08.xlsx');
    expect(gstr1.filename).toBe('bv-gstr1-workpaper-2026-08.xlsx');
    expect(gstr1.issues.some((issue) => issue.message.includes('Unsupported source categories'))).toBe(true);
    const purchaseBook = await buildGstrExcel(businessId, 'purchaseRegister', '2026-08-01', '2026-08-31', { db });
    const purchaseWorkbook = new ExcelJS.Workbook();
    await purchaseWorkbook.xlsx.load(purchaseBook.xlsxBuffer);
    expect(purchaseWorkbook.getWorksheet('Summary')?.getCell('C3').value).toBe('2026-08-01 to 2026-08-31');
    expect(purchaseWorkbook.getWorksheet('Summary')?.getCell('D3').value).toBe('INCOMPLETE WORKPAPER');
    await db.delete();
  });

  it('exports HSN quantities in units and preserves eight-digit HSN codes', async () => {
    const db = new BusinessVaultDB(`gstr-hsn-quantity-${Date.now()}`);
    const customer: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const sale = invoice('hsn-quantity', customer.id, 'HSN-1', 11800, 0);
    const line = invoiceLine('hsn-quantity-line', sale.id, 10000);
    line.hsn = '12345678';
    line.qty_micros = 1_250_000;
    await db.invoices.add(sale);
    await db.invoice_lines.add(line);

    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['HSN B2B'].rows[0]).toMatchObject({ HSN: '12345678', 'Total Quantity': 1.25 });
    expect(report.reconciliationIssues?.some((issue) => issue.message.includes("HSN '12345678'"))).toBe(false);
    await db.delete();
  });

  it('nets posted sales-return line quantities and values into the matching HSN groups', async () => {
    const db = new BusinessVaultDB(`gstr-hsn-returns-${Date.now()}`);
    const registered: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unregistered: Customer = { ...registered, id: 'unregistered', name: 'Cash buyer', gstin: null };
    await seedCatalog(db, [registered, unregistered]);
    const b2b = invoice('hsn-return-b2b', registered.id, 'HSN-2', 11800, 0);
    const b2c = invoice('hsn-return-b2c', unregistered.id, 'HSN-3', 11800, 0);
    await db.invoices.bulkAdd([b2b, b2c]);
    await db.invoice_lines.bulkAdd([
      invoiceLine('hsn-return-b2b-line', b2b.id, 10000),
      invoiceLine('hsn-return-b2c-line', b2c.id, 10000),
    ]);
    const returns = [
      salesReturn('hsn-return-b2b-note', 'CN-HSN-1', registered.id, b2b.id, 5000),
      salesReturn('hsn-return-b2c-note', 'CN-HSN-2', unregistered.id, b2c.id, 5000),
    ];
    await db.sales_returns.bulkAdd(returns);
    const returnItems: SalesReturnItem[] = returns.map((note, index) => ({
      id: `hsn-return-item-${index}`,
      business_id: businessId,
      sales_return_id: note.id,
      original_invoice_id: note.original_invoice_id,
      original_invoice_line_id: `hsn-return-${index ? 'b2c' : 'b2b'}-line`,
      item_id: 'item',
      description: 'Widget',
      hsn: '8471',
      warehouse_id: '',
      line_no: 1,
      qty_micros: 500_000,
      unit_price_paise: 10000,
      discount_pct_bps: 0,
      discount_paise: 0,
      taxable_paise: 5000,
      tax_rate_bps: 1800,
      cgst_paise: 450,
      sgst_paise: 450,
      igst_paise: 0,
      cess_paise: 0,
      line_total_paise: 5900,
    }));
    await db.sales_return_items.bulkAdd(returnItems);

    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['HSN B2B'].rows[0]).toMatchObject({ 'Total Quantity': 0.5, 'Total Value': 5900, 'Taxable Value': 5000 });
    expect(report.sections['HSN B2C'].rows[0]).toMatchObject({ 'Total Quantity': 0.5, 'Total Value': 5900, 'Taxable Value': 5000 });
    await db.delete();
  });

  it('blocks invalid GSTIN instead of classifying it as unregistered', async () => {
    const db = new BusinessVaultDB(`gstr-invalid-${Date.now()}`);
    const customer: Customer = { id: 'bad', business_id: businessId, name: 'Bad GSTIN', phone: '', email: '', gstin: 'not-valid', billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const sale = invoice('leading', customer.id, '000042', 11800, 0);
    await db.invoices.add(sale); await db.invoice_lines.add(invoiceLine('leading-line', sale.id, 10000));
    const result = await buildGstrExcel(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(result.issues.some((issue) => issue.severity === 'blocking_error' && issue.message.includes('UNCLASSIFIED_INVALID_GSTIN'))).toBe(true);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['B2C Other'].rows).toHaveLength(0);
    expect(report.sections.Exceptions.rows.some((row) => row['Document Number'] === '000042')).toBe(true);
    await db.delete();
  });

  it('keeps purchase returns negative in the internal purchase report', async () => {
    const db = new BusinessVaultDB(`gstr-purchase-return-${Date.now()}`);
    const supplier: Supplier = { id: 'supplier', business_id: businessId, name: 'Supplier', phone: '', email: '', gstin: gstin('08CCCCC0000C1Z'), address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db); await db.suppliers.add(supplier);
    const purchase = { id: 'purchase-return', business_id: businessId, bill_number: 'DN-0001', supplier_bill_number: 'RET-0001', bill_date: '2026-08-10', due_date: null, supplier_id: supplier.id, supplier_state_code: '08', is_interstate: 0, financial_year: '2026-27', subtotal_paise: -10000, discount_paise: 0, taxable_paise: -10000, cgst_paise: -900, sgst_paise: -900, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none' as const, pre_round_total_paise: -11800, total_paise: -11800, paid_paise: 0, balance_paise: -11800, status: 'received' as const, reversed_by_purchase_id: null, reverses_purchase_id: 'original', notes: '', attachment_id: null, journal_entry_id: 'je-return', created_at: now, updated_at: now, entity_version: 1 } satisfies Purchase;
    await db.purchases.add(purchase); await db.purchase_lines.add({ id: 'return-line', business_id: businessId, purchase_id: purchase.id, line_no: 1, item_id: 'item', description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: -1_000_000, unit_cost_paise: 10000, discount_paise: 0, taxable_paise: -10000, tax_rate_bps: 1800, cgst_paise: -900, sgst_paise: -900, igst_paise: 0, cess_paise: 0, line_total_paise: -11800 });
    const report = await buildGstrReport(businessId, 'purchaseRegister', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['Supplier Bills'].rows[0]['Bill Value']).toBe(-11800);
    expect(report.sections['HSN Summary'].rows[0]['Taxable Value']).toBe(-10000);
    await db.delete();
  });

  it('routes registered and unregistered sales notes and reconciles note documents', async () => {
    const db = new BusinessVaultDB(`gstr-notes-${Date.now()}`);
    const registered: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unregistered: Customer = { ...registered, id: 'unregistered', name: 'Cash buyer', gstin: null };
    await seedCatalog(db, [registered, unregistered]);
    const b2b = invoice('note-b2b', registered.id, '0100', 11800, 0);
    const b2cs = invoice('note-b2cs', unregistered.id, '0101', 10000, 0);
    const b2cl = invoice('note-b2cl', unregistered.id, '0102', 11800001, 1);
    await db.invoices.bulkAdd([b2b, b2cs, b2cl]);
    await db.invoice_lines.bulkAdd([invoiceLine('note-l1', b2b.id, 10000), invoiceLine('note-l2', b2cs.id, 8474), invoiceLine('note-l3', b2cl.id, 8474577)]);
    await db.sales_returns.bulkAdd([
      salesReturn('cn-registered', 'CN-0001', registered.id, b2b.id, 1000),
      salesReturn('cn-b2cl', 'CN-0002', unregistered.id, b2cl.id, 10_000_000),
      salesReturn('cn-b2cs', 'CN-0003', unregistered.id, b2cs.id, 1000),
    ]);
    const b2clCreditNote = await db.sales_returns.get('cn-b2cl');
    if (b2clCreditNote) {
      b2clCreditNote.total_paise = 11_800_000;
      b2clCreditNote.pre_round_total_paise = 11_800_000;
      b2clCreditNote.cgst_paise = 900_000;
      b2clCreditNote.sgst_paise = 900_000;
      await db.sales_returns.put(b2clCreditNote);
    }
    const returnNotes = await db.sales_returns.toArray();
    await db.sales_return_items.bulkAdd(returnNotes.map((note) => {
      const originalLineId = note.id === 'cn-registered' ? 'note-l1' : note.id === 'cn-b2cl' ? 'note-l3' : 'note-l2';
      const tax = note.cgst_paise + note.sgst_paise + note.igst_paise + note.cess_paise;
      return {
        id: `line-${note.id}`,
        business_id: businessId,
        sales_return_id: note.id,
        original_invoice_id: note.original_invoice_id,
        original_invoice_line_id: originalLineId,
        item_id: 'item',
        description: 'Widget',
        hsn: '8471',
        warehouse_id: '',
        line_no: 1,
        qty_micros: 1_000_000,
        unit_price_paise: note.taxable_paise,
        discount_pct_bps: 0,
        discount_paise: 0,
        taxable_paise: note.taxable_paise,
        tax_rate_bps: 1800,
        cgst_paise: note.cgst_paise,
        sgst_paise: note.sgst_paise,
        igst_paise: note.igst_paise,
        cess_paise: note.cess_paise,
        line_total_paise: note.taxable_paise + tax,
      };
    }));
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['Credit Notes B2B'].rows.map((row) => row['Note Number'])).toEqual(['CN-0001']);
    expect(report.sections['Credit Notes B2C'].rows.map((row) => row['Note Number'])).toEqual(['CN-0002']);
    expect(report.sections['B2C Other'].rows).toHaveLength(1);
    expect(report.sections['B2C Other'].rows[0]['Taxable Value']).toBe(7474);
    expect(report.sections['Documents Issued'].rows.some((row) => row['Nature of Document'] === 'Credit notes' && row['Total documents issued'] === 3)).toBe(true);
    expect(report.sections['Credit Notes B2C'].rows[0]['Note Value']).toBe(11_800_000);
    expect(report.reconciliationIssues?.some((issue) => issue.message.includes('cannot be placed in cdnr'))).toBe(false);
    await db.delete();
  });

  it('exports rounded credit-note components and explicit round-off', async () => {
    const db = new BusinessVaultDB(`gstr-rounded-note-${Date.now()}`);
    const registered: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [registered]);
    const original = invoice('rounded-original', registered.id, '07663', 900, 0);
    await db.invoices.add(original);
    await db.invoice_lines.add(invoiceLine('rounded-line', original.id, 900));
    const note = salesReturn('rounded-note', 'SR-000007', registered.id, original.id, 900);
    note.total_paise = 900;
    note.round_off_paise = -45;
    note.pre_round_total_paise = 945;
    note.cgst_paise = 22;
    note.sgst_paise = 23;
    note.taxable_paise = 900;
    await db.sales_returns.add(note);
    await db.sales_return_items.add({
      id: 'rounded-note-line',
      business_id: businessId,
      sales_return_id: note.id,
      original_invoice_id: original.id,
      original_invoice_line_id: 'rounded-line',
      item_id: 'item',
      description: 'Widget',
      hsn: '8471',
      warehouse_id: '',
      line_no: 1,
      qty_micros: 1_000_000,
      unit_price_paise: 900,
      discount_pct_bps: 0,
      discount_paise: 0,
      taxable_paise: 900,
      tax_rate_bps: 1800,
      cgst_paise: 22,
      sgst_paise: 23,
      igst_paise: 0,
      cess_paise: 0,
      line_total_paise: 945,
    });

    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    const row = report.sections['Credit Notes B2B'].rows[0];
    expect(row['Note Value']).toBe(900);
    expect(row['Taxable Value']).toBe(900);
    expect(row['Central Tax Amount']).toBe(22);
    expect(row['State/UT Tax Amount']).toBe(23);
    expect(row['Round Off Amount']).toBe(-45);
    expect(report.reconciliationIssues?.some((issue) => issue.documentNumber === 'SR-000007' && issue.severity === 'blocking_error')).toBe(false);
    await db.delete();
  });

  it('sums thousands of small paise-valued rows exactly without rupee conversions', () => {
    const count = 10_000;
    const totalPaise = sumPaise(Array.from({ length: count }, () => 1));
    expect(totalPaise).toBe(count);
    expect(totalPaise / 100).toBe(100);
  });

  it('aggregates 1,000 one-paise documents in report paise and exports exact rupee totals', async () => {
    const db = new BusinessVaultDB(`gstr-many-docs-${Date.now()}`);
    const customer: Customer = { id: 'cash', business_id: businessId, name: 'Cash buyers', phone: '', email: '', gstin: null, billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const count = 1000;
    const invoices = Array.from({ length: count }, (_, i) => invoice(`small-${i}`, customer.id, `SMALL-${String(i + 1).padStart(4, '0')}`, 1, 0));
    const lines = invoices.map((row, i) => ({ ...invoiceLine(`small-line-${i}`, row.id, 1), line_total_paise: 1 }));
    await db.transaction('rw', db.invoices, db.invoice_lines, async () => {
      await db.invoices.bulkAdd(invoices);
      await db.invoice_lines.bulkAdd(lines);
    });
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['B2C Other'].rows).toHaveLength(1);
    expect(report.sections['B2C Other'].rows[0]['Taxable Value']).toBe(1000);
    expect(report.sections['HSN B2C'].rows[0]['Total Value']).toBe(1000);
    const result = await buildGstrExcel(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.xlsxBuffer);
    expect(workbook.getWorksheet('Summary')?.getCell('F3').value).toBe(10);
    expect(workbook.getWorksheet('B2C Other')?.getCell('E5').value).toBe(10);
    expect(result.issues.some((issue) => issue.severity === 'blocking_error')).toBe(true);
    await db.delete();
  }, 20000);

  it('uses strict, date-effective B2C Large boundaries and validates persisted round-off', async () => {
    expect(isB2cLargeValue('2024-07-31', 25_000_000, true)).toBe(false);
    expect(isB2cLargeValue('2024-07-31', 25_000_100, true)).toBe(true);
    expect(isB2cLargeValue('2024-08-01', 10_000_000, true)).toBe(false);
    expect(isB2cLargeValue('2024-08-01', 10_000_100, true)).toBe(true);
    expect(isB2cLargeValue('2024-08-01', 10_000_100, false)).toBe(false);
    expect(addPaise(0, 1)).toBe(1);
    expect(() => addPaise(0, Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);

    const db = new BusinessVaultDB(`gstr-rounding-${Date.now()}`);
    const customer: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const sale = invoice('rounded-invoice', customer.id, '0001', 11800, 0);
    sale.pre_round_total_paise = 11875;
    sale.round_off_paise = 25;
    sale.total_paise = 11900;
    sale.taxable_paise = 10000;
    sale.cgst_paise = 900;
    sale.sgst_paise = 975;
    const line = invoiceLine('rounded-invoice-line', sale.id, 10000);
    line.sgst_paise = 975;
    line.line_total_paise = 11875;
    await db.invoices.add(sale);
    await db.invoice_lines.add(line);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.B2B.rows[0]['Invoice Value']).toBe(11900);
    expect(report.sections.B2B.rows[0]['Taxable Value']).toBe(10000);
    expect(report.sections.B2B.rows[0]['Central Tax Amount']).toBe(900);
    expect(report.sections.B2B.rows[0]['State/UT Tax Amount']).toBe(975);
    expect(report.sections.B2B.rows[0]['Invoice Value']).toBe(addPaise(11875, 25));
    expect(report.reconciliationIssues?.some((issue) => issue.documentNumber === '0001' && issue.message.includes('pre-round invariant failed'))).toBe(false);
    await db.delete();
  });

  it('keeps round_off_mode none paise and applies signed round-off only to total', async () => {
    const db = new BusinessVaultDB(`gstr-roundoff-signed-${Date.now()}`);
    const customer: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: gstin('08BBBBB0000B1Z'), billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const sale = invoice('none-rounding', customer.id, '0002', 11801, 0);
    sale.subtotal_paise = 10001;
    sale.taxable_paise = 10001;
    sale.cgst_paise = 900;
    sale.sgst_paise = 900;
    sale.pre_round_total_paise = 11801;
    sale.round_off_paise = 0;
    sale.round_off_mode = 'none';
    sale.total_paise = 11801;
    await db.invoices.add(sale);
    await db.invoice_lines.add(invoiceLine('none-line', sale.id, 10001));
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    const row = report.sections.B2B.rows[0];
    expect(row['Invoice Value']).toBe(11801);
    expect(row['Taxable Value']).toBe(10001);
    expect(addPaise(Number(row['Taxable Value']), Number(row['Central Tax Amount']))).toBe(10901);
    expect(report.reconciliationIssues?.some((issue) => issue.documentNumber === '0002' && issue.message.includes('pre-round invariant failed'))).toBe(false);
    await db.delete();
  });

  it('sorts document series numerically and reports gaps and duplicates including cancelled rows', () => {
    expect(parseDocumentSeries([
      { number: 'FY26-27-10', cancelled: false },
      { number: 'FY26-27-2', cancelled: true },
      { number: 'FY26-27-2', cancelled: false },
      { number: 'FY26-27-1', cancelled: false },
    ])).toEqual([{
      prefix: 'FY26-27-', from: 'FY26-27-1', to: 'FY26-27-10', total: 4,
      cancelled: 1, net: 3, gaps: ['FY26-27-3-FY26-27-9'], duplicates: ['FY26-27-2'],
    }]);
  });

  it('warns without classifying a note when category fields are insufficient', async () => {
    const db = new BusinessVaultDB(`gstr-note-warning-${Date.now()}`);
    const customer: Customer = { id: 'unregistered', business_id: businessId, name: 'Cash buyer', phone: '', email: '', gstin: null, billing_address: '', shipping_address: '', state: '', state_code: '', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const missingOriginalNote = salesReturn('cn-missing', 'CN-MISSING', customer.id, 'missing-original', 1000);
    await db.sales_returns.add(missingOriginalNote);
    await db.sales_return_items.add({
      id: 'cn-missing-line',
      business_id: businessId,
      sales_return_id: missingOriginalNote.id,
      original_invoice_id: missingOriginalNote.original_invoice_id,
      original_invoice_line_id: 'missing-original-line',
      item_id: 'item',
      description: 'Widget',
      hsn: '8471',
      warehouse_id: '',
      line_no: 1,
      qty_micros: 100_000,
      unit_price_paise: 1000,
      discount_pct_bps: 0,
      discount_paise: 0,
      taxable_paise: 1000,
      tax_rate_bps: 1800,
      cgst_paise: 90,
      sgst_paise: 90,
      igst_paise: 0,
      cess_paise: 0,
      line_total_paise: 1180,
    });
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['Credit Notes B2B'].rows).toHaveLength(0);
    expect(report.sections['Credit Notes B2C'].rows).toHaveLength(0);
    expect(report.sections['B2C Other'].rows).toHaveLength(0);
    expect(report.reconciliationIssues?.find((issue) => issue.documentNumber === 'CN-MISSING')?.message).toContain('missing place of supply and original invoice context');
    await db.delete();
  });
});
