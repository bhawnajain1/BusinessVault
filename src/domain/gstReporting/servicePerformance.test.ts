// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { BusinessVaultDB } from '../../db/database';
import type { Business, Customer, Invoice, InvoiceLine, Purchase, PurchaseLine, Supplier } from '../../db/types';
import { computeGstinCheckChar } from '../../lib/gst';
import { GstMonthlyReportService } from './GstMonthlyReportService';
import { GstReportingRepository } from '../../db/repos/gstReporting';

it('calculates exact independent months from 50k persisted outward and 50k inward lines with indexed history scoping and stable hashes', async () => {
  const now = '2025-06-30T12:00:00.000Z';
  const audit = { created_at: now, updated_at: now, entity_version: 1 };
  const businessId = 'synthetic-performance-business';
  const gstinBase = '27AAAAA0000A1Z';
  const gstin = gstinBase + computeGstinCheckChar(gstinBase);
  const db = new BusinessVaultDB(`gst-service-performance-${crypto.randomUUID()}`);
  const invoices: Invoice[] = [];
  const purchases: Purchase[] = [];
  const invoiceLines: InvoiceLine[] = [];
  const purchaseLines: PurchaseLine[] = [];
  try {
    await db.businesses.add({ id: businessId, name: 'Synthetic performance business', gstin, state_code: '27', ...audit } as Business);
    await db.customers.add({ id: 'customer', business_id: businessId, name: 'Synthetic customer', gstin, state_code: '27', ...audit } as Customer);
    await db.suppliers.add({ id: 'supplier', business_id: businessId, name: 'Synthetic supplier', gstin, state_code: '27', ...audit } as Supplier);
    const service = new GstMonthlyReportService(db, 'performance-test', () => now);
    await service.saveProfile({ business_id: businessId, gstin, legal_name: 'Synthetic performance business', state_code: '27',
      registration_type: 'REGULAR', registration_start_date: null, registration_end_date: null, filing_frequency: 'MONTHLY',
      gst_reporting_enabled: 1, effective_from: '2020-04-01', effective_to: null, active: 1 });
    await service.setAato({ business_id: businessId, financial_year: '2024-25', aato_paise: 10_000_000,
      source: 'USER_CONFIRMED', confirmed_at: now, notes: 'Synthetic fixture' });

    // 1,000 selected documents per direction, each with 50 lines. Another 200
    // documents per direction are history, including same-FY identity evidence.
    for (let doc = 0; doc < 1200; doc++) {
      const selected = doc < 1000;
      const month = doc % 2 === 0 ? '2025-05' : '2025-06';
      const date = selected ? `${month}-01` : doc % 2 === 0 ? '2023-04-01' : '2025-07-01';
      const fy = date.startsWith('2023') ? '2023-24' : '2025-26';
      const id = `${selected ? 'selected' : 'history'}-${String(doc).padStart(6, '0')}`;
      const outwardUnit = month === '2025-05' ? 100 : 200;
      const inwardUnit = outwardUnit * 2;
      // Half the lines are 5%, half 18%; these values divide exactly in paise.
      const outwardTax = outwardUnit * 25 * 2300 / 10000;
      const inwardTax = inwardUnit * 25 * 2300 / 10000;
      const outwardTotal = outwardUnit * 50 + outwardTax;
      const inwardTotal = inwardUnit * 50 + inwardTax;
      invoices.push({ id: `invoice-${id}`, business_id: businessId, invoice_number: `INV-${String(doc + 1).padStart(6, '0')}`,
        invoice_date: date, due_date: null, customer_id: 'customer', customer_state_code: '27', place_of_supply: '27',
        is_interstate: 0, financial_year: fy, subtotal_paise: outwardUnit * 50, discount_paise: 0, taxable_paise: outwardUnit * 50,
        cgst_paise: outwardTax / 2, sgst_paise: outwardTax / 2, igst_paise: 0, cess_paise: 0, round_off_paise: 0,
        round_off_mode: 'none', pre_round_total_paise: outwardTotal, total_paise: outwardTotal, paid_paise: 0,
        balance_paise: outwardTotal, status: 'issued', reversed_by_invoice_id: null, reverses_invoice_id: null,
        notes: '', terms: '', pdf_attachment_id: null, journal_entry_id: '', ...audit });
      purchases.push({ id: `purchase-${id}`, business_id: businessId, bill_number: `BILL-${String(doc + 1).padStart(6, '0')}`,
        supplier_bill_number: `SUP-${String(doc + 1).padStart(6, '0')}`, bill_date: date, due_date: null, supplier_id: 'supplier',
        supplier_state_code: '27', is_interstate: 0, financial_year: fy, subtotal_paise: inwardUnit * 50, discount_paise: 0,
        taxable_paise: inwardUnit * 50, cgst_paise: inwardTax / 2, sgst_paise: inwardTax / 2, igst_paise: 0, cess_paise: 0,
        round_off_paise: 0, round_off_mode: 'none', pre_round_total_paise: inwardTotal, total_paise: inwardTotal,
        paid_paise: 0, balance_paise: inwardTotal, status: 'received', reversed_by_purchase_id: null,
        reverses_purchase_id: null, notes: '', attachment_id: null, journal_entry_id: '', ...audit });
      for (let line = 0; line < 50; line++) {
        const rate = line % 2 === 0 ? 500 : 1800;
        const snapshot = { business_id: businessId, line_no: line + 1, item_id: 'historical-item', description: 'Synthetic historical goods',
          hsn: rate === 500 ? '84713000' : '94031000', warehouse_id: '', qty_micros: 1_000_000, discount_paise: 0,
          tax_rate_bps: rate, igst_paise: 0, cess_paise: 0, uqc_code: 'NOS', goods_or_service: 'GOODS' as const,
          taxability: 'TAXABLE' as const, cess_rate_bps: 0, snapshot_source: 'NATIVE' as const };
        const outwardTax = outwardUnit * rate / 10000;
        const inwardTax = inwardUnit * rate / 10000;
        invoiceLines.push({ ...snapshot, id: `il-${id}-${line}`, invoice_id: `invoice-${id}`, unit_price_paise: outwardUnit,
          discount_pct_bps: 0, taxable_paise: outwardUnit, cgst_paise: Math.floor(outwardTax / 2),
          sgst_paise: outwardTax - Math.floor(outwardTax / 2), line_total_paise: outwardUnit + outwardTax });
        purchaseLines.push({ ...snapshot, id: `pl-${id}-${line}`, purchase_id: `purchase-${id}`, unit_cost_paise: inwardUnit,
          taxable_paise: inwardUnit, cgst_paise: Math.floor(inwardTax / 2), sgst_paise: inwardTax - Math.floor(inwardTax / 2),
          line_total_paise: inwardUnit + inwardTax });
      }
      // The odd-paise 5% line split must also be reflected in persisted headers.
      invoices[doc].cgst_paise = 25 * Math.floor(outwardUnit * 500 / 20000) + 25 * Math.floor(outwardUnit * 1800 / 20000);
      invoices[doc].sgst_paise = outwardTax - invoices[doc].cgst_paise;
    }
    await db.transaction('rw', db.invoices, db.purchases, async () => {
      await db.invoices.bulkAdd(invoices);
      await db.purchases.bulkAdd(purchases);
    });
    // Bounded fixture writes avoid fake-indexeddb's large transaction undo-log
    // cost. Seeding is deliberately outside the service timing window.
    for (let offset = 0; offset < invoiceLines.length; offset += 1000) {
      await db.invoice_lines.bulkAdd(invoiceLines.slice(offset, offset + 1000));
      await db.purchase_lines.bulkAdd(purchaseLines.slice(offset, offset + 1000));
    }
    console.info('GST persisted service benchmark: fixture persisted');
    expect(await db.invoice_lines.count()).toBe(60_000);
    expect(await db.purchase_lines.count()).toBe(60_000);
    expect(invoiceLines.filter(row => row.invoice_id.startsWith('invoice-selected-'))).toHaveLength(50_000);
    expect(purchaseLines.filter(row => row.purchase_id.startsWith('purchase-selected-'))).toHaveLength(50_000);
    db.close();
    await db.open();
    console.info('GST persisted service benchmark: database reopened');

    const invoiceWhere = vi.spyOn(db.invoices, 'where');
    const purchaseWhere = vi.spyOn(db.purchases, 'where');
    const invoiceLineWhere = vi.spyOn(db.invoice_lines, 'where');
    const purchaseLineWhere = vi.spyOn(db.purchase_lines, 'where');
    const invoiceScan = vi.spyOn(db.invoices, 'toArray');
    const purchaseScan = vi.spyOn(db.purchases, 'toArray');
    const invoiceLineScan = vi.spyOn(db.invoice_lines, 'toArray');
    const purchaseLineScan = vi.spyOn(db.purchase_lines, 'toArray');
    const eventCount = await db.sync_events.count();
    const loadMonth = vi.spyOn(GstReportingRepository.prototype, 'loadMonth');
    // Time the public service, not the pure engine: transaction, indexed reads,
    // normalization, calculation and canonical SHA-256 hashing are all included.
    const start = performance.now();
    console.info('GST persisted service benchmark: calculateMonths started');
    const results = await service.calculateMonths(businessId, ['2025-06', '2025-05']);
    const elapsedMs = performance.now() - start;
    console.info(`GST persisted service benchmark: ${elapsedMs.toFixed(1)} ms (50k outward + 50k inward selected lines; 20k history lines)`);
    // A broad smoke guard, not a speed target or browser responsiveness claim.
    expect(elapsedMs).toBeLessThan(45_000);
    expect(results.map(row => row.period.periodKey)).toEqual(['2025-05', '2025-06']);
    for (const [index, result] of results.entries()) {
      const factor = index + 1;
      const outward = { taxable_paise: 2_500_000 * factor, cgst_paise: index === 0 ? 137_500 : 287_500,
        sgst_paise: index === 0 ? 150_000 : 287_500, igst_paise: 0, cess_paise: 0,
        pre_round_total_paise: 2_787_500 * factor, round_off_paise: 0, total_paise: 2_787_500 * factor };
      const inward = { taxable_paise: 5_000_000 * factor, cgst_paise: 287_500 * factor, sgst_paise: 287_500 * factor,
        igst_paise: 0, cess_paise: 0, pre_round_total_paise: 5_575_000 * factor, round_off_paise: 0, total_paise: 5_575_000 * factor };
      expect(result.totals.outwardGross).toMatchObject({ ...outward, document_count: 500, party_count: 1 });
      expect(result.totals.outwardNet).toMatchObject(outward);
      expect(result.totals.inwardGross).toMatchObject({ ...inward, document_count: 500, party_count: 1 });
      expect(result.totals.inwardNet).toMatchObject(inward);
      expect(result.totals.booksItc.TOTAL_BOOKS_TAX).toMatchObject({ cgst_paise: inward.cgst_paise, sgst_paise: inward.sgst_paise });
      expect(result.totals.booksItc.UNREVIEWED).toMatchObject({ cgst_paise: inward.cgst_paise, sgst_paise: inward.sgst_paise });
      expect(result.totals.booksItc.NET_APPROVED).toMatchObject({ cgst_paise: 0, sgst_paise: 0 });
      expect(result.outwardRateRows).toHaveLength(1000);
      expect(result.inwardRateRows).toHaveLength(1000);
      for (const rows of [result.outwardHsnRows, result.inwardHsnRows]) {
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.hsn).sort()).toEqual(['84713000', '94031000']);
        expect(rows.map(row => row.tax_rate_bps).sort((a, b) => a - b)).toEqual([500, 1800]);
        expect(rows.reduce((sum, row) => sum + row.source_line_ids.length, 0)).toBe(25_000);
        expect(rows.reduce((sum, row) => sum + row.quantity_micros, 0)).toBe(25_000_000_000);
        const expected = rows === result.outwardHsnRows ? outward : inward;
        for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'cess_paise', 'total_paise'] as const) {
          expect(rows.reduce((sum, row) => sum + row[key], 0)).toBe(expected[key]);
        }
      }
      const sources = result.sourceManifest.filter(row => row.entity_type === 'INVOICE' || row.entity_type === 'PURCHASE');
      expect(sources).toHaveLength(1000);
      expect(sources.every(row => row.entity_id.includes('-selected-') && row.document_date === `${result.period.periodKey}-01`)).toBe(true);
      expect(sources.some(row => row.entity_id.includes('-history-'))).toBe(false);
      expect(result.sourceDataHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.issues.filter(row => row.severity === 'BLOCKING_ERROR')).toEqual([]);
      expect(result.reconciliations.length).toBeGreaterThan(0);
      expect(result.reconciliations.every(row => row.status === 'PASS' && Object.values(row.variance).every(value => value === 0))).toBe(true);
    }
    expect(invoiceWhere).toHaveBeenCalledWith('[business_id+invoice_date]');
    expect(purchaseWhere).toHaveBeenCalledWith('[business_id+bill_date]');
    expect(invoiceLineWhere).toHaveBeenCalledWith('invoice_id');
    expect(purchaseLineWhere).toHaveBeenCalledWith('purchase_id');
    expect(loadMonth).toHaveBeenCalledTimes(2);
    for (const spy of [invoiceWhere, purchaseWhere]) expect(spy).not.toHaveBeenCalledWith('business_id');
    for (const spy of [invoiceScan, purchaseScan, invoiceLineScan, purchaseLineScan]) expect(spy).not.toHaveBeenCalled();
    const repeated = await service.calculateMonths(businessId, ['2025-05', '2025-06']);
    expect(repeated.map(row => row.sourceDataHash)).toEqual(results.map(row => row.sourceDataHash));
    expect(repeated.map(row => row.totals)).toEqual(results.map(row => row.totals));
    expect(results[0].sourceDataHash).not.toBe(results[1].sourceDataHash);
    expect(await db.sync_events.count()).toBe(eventCount);
  } finally {
    vi.restoreAllMocks();
    await db.delete();
  }
}, 120_000);
