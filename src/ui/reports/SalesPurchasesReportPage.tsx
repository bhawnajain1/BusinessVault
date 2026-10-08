import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Supplier } from '../../db/types';
import { buildSalesPurchaseReport, type PurchaseReportBill, type SalesReportInvoice } from '../../domain/salesPurchaseReport';
import { downloadCsv } from '../../csv/streamCsvExport';
import { money, toDateString, financialYearStart } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { ReportTableToolbar, useReportTableControls } from './reportTableControls';

interface SalesRow {
  id: string;
  date: string;
  number: string;
  party: string;
  total_paise: number;
}

interface PurchaseRow {
  id: string;
  date: string;
  number: string;
  party: string;
  total_paise: number;
}

export default function SalesPurchasesReportPage() {
  const { businessId, error: bizError } = useBusinessId();
  const today = new Date();
  const [fromYmd, setFromYmd] = useState(toDateString(financialYearStart(today)));
  const [toYmd, setToYmd] = useState(toDateString(today));
  const [invoices, setInvoices] = useState<SalesReportInvoice[]>([]);
  const [purchases, setPurchases] = useState<PurchaseReportBill[]>([]);
  const [customerNameById, setCustomerNameById] = useState<Map<string, string>>(new Map());
  const [supplierNameById, setSupplierNameById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    if (fromYmd && toYmd && fromYmd > toYmd) {
      setInvoices([]);
      setPurchases([]);
      setLoading(false);
      return () => {
        alive = false;
      };
    }

    const invoiceQuery = fromYmd || toYmd
      ? db.invoices
          .where('[business_id+invoice_date]')
          .between([businessId, fromYmd || ''], [businessId, toYmd || '9999-12-31'], true, true)
          .toArray()
      : db.invoices.where('business_id').equals(businessId).toArray();
    const purchaseQuery = fromYmd || toYmd
      ? db.purchases
          .where('[business_id+bill_date]')
          .between([businessId, fromYmd || ''], [businessId, toYmd || '9999-12-31'], true, true)
          .toArray()
      : db.purchases.where('business_id').equals(businessId).toArray();

    void Promise.all([
      invoiceQuery,
      purchaseQuery,
      db.customers.where('business_id').equals(businessId).toArray(),
      db.suppliers.where('business_id').equals(businessId).toArray(),
    ])
      .then(([invoiceRows, purchaseRows, customers, suppliers]) => {
        if (!alive) return;
        setInvoices(invoiceRows);
        setPurchases(purchaseRows);
        setCustomerNameById(new Map(customers.map((customer: Customer) => [customer.id, customer.name])));
        setSupplierNameById(new Map(suppliers.map((supplier: Supplier) => [supplier.id, supplier.name])));
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, fromYmd, toYmd]);

  const report = useMemo(
    () => buildSalesPurchaseReport(invoices, purchases, fromYmd, toYmd),
    [invoices, purchases, fromYmd, toYmd],
  );
  const salesRows = useMemo<SalesRow[]>(
    () => report.sales.map((invoice) => ({
      id: invoice.id,
      date: invoice.invoice_date,
      number: invoice.invoice_number,
      party: customerNameById.get(invoice.customer_id) ?? '(unknown customer)',
      total_paise: invoice.total_paise,
    })),
    [report.sales, customerNameById],
  );
  const purchaseRows = useMemo<PurchaseRow[]>(
    () => report.purchases.map((purchase) => ({
      id: purchase.id,
      date: purchase.bill_date,
      number: purchase.bill_number,
      party: supplierNameById.get(purchase.supplier_id) ?? '(unknown supplier)',
      total_paise: purchase.total_paise,
    })),
    [report.purchases, supplierNameById],
  );
  const salesControls = useReportTableControls(
    salesRows,
    (row) => `${row.date} ${row.number} ${row.party}`,
    (row, key) => key === 'date' ? row.date : key === 'party' ? row.party : key === 'total' ? row.total_paise : row.number,
    { key: 'date', direction: 'desc' },
  );
  const purchaseControls = useReportTableControls(
    purchaseRows,
    (row) => `${row.date} ${row.number} ${row.party}`,
    (row, key) => key === 'date' ? row.date : key === 'party' ? row.party : key === 'total' ? row.total_paise : row.number,
    { key: 'date', direction: 'desc' },
  );

  async function exportSales(): Promise<void> {
    await downloadCsv({
      columns: ['date', 'invoice_number', 'customer', 'total'],
      rows: salesRows,
      toRow: (row) => ({
        date: row.date,
        invoice_number: row.number,
        customer: row.party,
        total: (row.total_paise / 100).toFixed(2),
      }),
      filename: `sales-${fromYmd || 'all'}-to-${toYmd || 'all'}.csv`,
    });
  }

  async function exportPurchases(): Promise<void> {
    await downloadCsv({
      columns: ['date', 'bill_number', 'supplier', 'total'],
      rows: purchaseRows,
      toRow: (row) => ({
        date: row.date,
        bill_number: row.number,
        supplier: row.party,
        total: (row.total_paise / 100).toFixed(2),
      }),
      filename: `purchases-${fromYmd || 'all'}-to-${toYmd || 'all'}.csv`,
    });
  }

  const invalidRange = !!fromYmd && !!toYmd && fromYmd > toYmd;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sales &amp; Purchases</h1>
          <p className="text-sm text-slate-500">Totals and month-wise activity for the selected dates. Drafts, cancellations, and reversals are excluded.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">From</span>
            <input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">To</span>
            <input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-sm" />
          </label>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {invalidRange && <div role="alert" className="text-amber-700 text-sm">The start date must be on or before the end date.</div>}
      {loading && <div className="text-slate-500 text-sm">Loading report...</div>}

      <section className="grid gap-3 sm:grid-cols-2" aria-label="Selected date totals">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="text-sm font-medium text-blue-800">Total sales</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-blue-950">{money(report.sales_total_paise)}</div>
          <div className="mt-1 text-xs text-blue-700">{report.sales.length} invoices in range</div>
        </div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-sm font-medium text-emerald-800">Total purchases</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-950">{money(report.purchases_total_paise)}</div>
          <div className="mt-1 text-xs text-emerald-700">{report.purchases.length} bills in range</div>
        </div>
      </section>

      <section aria-label="Month-wise sales and purchases" className="grid gap-4 lg:grid-cols-2">
        <MonthlyTotalsTable title="Sales by month" countLabel="Invoices" rows={report.monthly_sales} empty="No sales in this date range." />
        <MonthlyTotalsTable title="Purchases by month" countLabel="Bills" rows={report.monthly_purchases} empty="No purchases in this date range." />
      </section>

      <section className="space-y-2" aria-labelledby="sales-register-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="sales-register-heading" className="text-lg font-semibold">Sales details</h2>
            <p className="text-xs text-slate-500">Total for selected range: {money(report.sales_total_paise)}</p>
          </div>
          <button onClick={() => void exportSales()} disabled={salesRows.length === 0} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50">Export sales CSV</button>
        </div>
        <div className="overflow-auto border border-slate-200 rounded bg-white">
          <div className="p-3 pb-0"><ReportTableToolbar query={salesControls.query} onQueryChange={salesControls.setQuery} sort={salesControls.sort} onSortChange={salesControls.setSort} options={[{ key: 'date', label: 'Date' }, { key: 'number', label: 'Invoice number' }, { key: 'party', label: 'Customer' }, { key: 'total', label: 'Total' }]} /></div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr><th className="text-left px-3 py-2">Date</th><th className="text-left px-3 py-2">Invoice #</th><th className="text-left px-3 py-2">Customer</th><th className="text-right px-3 py-2">Total</th></tr></thead>
            <tbody>
              {salesControls.filteredRows.map((row) => <tr key={row.id} className="border-t border-slate-100"><td className="px-3 py-2">{row.date}</td><td className="px-3 py-2"><Link to={`/invoices/${row.id}`} className="text-blue-700 hover:underline">{row.number}</Link></td><td className="px-3 py-2">{row.party}</td><td className="px-3 py-2 text-right tabular-nums">{money(row.total_paise)}</td></tr>)}
              {salesControls.filteredRows.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">No sales match this date range and filter.</td></tr>}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold"><tr><td colSpan={3} className="px-3 py-2 text-right">Total sales</td><td className="px-3 py-2 text-right tabular-nums">{money(report.sales_total_paise)}</td></tr></tfoot>
          </table>
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="purchase-register-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="purchase-register-heading" className="text-lg font-semibold">Purchase details</h2>
            <p className="text-xs text-slate-500">Total for selected range: {money(report.purchases_total_paise)}</p>
          </div>
          <button onClick={() => void exportPurchases()} disabled={purchaseRows.length === 0} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50">Export purchases CSV</button>
        </div>
        <div className="overflow-auto border border-slate-200 rounded bg-white">
          <div className="p-3 pb-0"><ReportTableToolbar query={purchaseControls.query} onQueryChange={purchaseControls.setQuery} sort={purchaseControls.sort} onSortChange={purchaseControls.setSort} options={[{ key: 'date', label: 'Date' }, { key: 'number', label: 'Bill number' }, { key: 'party', label: 'Supplier' }, { key: 'total', label: 'Total' }]} /></div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr><th className="text-left px-3 py-2">Date</th><th className="text-left px-3 py-2">Bill #</th><th className="text-left px-3 py-2">Supplier</th><th className="text-right px-3 py-2">Total</th></tr></thead>
            <tbody>
              {purchaseControls.filteredRows.map((row) => <tr key={row.id} className="border-t border-slate-100"><td className="px-3 py-2">{row.date}</td><td className="px-3 py-2"><Link to={`/purchases/${row.id}`} className="text-blue-700 hover:underline">{row.number}</Link></td><td className="px-3 py-2">{row.party}</td><td className="px-3 py-2 text-right tabular-nums">{money(row.total_paise)}</td></tr>)}
              {purchaseControls.filteredRows.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">No purchases match this date range and filter.</td></tr>}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold"><tr><td colSpan={3} className="px-3 py-2 text-right">Total purchases</td><td className="px-3 py-2 text-right tabular-nums">{money(report.purchases_total_paise)}</td></tr></tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}

function MonthlyTotalsTable({
  title,
  countLabel,
  rows,
  empty,
}: {
  title: string;
  countLabel: string;
  rows: Array<{ key: string; label: string; count: number; total_paise: number }>;
  empty: string;
}) {
  return (
    <div className="overflow-auto rounded border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 bg-slate-50 px-3 py-2 font-semibold">{title}</h2>
      <table className="min-w-full text-sm">
        <thead className="text-slate-600"><tr><th className="text-left px-3 py-2">Month</th><th className="text-right px-3 py-2">{countLabel}</th><th className="text-right px-3 py-2">Total</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.key} className="border-t border-slate-100"><td className="px-3 py-2">{row.label}</td><td className="px-3 py-2 text-right tabular-nums">{row.count}</td><td className="px-3 py-2 text-right tabular-nums">{money(row.total_paise)}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={3} className="px-3 py-5 text-center text-slate-400">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
