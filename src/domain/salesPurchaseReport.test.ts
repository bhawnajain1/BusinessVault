import { describe, expect, it } from 'vitest';
import { buildSalesPurchaseReport, type PurchaseReportBill, type SalesReportInvoice } from './salesPurchaseReport';

function invoice(
  id: string,
  date: string,
  total: number,
  overrides: Partial<SalesReportInvoice> = {},
): SalesReportInvoice {
  return {
    id,
    invoice_number: `INV-${id}`,
    invoice_date: date,
    customer_id: 'customer-1',
    total_paise: total,
    status: 'issued',
    deleted_at: null,
    reverses_invoice_id: null,
    reversed_by_invoice_id: null,
    ...overrides,
  };
}

function purchase(
  id: string,
  date: string,
  total: number,
  overrides: Partial<PurchaseReportBill> = {},
): PurchaseReportBill {
  return {
    id,
    bill_number: `BILL-${id}`,
    bill_date: date,
    supplier_id: 'supplier-1',
    total_paise: total,
    status: 'received',
    reverses_purchase_id: null,
    reversed_by_purchase_id: null,
    replaced_by_purchase_id: null,
    ...overrides,
  };
}

describe('buildSalesPurchaseReport', () => {
  it('keeps sales and purchases in separate monthly totals across months', () => {
    const report = buildSalesPurchaseReport(
      [
        invoice('aug-sale', '2026-08-03', 10000),
        invoice('sep-sale', '2026-09-03', 20000),
        invoice('oct-sale', '2026-10-03', 30000),
      ],
      [
        purchase('aug-purchase', '2026-08-05', 4000),
        purchase('sep-purchase', '2026-09-05', 8000),
        purchase('oct-purchase', '2026-10-05', 12000),
      ],
      '2026-08-01',
      '2026-09-30',
    );

    expect(report.sales_total_paise).toBe(30000);
    expect(report.purchases_total_paise).toBe(12000);
    expect(report.monthly_sales.map(({ label, total_paise }) => [label, total_paise])).toEqual([
      ['August 2026', 10000],
      ['September 2026', 20000],
    ]);
    expect(report.monthly_purchases.map(({ label, total_paise }) => [label, total_paise])).toEqual([
      ['August 2026', 4000],
      ['September 2026', 8000],
    ]);
  });

  it('totals live sales and purchases in the selected range by month separately', () => {
    const report = buildSalesPurchaseReport(
      [
        invoice('s1', '2026-08-03', 10000),
        invoice('s2', '2026-08-20', 5000),
        invoice('s3', '2026-09-01', 9000),
        invoice('draft', '2026-08-10', 4000, { status: 'draft' }),
        invoice('deleted', '2026-08-11', 3000, { deleted_at: '2026-08-12T00:00:00Z' }),
        invoice('credit', '2026-08-12', -1000, { reverses_invoice_id: 's1' }),
      ],
      [
        purchase('p1', '2026-08-05', 7000),
        purchase('p2', '2026-08-25', 2000),
        purchase('p3', '2026-09-01', 6000),
        purchase('draft', '2026-08-10', 1000, { status: 'draft' }),
        purchase('cancelled', '2026-08-11', 1000, { status: 'cancelled' }),
        purchase('debit', '2026-08-12', -500, { reverses_purchase_id: 'p1' }),
        purchase('replaced', '2026-08-13', 1000, { replaced_by_purchase_id: 'new-purchase' }),
      ],
      '2026-08-01',
      '2026-08-31',
    );

    expect(report.sales.map((row) => row.id)).toEqual(['s1', 's2']);
    expect(report.purchases.map((row) => row.id)).toEqual(['p1', 'p2']);
    expect(report.sales_total_paise).toBe(15000);
    expect(report.purchases_total_paise).toBe(9000);
    expect(report.monthly_sales).toEqual([
      { key: '2026-08', label: 'August 2026', count: 2, total_paise: 15000 },
    ]);
    expect(report.monthly_purchases).toEqual([
      { key: '2026-08', label: 'August 2026', count: 2, total_paise: 9000 },
    ]);
  });

  it('returns no activity when the selected start date is after the end date', () => {
    const report = buildSalesPurchaseReport(
      [invoice('s1', '2026-08-03', 10000)],
      [purchase('p1', '2026-08-05', 7000)],
      '2026-08-31',
      '2026-08-01',
    );

    expect(report.sales).toEqual([]);
    expect(report.purchases).toEqual([]);
    expect(report.sales_total_paise).toBe(0);
    expect(report.purchases_total_paise).toBe(0);
  });
});
