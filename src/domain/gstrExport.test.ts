import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { BusinessVaultDB } from '../db/database';
import ExcelJS from 'exceljs';
import type { Business, Customer, Item, Invoice, InvoiceLine, Purchase, PurchaseLine, SalesReturn, Supplier, Unit } from '../db/types';
import { buildGstrExcel, buildGstrReport, GSTR1_SHEET_ORDER, GSTR2_SHEET_ORDER, hsnRequiredLengthForTurnover } from './gstrExport';

const now = '2026-08-31T00:00:00.000Z';
const businessId = 'gstr-business';

function invoice(id: string, customerId: string, number: string, totalPaise: number, interstate: number): Invoice {
  const taxable = Math.round(totalPaise / 1.18);
  const tax = totalPaise - taxable;
  return { id, business_id: businessId, invoice_number: number, invoice_date: '2026-08-10', due_date: null, customer_id: customerId, customer_state_code: interstate ? '09' : '08', place_of_supply: interstate ? '09-Uttar Pradesh' : '08-Rajasthan', is_interstate: interstate, financial_year: '2026-27', subtotal_paise: taxable, discount_paise: 0, taxable_paise: taxable, cgst_paise: interstate ? 0 : Math.floor(tax / 2), sgst_paise: interstate ? 0 : tax - Math.floor(tax / 2), igst_paise: interstate ? tax : 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: totalPaise, total_paise: totalPaise, paid_paise: 0, balance_paise: totalPaise, status: 'issued', reversed_by_invoice_id: null, reverses_invoice_id: null, notes: '', terms: '', pdf_attachment_id: null, journal_entry_id: `je-${id}`, created_at: now, updated_at: now, entity_version: 1 };
}

function invoiceLine(id: string, invoiceId: string, taxablePaise: number, taxRateBps = 1800): InvoiceLine {
  const tax = Math.round(taxablePaise * taxRateBps / 10000);
  return { id, business_id: businessId, invoice_id: invoiceId, line_no: 1, item_id: 'item', description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_price_paise: taxablePaise, discount_pct_bps: 0, discount_paise: 0, taxable_paise: taxablePaise, tax_rate_bps: taxRateBps, cgst_paise: tax / 2, sgst_paise: tax / 2, igst_paise: 0, cess_paise: 0, line_total_paise: taxablePaise + tax };
}

function salesReturn(id: string, number: string, customerId: string, originalInvoiceId: string, taxablePaise: number): SalesReturn {
  const tax = Math.round(taxablePaise * 1800 / 10000);
  return { id, business_id: businessId, return_number: number, return_date: '2026-08-20', original_invoice_id: originalInvoiceId, customer_id: customerId, subtotal_paise: taxablePaise, discount_paise: 0, taxable_paise: taxablePaise, cgst_paise: tax / 2, sgst_paise: tax / 2, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: taxablePaise + tax, total_paise: taxablePaise + tax, apply_to_balance_paise: taxablePaise + tax, customer_credit_paise: 0, status: 'posted', reason: 'Return', notes: '', journal_entry_id: `je-${id}`, reversed_credit_note_invoice_id: null, legacy_migration_classification: null, device_id: 'test', created_at: now, updated_at: now, entity_version: 1 };
}

async function seedCatalog(db: BusinessVaultDB, customers: Customer[] = []): Promise<void> {
  const item: Item = { id: 'item', business_id: businessId, sku: 'SKU', name: 'Widget', description: 'Widget', hsn: '8471', category_id: null, unit_id: 'unit', sale_price_paise: 10000, purchase_price_paise: 8000, tax_rate_bps: 1800, cess_rate_bps: 0, is_service: 0, track_inventory: 0, opening_qty_micros: 0, opening_value_paise: 0, reorder_level_micros: 0, barcode: null, image_ref: null, active: 1, created_at: now, updated_at: now, entity_version: 1 };
  const unit: Unit = { id: 'unit', business_id: businessId, code: 'PCS', name: 'Pieces', decimal_places: 0, created_at: now, updated_at: now, entity_version: 1 };
  await db.businesses.add(business()); await db.items.add(item); await db.units.add(unit);
  for (const customer of customers) await db.customers.add(customer);
}

function business(): Business {
  return { id: businessId, name: 'Test Trade', legal_name: 'Test Trade Legal', gstin: '08AAAAA0000A1Z9', pan: null, address_line1: '', address_line2: '', city: 'Jaipur', state: 'Rajasthan', state_code: '08', pincode: '', country: 'IN', phone: '', email: '', financial_year_start_month: 4, current_financial_year: '2026-27', currency: 'INR', logo_ref: null, invoice_prefix: 'INV', invoice_next_seq: 1, drive_folder_id: null, drive_connected_email: null, schema_version: 1, created_at: now, updated_at: now, entity_version: 1 };
}

describe('GSTR report export', () => {
  it('covers every supplied GSTR1 worksheet and classifies outward supplies', async () => {
    const db = new BusinessVaultDB(`gstr-${Date.now()}`);
    const customer: Customer = { id: 'cust', business_id: businessId, name: 'Registered Buyer', phone: '', email: '', gstin: '08BBBBB0000B1Z0', billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const item: Item = { id: 'item', business_id: businessId, sku: 'SKU', name: 'Widget', description: 'Widget', hsn: '8471', category_id: null, unit_id: 'unit', sale_price_paise: 10000, purchase_price_paise: 8000, tax_rate_bps: 1800, cess_rate_bps: 0, is_service: 0, track_inventory: 0, opening_qty_micros: 0, opening_value_paise: 0, reorder_level_micros: 0, barcode: null, image_ref: null, active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unit: Unit = { id: 'unit', business_id: businessId, code: 'PCS', name: 'Pieces', decimal_places: 0, created_at: now, updated_at: now, entity_version: 1 };
    const invoice: Invoice = { id: 'inv', business_id: businessId, invoice_number: '1001', invoice_date: '2026-08-10', due_date: null, customer_id: customer.id, customer_state_code: '08', place_of_supply: '08-Rajasthan', is_interstate: 0, financial_year: '2026-27', subtotal_paise: 10000, discount_paise: 0, taxable_paise: 10000, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 11800, total_paise: 11800, paid_paise: 0, balance_paise: 11800, status: 'issued', reversed_by_invoice_id: null, reverses_invoice_id: null, notes: '', terms: '', pdf_attachment_id: null, journal_entry_id: 'je', created_at: now, updated_at: now, entity_version: 1 };
    const line: InvoiceLine = { id: 'line', business_id: businessId, invoice_id: invoice.id, line_no: 1, item_id: item.id, description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_price_paise: 10000, discount_pct_bps: 0, discount_paise: 0, taxable_paise: 10000, tax_rate_bps: 1800, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0, line_total_paise: 11800 };
    await db.businesses.add(business()); await db.customers.add(customer); await db.items.add(item); await db.units.add(unit); await db.invoices.add(invoice); await db.invoice_lines.add(line);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(Object.keys(report.sections)).toEqual(['GSTR1 Report', 'b2b,sez,de', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exp', 'at', 'atadj', 'exemp', 'hsn(b2b)', 'hsn(b2c)', 'itemSummary', 'docs']);
    expect(report.sections['b2b,sez,de'].rows).toHaveLength(1);
    expect(report.sections['b2b,sez,de'].rows[0]['GSTIN/UIN of Recipient']).toBe(customer.gstin);
    expect(report.sections['hsn(b2b)'].rows[0]['HSN']).toBe('8471');
    await db.delete();
  });

  it('builds GSTR2 inward rows and HSN data from purchases', async () => {
    const db = new BusinessVaultDB(`gstr2-${Date.now()}`);
    const supplier: Supplier = { id: 'supplier', business_id: businessId, name: 'Supplier', phone: '', email: '', gstin: '08CCCCC0000C1ZR', address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const purchase: Purchase = { id: 'purchase', business_id: businessId, bill_number: 'PB-1', supplier_bill_number: 'SUP-1', bill_date: '2026-08-10', due_date: null, supplier_id: supplier.id, supplier_state_code: '08', is_interstate: 0, financial_year: '2026-27', subtotal_paise: 10000, discount_paise: 0, taxable_paise: 10000, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: 11800, total_paise: 11800, paid_paise: 0, balance_paise: 11800, status: 'received', reversed_by_purchase_id: null, reverses_purchase_id: null, notes: '', attachment_id: null, journal_entry_id: 'je', created_at: now, updated_at: now, entity_version: 1 };
    const line: PurchaseLine = { id: 'purchase-line', business_id: businessId, purchase_id: purchase.id, line_no: 1, item_id: 'item', description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: 1_000_000, unit_cost_paise: 10000, discount_paise: 0, taxable_paise: 10000, tax_rate_bps: 1800, cgst_paise: 900, sgst_paise: 900, igst_paise: 0, cess_paise: 0, line_total_paise: 11800 };
    const item: Item = { id: 'item', business_id: businessId, sku: 'SKU', name: 'Widget', description: 'Widget', hsn: '8471', category_id: null, unit_id: 'unit', sale_price_paise: 10000, purchase_price_paise: 8000, tax_rate_bps: 1800, cess_rate_bps: 0, is_service: 0, track_inventory: 0, opening_qty_micros: 0, opening_value_paise: 0, reorder_level_micros: 0, barcode: null, image_ref: null, active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unit: Unit = { id: 'unit', business_id: businessId, code: 'PCS', name: 'Pieces', decimal_places: 0, created_at: now, updated_at: now, entity_version: 1 };
    await db.businesses.add(business()); await db.suppliers.add(supplier); await db.items.add(item); await db.units.add(unit); await db.purchases.add(purchase); await db.purchase_lines.add(line);
    const report = await buildGstrReport(businessId, 'gstr2', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.b2b.rows).toHaveLength(1);
    expect(report.sections.b2b.rows[0]['GSTIN/UIN of Supplier']).toBe(supplier.gstin);
    expect(report.sections.hsn.rows[0]['Taxable Value']).toBe(100);
    await db.delete();
  });

  it('hardens classifications, reconciles workbook structure, and reopens both XLSX files', async () => {
    const db = new BusinessVaultDB(`gstr-hardening-${Date.now()}`);
    const registered: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: '08BBBBB0000B1Z0', billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unregistered: Customer = { ...registered, id: 'unregistered', name: 'Cash buyer', gstin: null };
    await seedCatalog(db, [registered, unregistered]);
    const b2b = invoice('b2b', registered.id, '0001', 11800, 0);
    const b2cs = invoice('b2cs', unregistered.id, '0002', 10000000, 1);
    const b2cl = invoice('b2cl', unregistered.id, '0003', 10000001, 1);
    await db.invoices.bulkAdd([b2b, b2cs, b2cl]);
    await db.invoice_lines.bulkAdd([invoiceLine('l1', b2b.id, 10000), invoiceLine('l2', b2cs.id, 8474576), invoiceLine('l3', b2cl.id, 8474577)]);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections['b2b,sez,de'].rows).toHaveLength(1);
    expect(report.sections.b2cs.rows.map((row) => row['Invoice Number'])).toEqual(['0002']);
    expect(report.sections.b2cl.rows.map((row) => row['Invoice Number'])).toEqual(['0003']);
    expect(report.sections['hsn(b2b)'].rows[0]['Taxable Value']).toBe(100);
    expect(report.sections['hsn(b2c)'].rows.reduce((sum, row) => sum + Number(row['Taxable Value']), 0)).toBe(169491.53);
    expect(report.sections.docs.rows[0]['Total documents issued']).toBe(3);
    expect(hsnRequiredLengthForTurnover(50_000_000_000)).toBe(4);
    expect(hsnRequiredLengthForTurnover(50_000_000_001)).toBe(6);

    const gstr1 = await buildGstrExcel(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    const wb1 = new ExcelJS.Workbook(); await wb1.xlsx.load(gstr1.xlsxBuffer);
    expect(wb1.worksheets.map((sheet) => sheet.name)).toEqual(GSTR1_SHEET_ORDER);
    expect(wb1.getWorksheet('GSTR1 Report')?.getCell('E5').value).toBeInstanceOf(Date);
    expect(wb1.getWorksheet('GSTR1 Report')?.getCell('F5').value).toBe(118);
    const cellValues = wb1.worksheets.flatMap((sheet) => sheet.getRows(1, sheet.rowCount)?.flatMap((row) => row.values as unknown[]) ?? []);
    expect(cellValues.some((value) => value === undefined || value === null || value === 'undefined' || value === 'null' || value === 'NaN' || value === 'Infinity')).toBe(false);

    const gstr2 = await buildGstrExcel(businessId, 'gstr2', '2026-08-01', '2026-08-31', { db });
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(gstr2.xlsxBuffer);
    expect(wb2.worksheets.map((sheet) => sheet.name)).toEqual(GSTR2_SHEET_ORDER);
    expect(wb2.getWorksheet('GSTR2 Report')?.getCell('A1').value).toMatch(/not a filed GSTR-2A\/2B/);
    expect(gstr1.issues.some((issue) => issue.message.includes('Unsupported source categories'))).toBe(true);
    await db.delete();
  });

  it('warns for invalid GSTIN and preserves leading-zero identifiers', async () => {
    const db = new BusinessVaultDB(`gstr-invalid-${Date.now()}`);
    const customer: Customer = { id: 'bad', business_id: businessId, name: 'Bad GSTIN', phone: '', email: '', gstin: 'not-valid', billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    const sale = invoice('leading', customer.id, '000042', 11800, 0);
    await db.invoices.add(sale); await db.invoice_lines.add(invoiceLine('leading-line', sale.id, 10000));
    const result = await buildGstrExcel(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(result.issues.some((issue) => issue.message.includes('Invalid customer GSTIN'))).toBe(true);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.b2cs.rows[0]['Invoice Number']).toBe('000042');
    await db.delete();
  });

  it('keeps purchase returns negative in the internal purchase report', async () => {
    const db = new BusinessVaultDB(`gstr-purchase-return-${Date.now()}`);
    const supplier: Supplier = { id: 'supplier', business_id: businessId, name: 'Supplier', phone: '', email: '', gstin: '08CCCCC0000C1ZR', address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db); await db.suppliers.add(supplier);
    const purchase = { id: 'purchase-return', business_id: businessId, bill_number: 'DN-0001', supplier_bill_number: 'RET-0001', bill_date: '2026-08-10', due_date: null, supplier_id: supplier.id, supplier_state_code: '08', is_interstate: 0, financial_year: '2026-27', subtotal_paise: -10000, discount_paise: 0, taxable_paise: -10000, cgst_paise: -900, sgst_paise: -900, igst_paise: 0, cess_paise: 0, round_off_paise: 0, round_off_mode: 'none' as const, pre_round_total_paise: -11800, total_paise: -11800, paid_paise: 0, balance_paise: -11800, status: 'received' as const, reversed_by_purchase_id: null, reverses_purchase_id: 'original', notes: '', attachment_id: null, journal_entry_id: 'je-return', created_at: now, updated_at: now, entity_version: 1 } satisfies Purchase;
    await db.purchases.add(purchase); await db.purchase_lines.add({ id: 'return-line', business_id: businessId, purchase_id: purchase.id, line_no: 1, item_id: 'item', description: 'Widget', hsn: '8471', warehouse_id: '', qty_micros: -1_000_000, unit_cost_paise: 10000, discount_paise: 0, taxable_paise: -10000, tax_rate_bps: 1800, cgst_paise: -900, sgst_paise: -900, igst_paise: 0, cess_paise: 0, line_total_paise: -11800 });
    const report = await buildGstrReport(businessId, 'gstr2', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.b2b.rows[0]['Bill Value']).toBe(-118);
    expect(report.sections.hsn.rows[0]['Taxable Value']).toBe(-100);
    await db.delete();
  });

  it('routes registered and unregistered sales notes and reconciles note documents', async () => {
    const db = new BusinessVaultDB(`gstr-notes-${Date.now()}`);
    const registered: Customer = { id: 'registered', business_id: businessId, name: 'Registered', phone: '', email: '', gstin: '08BBBBB0000B1Z0', billing_address: '', shipping_address: '', state: 'Rajasthan', state_code: '08', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    const unregistered: Customer = { ...registered, id: 'unregistered', name: 'Cash buyer', gstin: null };
    await seedCatalog(db, [registered, unregistered]);
    const b2b = invoice('note-b2b', registered.id, '0100', 11800, 0);
    const b2cs = invoice('note-b2cs', unregistered.id, '0101', 10000, 0);
    const b2cl = invoice('note-b2cl', unregistered.id, '0102', 11800001, 1);
    await db.invoices.bulkAdd([b2b, b2cs, b2cl]);
    await db.invoice_lines.bulkAdd([invoiceLine('note-l1', b2b.id, 10000), invoiceLine('note-l2', b2cs.id, 8474), invoiceLine('note-l3', b2cl.id, 8474577)]);
    await db.sales_returns.bulkAdd([
      salesReturn('cn-registered', 'CN-REG', registered.id, b2b.id, 1000),
      salesReturn('cn-b2cl', 'CN-B2CL', unregistered.id, b2cl.id, 1000),
      salesReturn('cn-b2cs', 'CN-B2CS', unregistered.id, b2cs.id, 1000),
    ]);
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.cdnr.rows.map((row) => row['Note Number'])).toEqual(['CN-REG']);
    expect(report.sections.cdnur.rows.map((row) => row['Note Number'])).toEqual(['CN-B2CL']);
    expect(report.sections.b2cs.rows).toHaveLength(1);
    expect(report.sections.b2cs.rows[0]['Taxable Value']).toBeCloseTo(74.74, 2);
    expect(report.sections.docs.rows[1]['Total documents issued']).toBe(3);
    expect(report.reconciliationIssues?.some((issue) => issue.message.includes('cannot be placed in cdnr'))).toBe(false);
    await db.delete();
  });

  it('warns without classifying a note when category fields are insufficient', async () => {
    const db = new BusinessVaultDB(`gstr-note-warning-${Date.now()}`);
    const customer: Customer = { id: 'unregistered', business_id: businessId, name: 'Cash buyer', phone: '', email: '', gstin: null, billing_address: '', shipping_address: '', state: '', state_code: '', opening_balance_paise: 0, credit_limit_paise: 0, notes: '', active: 1, created_at: now, updated_at: now, entity_version: 1 };
    await seedCatalog(db, [customer]);
    await db.sales_returns.add(salesReturn('cn-missing', 'CN-MISSING', customer.id, 'missing-original', 1000));
    const report = await buildGstrReport(businessId, 'gstr1', '2026-08-01', '2026-08-31', { db });
    expect(report.sections.cdnr.rows).toHaveLength(0);
    expect(report.sections.cdnur.rows).toHaveLength(0);
    expect(report.sections.b2cs.rows).toHaveLength(0);
    expect(report.reconciliationIssues?.find((issue) => issue.documentNumber === 'CN-MISSING')?.message).toContain('missing place of supply and original invoice context');
    await db.delete();
  });
});
