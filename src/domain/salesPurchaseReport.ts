import type { Invoice, Purchase } from '../db/types';
import { isLiveInvoice, isLivePurchase } from './dashboardStats';

export type SalesReportInvoice = Pick<
  Invoice,
  | 'id'
  | 'invoice_number'
  | 'invoice_date'
  | 'customer_id'
  | 'total_paise'
  | 'status'
  | 'deleted_at'
  | 'reverses_invoice_id'
  | 'reversed_by_invoice_id'
>;

export type PurchaseReportBill = Pick<
  Purchase,
  | 'id'
  | 'bill_number'
  | 'bill_date'
  | 'supplier_id'
  | 'total_paise'
  | 'status'
  | 'reverses_purchase_id'
  | 'reversed_by_purchase_id'
  | 'replaced_by_purchase_id'
>;

export interface MonthlyDocumentTotal {
  key: string;
  label: string;
  count: number;
  total_paise: number;
}

export interface SalesPurchaseReport {
  sales: SalesReportInvoice[];
  purchases: PurchaseReportBill[];
  sales_total_paise: number;
  purchases_total_paise: number;
  monthly_sales: MonthlyDocumentTotal[];
  monthly_purchases: MonthlyDocumentTotal[];
}

export function buildSalesPurchaseReport(
  invoices: SalesReportInvoice[],
  purchases: PurchaseReportBill[],
  fromYmd: string,
  toYmd: string,
): SalesPurchaseReport {
  const validRange = !fromYmd || !toYmd || fromYmd <= toYmd;
  const sales = validRange
    ? invoices.filter(
        (invoice) =>
          isLiveInvoice(invoice) &&
          invoice.status !== 'draft' &&
          invoice.status !== 'cancelled' &&
          (!fromYmd || invoice.invoice_date >= fromYmd) &&
          (!toYmd || invoice.invoice_date <= toYmd),
      )
    : [];
  const livePurchases = validRange
    ? purchases.filter(
        (purchase) =>
          isLivePurchase(purchase) &&
          purchase.status !== 'draft' &&
          (!fromYmd || purchase.bill_date >= fromYmd) &&
          (!toYmd || purchase.bill_date <= toYmd),
      )
    : [];
  const monthlyTotals = (rows: Array<{ date: string; total_paise: number }>) => {
    const byMonth = new Map<string, MonthlyDocumentTotal>();
    for (const row of rows) {
      const key = row.date.slice(0, 7);
      const month = byMonth.get(key) ?? {
        key,
        label: new Intl.DateTimeFormat('en', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(`${key}-01T00:00:00Z`)),
        count: 0,
        total_paise: 0,
      };
      month.count += 1;
      month.total_paise += row.total_paise;
      byMonth.set(key, month);
    }
    return [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key));
  };

  return {
    sales,
    purchases: livePurchases,
    sales_total_paise: sales.reduce((sum, invoice) => sum + invoice.total_paise, 0),
    purchases_total_paise: livePurchases.reduce(
      (sum, purchase) => sum + purchase.total_paise,
      0,
    ),
    monthly_sales: monthlyTotals(
      sales.map((invoice) => ({ date: invoice.invoice_date, total_paise: invoice.total_paise })),
    ),
    monthly_purchases: monthlyTotals(
      livePurchases.map((purchase) => ({ date: purchase.bill_date, total_paise: purchase.total_paise })),
    ),
  };
}
