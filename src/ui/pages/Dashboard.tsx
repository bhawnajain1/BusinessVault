import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { db } from '../../db';
import Money from '../components/Money';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import {
  computeDashboardStats,
  type DashboardStats,
} from '../../domain/dashboardStats';
import { log } from '../../lib/log';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { profitAndLoss, type ProfitAndLoss } from '../../domain/AccountingService';

export default function Dashboard() {
  const { businessId, loading } = useActiveBusiness();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Good night';
  const stats = useLiveQuery<DashboardStats | null>(async () => {
    if (!businessId) return null;
      // Thin shim: load rows, hand to the pure computeDashboardStats. All
      // filtering / derivation lives in src/domain/dashboardStats.ts so
      // it can be unit-tested without React. Prior regression (PR #52):
      // summing raw `balance_paise` double-counted rename-edit trios.
      const [
        invoices,
        purchases,
        customers,
        suppliers,
        advances,
        salesReturns,
        payments,
        itemCount,
      ] =
        await Promise.all([
          db.invoices.where('business_id').equals(businessId).toArray(),
          db.purchases.where('business_id').equals(businessId).toArray(),
          db.customers.where('business_id').equals(businessId).toArray(),
          db.suppliers.where('business_id').equals(businessId).toArray(),
          db.advances.where('business_id').equals(businessId).toArray(),
          db.sales_returns.where('business_id').equals(businessId).toArray(),
          db.payments.where('business_id').equals(businessId).toArray(),
          db.items.where('business_id').equals(businessId).count(),
        ]);

      const asOfYmd = new Date().toISOString().slice(0, 10);
      const computed = computeDashboardStats({
        invoices,
        purchases,
        customers,
        suppliers,
        advances,
        salesReturns,
        payments,
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

      return computed;
  }, [businessId], null);
  const profitLoss = useLiveQuery<ProfitAndLoss | null>(async () => {
    if (!businessId) return null;
    const today = new Date();
    const financialYearStart = new Date(
      Date.UTC(today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1, 3, 1),
    );
    return profitAndLoss(businessId, financialYearStart, today);
  }, [businessId], null);

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
    <div className="dashboard-page">
      <div className="dashboard-hero">
        <div>
          <p className="dashboard-eyebrow">Overview</p>
          <h1 className="dashboard-title">{greeting}, here is your business pulse.</h1>
          <p className="dashboard-subtitle">Keep an eye on cash flow, open balances, and recent activity.</p>
        </div>
        <Link to="/invoices/new" className="dashboard-primary-action">
          + New invoice
        </Link>
      </div>

      <div className="dashboard-count-grid">
        <Card label="Invoices" value={stats?.invoices ?? '—'} to="/invoices" tone="blue" />
        <Card label="Customers" value={stats?.customers ?? '—'} to="/customers" tone="green" />
        <Card label="Suppliers" value={stats?.suppliers ?? '—'} to="/suppliers" tone="slate" />
        <Card label="Items" value={stats?.items ?? '—'} to="/items" tone="violet" />
      </div>

      <div className="dashboard-balance-grid">
        <div className="dashboard-balance-card dashboard-balance-receivable">
          <div className="dashboard-balance-icon" aria-hidden="true">▧</div>
          <div>
          <div className="dashboard-card-label">Outstanding receivables</div>
          <div className="dashboard-balance-value">
            {stats ? <Money paise={stats.outstandingReceivablesPaise} /> : '—'}
          </div>
          <Link
            to="/invoices"
            className="dashboard-card-link"
          >
            View invoices →
          </Link>
          </div>
        </div>
        <div className="dashboard-balance-card dashboard-balance-payable">
          <div className="dashboard-balance-icon" aria-hidden="true">▧</div>
          <div>
          <div className="dashboard-card-label">Outstanding payables</div>
          <div className="dashboard-balance-value">
            {stats ? <Money paise={stats.outstandingPayablesPaise} /> : '—'}
          </div>
          <Link
            to="/purchases"
            className="dashboard-card-link"
          >
            View purchases →
          </Link>
          </div>
        </div>
      </div>

      {stats && <AnalyticsPanel stats={stats} />}

      {stats && <FinancialOverview stats={stats} profitLoss={profitLoss ?? null} />}

      <div className="dashboard-recent-card">
        <div className="dashboard-section-heading">
          <h2>Recent invoices</h2>
           <Link to="/invoices/new" className="dashboard-card-link">
            + New invoice
          </Link>
        </div>
        {stats && stats.recentInvoices.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">No invoices yet.</div>
        ) : (
           <table className="dashboard-recent-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Customer</th>
                <th className="text-right">Total</th>
                <th className="text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {stats?.recentInvoices.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0">
                  <td>
                    <Link to={`/invoices/${r.id}`} className="text-blue-700 hover:underline">
                      {r.number}
                    </Link>
                  </td>
                  <td>{r.date}</td>
                  <td>{r.customerName}</td>
                  <td className="text-right"><Money paise={r.total_paise} /></td>
                  <td className="text-right"><Money paise={r.balance_paise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dashboard-quick-actions">
        <h2>Quick actions</h2>
        <div className="dashboard-quick-action-list">
        <Link to="/invoices/new" className="dashboard-quick-action dashboard-quick-action-primary">
          <span aria-hidden="true">+</span> New invoice
        </Link>
        <Link to="/purchases" className="dashboard-quick-action">
          <span aria-hidden="true">+</span> New purchase
        </Link>
        <Link to="/reports" className="dashboard-quick-action">
          <span aria-hidden="true">▥</span>
          Reports
        </Link>
        <Link to="/settings/backup" className="dashboard-quick-action">
          <span aria-hidden="true">☁</span>
          Backup status
        </Link>
        </div>
      </div>
    </div>
  );
}

function FinancialOverview({
  stats,
  profitLoss,
}: {
  stats: DashboardStats;
  profitLoss: ProfitAndLoss | null;
}) {
  const pnlRows = profitLoss
    ? [
        { label: 'Revenue', value: profitLoss.revenue_paise, color: 'bg-blue-600' },
        { label: 'COGS', value: profitLoss.cogs_paise, color: 'bg-amber-500' },
        { label: 'Operating expenses', value: profitLoss.operating_expenses_paise, color: 'bg-red-500' },
        { label: 'Other income', value: profitLoss.other_income_paise, color: 'bg-green-600' },
      ]
    : [];
  const balanceRows = [
    { label: 'Receivables', value: stats.outstandingReceivablesPaise, color: 'bg-blue-600' },
    { label: 'Payables', value: stats.outstandingPayablesPaise, color: 'bg-orange-500' },
  ];
  const balanceMax = Math.max(1, ...balanceRows.map((row) => row.value));

  return (
    <section className="dashboard-financial-grid" aria-label="Financial overview">
      <DashboardChartCard
        title="Profit & Loss"
        description="Current financial year"
        linkTo="/reports/pnl"
        linkLabel="View P&L report"
      >
        {!profitLoss ? <p className="text-sm text-slate-500">Loading...</p> : (
          <PnlDonut rows={pnlRows} netIncome={profitLoss.net_income_paise} />
        )}
      </DashboardChartCard>
      <DashboardChartCard
        title="Receivables & Payables"
        description="Open balances as of today"
        linkTo="/reports/receivables-payables"
        linkLabel="View receivables & payables"
      >
        <div className="space-y-5" role="img" aria-label="Receivables and payables comparison chart">
          {balanceRows.map((row) => (
            <DashboardBar key={row.label} {...row} max={balanceMax} />
          ))}
        </div>
      </DashboardChartCard>
    </section>
  );
}

function PnlDonut({
  rows,
  netIncome,
}: {
  rows: Array<{ label: string; value: number; color: string }>;
  netIncome: number;
}) {
  const positiveRows = rows.map((row) => ({ ...row, value: Math.max(0, row.value) }));
  const total = positiveRows.reduce((sum, row) => sum + row.value, 0);
  let cursor = 0;
  const stops = total > 0
    ? positiveRows.map((row) => {
        const start = cursor;
        cursor += (row.value / total) * 360;
        return `${colorFor(row.color)} ${start}deg ${cursor}deg`;
      })
    : ['#e2e8f0 0deg 360deg'];

  return (
    <div className="flex flex-wrap items-center justify-center gap-6" role="img" aria-label="Profit and loss circular chart">
      <div
        className="relative h-44 w-44 shrink-0 rounded-full"
        style={{ background: `conic-gradient(${stops.join(', ')})` }}
      >
        <div className="absolute inset-7 flex flex-col items-center justify-center rounded-full bg-white text-center">
          <span className="text-xs text-slate-500">Net income</span>
          <span className={`mt-1 text-sm font-semibold ${netIncome >= 0 ? 'text-green-700' : 'text-red-600'}`}>
            <Money paise={netIncome} />
          </span>
        </div>
      </div>
      <div className="min-w-[170px] flex-1 space-y-3">
        {positiveRows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="inline-flex items-center gap-2 text-slate-600">
              <span className={`h-2.5 w-2.5 rounded-full ${row.color}`} aria-hidden="true" />
              {row.label}
            </span>
            <Money paise={row.value} />
          </div>
        ))}
      </div>
    </div>
  );
}

function colorFor(color: string): string {
  if (color === 'bg-blue-600') return '#2563eb';
  if (color === 'bg-amber-500') return '#f59e0b';
  if (color === 'bg-red-500') return '#ef4444';
  return '#16a34a';
}

function DashboardChartCard({
  title,
  description,
  linkTo,
  linkLabel,
  children,
}: {
  title: string;
  description: string;
  linkTo: string;
  linkLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="dashboard-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="dashboard-panel-title">{title}</h2>
          <p className="dashboard-panel-description">{description}</p>
        </div>
        <Link to={linkTo} className="action-link text-xs">{linkLabel}</Link>
      </div>
      <div className="dashboard-panel-body">{children}</div>
    </section>
  );
}

function DashboardBar({
  label,
  value,
  color,
  max,
  signed = false,
}: {
  label: string;
  value: number;
  color: string;
  max: number;
  signed?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between gap-3 text-sm">
        <span className="text-slate-600">{label}</span>
        <Money paise={value} />
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.max(value === 0 ? 0 : 4, (Math.abs(value) / max) * 100)}%` }}
          title={`${label}: ${(value / 100).toFixed(2)} INR`}
        />
      </div>
      {signed && value < 0 && <p className="mt-1 text-xs text-red-600">Loss</p>}
    </div>
  );
}

function Card({
  label,
  value,
  to,
  tone,
}: {
  label: string;
  value: number | string;
  to: string;
  tone: 'blue' | 'green' | 'slate' | 'violet';
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-emerald-50 text-emerald-600',
    slate: 'bg-slate-100 text-slate-600',
    violet: 'bg-violet-50 text-violet-600',
  };
  return (
    <Link
      to={to}
      className={`dashboard-count-card dashboard-count-card-${tone}`}
    >
      <div className={`dashboard-count-icon ${tones[tone]}`} aria-hidden="true">
        {tone === 'blue' ? '▤' : tone === 'green' ? '♧' : tone === 'violet' ? '▣' : '◇'}
      </div>
      <div>
        <div className="dashboard-count-label">{label}</div>
        <div className="dashboard-count-value">{value}</div>
      </div>
    </Link>
  );
}

function AnalyticsPanel({ stats }: { stats: DashboardStats }) {
  const monthlyMax = Math.max(
    1,
    ...stats.analytics.monthly.flatMap((month) => [month.sales_paise, month.collections_paise]),
  );
  const mixMax = Math.max(1, ...stats.analytics.paymentMix.map((row) => row.amount_paise));
  const customerMax = Math.max(
    1,
    ...stats.analytics.topCustomers.map((row) => row.outstanding_paise),
  );

  return (
    <section className="dashboard-pulse-grid" aria-labelledby="analytics-heading">
      <div className="dashboard-panel dashboard-pulse-chart">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="analytics-heading" className="dashboard-panel-title">Business pulse</h2>
          <p className="dashboard-panel-description">A quick view of sales, collections, and customer exposure.</p>
        </div>
        <span className="text-xs text-slate-500">Last 6 months</span>
      </div>

      <div className="dashboard-pulse-chart-body">
        <div>
          <div className="mb-3 flex items-center gap-4 text-xs text-slate-600">
            <Legend color="bg-blue-600" label="Sales" />
            <Legend color="bg-green-600" label="Collections" />
          </div>
          <div className="flex h-44 items-end gap-2 sm:gap-4" role="img" aria-label="Sales and collections for the last six months">
            {stats.analytics.monthly.map((month) => (
              <div key={month.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-2">
                <div className="flex h-36 w-full items-end justify-center gap-1">
                  <div className="w-1/2 max-w-6 rounded-t bg-blue-600" style={{ height: `${Math.max(4, (month.sales_paise / monthlyMax) * 100)}%` }} title={`Sales: ${month.sales_paise / 100} INR`} />
                  <div className="w-1/2 max-w-6 rounded-t bg-green-600" style={{ height: `${Math.max(4, (month.collections_paise / monthlyMax) * 100)}%` }} title={`Collections: ${month.collections_paise / 100} INR`} />
                </div>
                <span className="text-xs text-slate-600">{month.label}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
      </div>
      <div className="dashboard-panel dashboard-cash-snapshot">
        <h2 className="dashboard-panel-title">Cash snapshot</h2>
        <BarList title="Payment mix" empty="No payments yet." rows={stats.analytics.paymentMix.map((row) => ({ label: row.method.toUpperCase(), value: row.amount_paise, max: mixMax }))} />
        <BarList title="Top customer balances" empty="No outstanding balances." rows={stats.analytics.topCustomers.map((row) => ({ label: row.name, value: row.outstanding_paise, max: customerMax }))} />
      </div>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${color}`} />{label}</span>;
}

function BarList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ label: string; value: number; max: number }>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-slate-500">{empty}</p> : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="mb-1 flex justify-between gap-2 text-xs text-slate-600">
                <span className="truncate">{row.label}</span>
                <Money paise={row.value} />
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.max(3, (row.value / row.max) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
