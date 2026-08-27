import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import Money from '../components/Money';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { computePayables, computeReceivables } from '../../domain/partyLedger';
import { log } from '../../lib/log';

interface DashboardStats {
  invoices: number;
  customers: number;
  suppliers: number;
  items: number;
  purchases: number;
  outstandingReceivablesPaise: number;
  outstandingPayablesPaise: number;
  recentInvoices: Array<{
    id: string;
    number: string;
    date: string;
    total_paise: number;
    balance_paise: number;
    customerName: string;
  }>;
}

export default function Dashboard() {
  const { businessId, loading } = useActiveBusiness();
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      // Load everything computeReceivables/computePayables need: invoices,
      // purchases, advances, customers, suppliers. The naive prior version
      // summed `balance_paise` across raw rows — that double-counts a
      // rename-edit trio (original + auto credit-note + reissue) because the
      // reversed original's `balance_paise` is left untouched by design (§9
      // preserves the append-only journal). Using the same derivation as the
      // Receivables/Payables report guarantees the dashboard number matches
      // the report and correctly nets credit notes / advances / opening.
      const [
        invoiceRows,
        purchaseRows,
        customers,
        suppliers,
        advances,
        itemCount,
      ] = await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.purchases.where('business_id').equals(businessId).toArray(),
        db.customers.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.advances.where('business_id').equals(businessId).toArray(),
        db.items.where('business_id').equals(businessId).count(),
      ]);

      // Live invoice = not superseded by an edit, not a credit note, not
      // soft-deleted (recycled). This mirrors the InvoicesPage default filter
      // (`!showVoided`) so the two counts stay in sync.
      const liveInvoices = invoiceRows.filter(
        (i) =>
          !i.reversed_by_invoice_id &&
          !i.reverses_invoice_id &&
          !i.deleted_at &&
          i.status !== 'cancelled' &&
          i.status !== 'draft',
      );
      const livePurchases = purchaseRows.filter(
        (p) =>
          !p.reversed_by_purchase_id &&
          !p.reverses_purchase_id &&
          p.status !== 'cancelled' &&
          p.status !== 'draft',
      );

      const asOfYmd = new Date().toISOString().slice(0, 10);
      const ar = computeReceivables(invoiceRows, asOfYmd, advances, customers);
      const ap = computePayables(purchaseRows, asOfYmd, advances, suppliers);
      const outstandingReceivablesPaise = ar.totals.outstanding_paise;
      const outstandingPayablesPaise = ap.totals.outstanding_paise;

      log.info('dashboard', 'stats computed', {
        businessId,
        rawInvoiceRows: invoiceRows.length,
        liveInvoices: liveInvoices.length,
        rawPurchaseRows: purchaseRows.length,
        livePurchases: livePurchases.length,
        outstandingReceivablesPaise,
        outstandingPayablesPaise,
        advances: advances.length,
      });

      const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

      const recentInvoices = [...liveInvoices]
        .sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1))
        .slice(0, 5)
        .map((i) => ({
          id: i.id,
          number: i.invoice_number,
          date: i.invoice_date,
          total_paise: i.total_paise,
          balance_paise: i.balance_paise,
          customerName: customerNameById.get(i.customer_id) ?? '—',
        }));

      setStats({
        invoices: liveInvoices.length,
        customers: customers.length,
        suppliers: suppliers.length,
        items: itemCount,
        purchases: livePurchases.length,
        outstandingReceivablesPaise,
        outstandingPayablesPaise,
        recentInvoices,
      });
    })();
  }, [businessId]);

  if (loading) return <div className="p-6 text-slate-500">Loading...</div>;

  if (!businessId) {
    return (
      <div className="p-6 text-slate-600">
        <p>No business found. Complete onboarding to get started.</p>
        <Link
          to="/onboarding"
          className="mt-3 inline-block rounded bg-slate-900 px-4 py-2 text-sm text-white"
        >
          Start onboarding
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="Invoices" value={stats?.invoices ?? '—'} to="/invoices" />
        <Card label="Customers" value={stats?.customers ?? '—'} to="/customers" />
        <Card label="Suppliers" value={stats?.suppliers ?? '—'} to="/suppliers" />
        <Card label="Items" value={stats?.items ?? '—'} to="/items" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="border border-slate-200 rounded p-4 bg-white">
          <div className="text-sm text-slate-600">Outstanding receivables</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">
            {stats ? <Money paise={stats.outstandingReceivablesPaise} /> : '—'}
          </div>
          <Link
            to="/invoices"
            className="mt-2 inline-block text-sm text-blue-700 hover:underline"
          >
            View invoices →
          </Link>
        </div>
        <div className="border border-slate-200 rounded p-4 bg-white">
          <div className="text-sm text-slate-600">Outstanding payables</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">
            {stats ? <Money paise={stats.outstandingPayablesPaise} /> : '—'}
          </div>
          <Link
            to="/purchases"
            className="mt-2 inline-block text-sm text-blue-700 hover:underline"
          >
            View purchases →
          </Link>
        </div>
      </div>

      <div className="border border-slate-200 rounded bg-white">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">Recent invoices</h2>
          <Link to="/pos" className="text-sm text-blue-700 hover:underline">
            + New invoice
          </Link>
        </div>
        {stats && stats.recentInvoices.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">No invoices yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-slate-600 border-b border-slate-100">
              <tr>
                <th className="px-4 py-2">Number</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {stats?.recentInvoices.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-4 py-2">
                    <Link to={`/invoices/${r.id}`} className="text-blue-700 hover:underline">
                      {r.number}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{r.date}</td>
                  <td className="px-4 py-2">{r.customerName}</td>
                  <td className="px-4 py-2 text-right"><Money paise={r.total_paise} /></td>
                  <td className="px-4 py-2 text-right"><Money paise={r.balance_paise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Link to="/pos" className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800">
          New invoice
        </Link>
        <Link to="/purchases" className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100">
          New purchase
        </Link>
        <Link to="/reports" className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100">
          Reports
        </Link>
        <Link to="/settings/backup" className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100">
          Backup status
        </Link>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  to,
}: {
  label: string;
  value: number | string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="block border border-slate-200 rounded p-4 bg-white hover:border-slate-400 hover:shadow-sm transition"
    >
      <div className="text-sm text-slate-600">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </Link>
  );
}
