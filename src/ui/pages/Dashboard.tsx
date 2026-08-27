import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import Money from '../components/Money';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import {
  computeDashboardStats,
  type DashboardStats,
} from '../../domain/dashboardStats';
import { log } from '../../lib/log';

export default function Dashboard() {
  const { businessId, loading } = useActiveBusiness();
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      // Thin shim: load rows, hand to the pure computeDashboardStats. All
      // filtering / derivation lives in src/domain/dashboardStats.ts so
      // it can be unit-tested without React. Prior regression (PR #52):
      // summing raw `balance_paise` double-counted rename-edit trios.
      const [invoices, purchases, customers, suppliers, advances, itemCount] =
        await Promise.all([
          db.invoices.where('business_id').equals(businessId).toArray(),
          db.purchases.where('business_id').equals(businessId).toArray(),
          db.customers.where('business_id').equals(businessId).toArray(),
          db.suppliers.where('business_id').equals(businessId).toArray(),
          db.advances.where('business_id').equals(businessId).toArray(),
          db.items.where('business_id').equals(businessId).count(),
        ]);

      const asOfYmd = new Date().toISOString().slice(0, 10);
      const computed = computeDashboardStats({
        invoices,
        purchases,
        customers,
        suppliers,
        advances,
        itemCount,
        asOfYmd,
      });

      log.info('dashboard', 'stats computed', {
        businessId,
        asOfYmd,
        liveInvoices: computed.invoices,
        livePurchases: computed.purchases,
        outstandingReceivablesPaise: computed.outstandingReceivablesPaise,
        outstandingPayablesPaise: computed.outstandingPayablesPaise,
        advanceCount: advances.length,
        ...computed.diagnostics,
      });

      // If the gap between raw rows and live rows is unusually large,
      // shout so a debug-bundle reader notices immediately instead of
      // scrolling. Threshold picked empirically: >5 hidden rows per live
      // row is almost certainly a bug (excessive supersedes, corrupted
      // credit-note pairing, or a missing filter).
      const hiddenInv =
        computed.diagnostics.rawInvoiceRows - computed.invoices;
      if (
        computed.invoices > 0 &&
        hiddenInv > 5 * computed.invoices &&
        hiddenInv > 5
      ) {
        log.warn('dashboard', 'unusually large hidden-invoice gap', {
          businessId,
          liveInvoices: computed.invoices,
          hiddenInvoices: hiddenInv,
          supersededInvoices: computed.diagnostics.supersededInvoices,
          creditNotes: computed.diagnostics.creditNotes,
          recycledInvoices: computed.diagnostics.recycledInvoices,
        });
      }

      setStats(computed);
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
