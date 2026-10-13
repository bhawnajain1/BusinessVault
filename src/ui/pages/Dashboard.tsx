import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChartColumn,
  ChevronDown,
  CircleAlert,
  FileInput,
  FileOutput,
  Plus,
  PieChart,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import { db } from '../../db';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { computeDashboardStats, type DashboardStats } from '../../domain/dashboardStats';
import { log } from '../../lib/log';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { profitAndLoss, type ProfitAndLoss } from '../../domain/AccountingService';
import { useDashboardRange } from '../dashboard/dateRange';
import {
  CashSnapshot,
  KpiCard,
  Panel,
  PanelLink,
  ProfitLossDonut,
  RangeSelect,
  RecentInvoicesTable,
  SalesCollectionsChart,
  Skeleton,
  TopCustomerBalances,
} from '../dashboard/DashboardWidgets';

function utcStart(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

// % change vs the previous period. Only shown when the previous figure is
// real and non-zero — a change from ₹0 has no meaningful percentage.
function pctChange(current: number, previous: number | undefined): number | null {
  if (previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export default function Dashboard() {
  const { businessId, loading } = useActiveBusiness();
  const [range, setRange] = useDashboardRange();
  const [loadError, setLoadError] = useState<string | null>(null);

  const stats = useLiveQuery<DashboardStats | null>(async () => {
    if (!businessId) return null;
    try {
      // Thin shim: load rows, hand to the pure computeDashboardStats. All
      // filtering / derivation lives in src/domain/dashboardStats.ts so
      // it can be unit-tested without React. Prior regression (PR #52):
      // summing raw `balance_paise` double-counted rename-edit trios.
      const [invoices, purchases, customers, suppliers, advances, salesReturns, payments, itemCount] =
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
        range: { fromYmd: range.fromYmd, toYmd: range.toYmd, months: range.months },
      });

      log.info('dashboard', 'stats computed', {
        businessId,
        asOfYmd,
        range: range.key,
        rangeFromYmd: range.fromYmd,
        rangeToYmd: range.toYmd,
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
      const hiddenInv = computed.diagnostics.rawInvoiceRows - computed.invoices;
      if (computed.invoices > 0 && hiddenInv > 5 * computed.invoices && hiddenInv > 5) {
        log.warn('dashboard', 'unusually large hidden-invoice gap', {
          businessId,
          liveInvoices: computed.invoices,
          hiddenInvoices: hiddenInv,
          supersededInvoices: computed.diagnostics.supersededInvoices,
          creditNotes: computed.diagnostics.creditNotes,
          recycledInvoices: computed.diagnostics.recycledInvoices,
        });
      }
      setLoadError(null);
      return computed;
    } catch (e) {
      log.warn('dashboard', 'stats load failed', { businessId, error: String(e) });
      setLoadError('We could not load your dashboard figures.');
      return null;
    }
  }, [businessId, range.key], null);

  // P&L for the selected range and the same-length window before it.
  const pnl = useLiveQuery<{ current: ProfitAndLoss; previous: ProfitAndLoss } | null>(async () => {
    if (!businessId) return null;
    try {
      const [current, previous] = await Promise.all([
        profitAndLoss(businessId, utcStart(range.fromYmd), utcStart(range.toYmd)),
        profitAndLoss(businessId, utcStart(range.previousFromYmd), utcStart(range.previousToYmd)),
      ]);
      log.info('dashboard', 'pnl computed', {
        businessId,
        range: range.key,
        revenuePaise: current.revenue_paise,
        netIncomePaise: current.net_income_paise,
        previousRevenuePaise: previous.revenue_paise,
        previousNetIncomePaise: previous.net_income_paise,
      });
      return { current, previous };
    } catch (e) {
      log.warn('dashboard', 'pnl load failed', { businessId, error: String(e) });
      setLoadError('We could not load your profit & loss figures.');
      return null;
    }
  }, [businessId, range.key], null);

  if (loading) {
    return (
      <div className="bv-ui p-6" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-3 h-4 w-64" />
      </div>
    );
  }

  if (!businessId) {
    return (
      <div className="bv-ui mx-auto max-w-md p-8 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Welcome to BusinessVault</h1>
        <p className="mt-2 text-sm text-slate-500">No business found. Complete onboarding to get started.</p>
        <Link
          to="/onboarding"
          className="mt-5 inline-flex h-10 items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Start onboarding
        </Link>
      </div>
    );
  }

  const todayYmd = new Date().toISOString().slice(0, 10);
  const current = pnl?.current;
  const previous = pnl?.previous;

  return (
    <div className="bv-ui mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-9 tracking-tight text-slate-900">Overview</h1>
          <p className="mt-1 text-[15px] text-slate-500">
            Your business at a glance · <span className="text-slate-600">{range.label}</span>
          </p>
        </div>
        <NewInvoiceButton />
      </div>

      {loadError && (
        <div role="alert" className="mt-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            {loadError} Try reloading the page. If it keeps happening, export a debug bundle from Settings.
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4 xl:gap-6">
        <KpiCard
          label="Total receivables"
          paise={stats ? stats.outstandingReceivablesPaise : null}
          icon={FileInput}
          tone="indigo"
          link={{ to: '/reports/receivables-payables', label: 'View receivables' }}
        />
        <KpiCard
          label="Total payables"
          paise={stats ? stats.outstandingPayablesPaise : null}
          icon={FileOutput}
          tone="amber"
          link={{ to: '/reports/receivables-payables', label: 'View payables' }}
        />
        <KpiCard
          label="Revenue"
          paise={current ? current.revenue_paise : null}
          icon={TrendingUp}
          tone="emerald"
          link={{ to: '/reports/sales-purchases', label: 'View sales' }}
          changePct={current ? pctChange(current.revenue_paise, previous?.revenue_paise) : null}
        />
        <KpiCard
          label="Net income"
          paise={current ? current.net_income_paise : null}
          icon={Wallet}
          tone="indigo"
          link={{ to: '/reports/pnl', label: 'View P&L' }}
          changePct={current ? pctChange(current.net_income_paise, previous?.net_income_paise) : null}
          valueTone={current && current.net_income_paise < 0 ? 'negative' : 'positive'}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:mt-6 xl:grid-cols-3 xl:gap-6">
        <Panel
          className="xl:col-span-2"
          title="Sales & collections"
          titleId="dash-sales-title"
          description="Invoiced sales vs money received, by month"
          icon={ChartColumn}
          action={<RangeSelect value={range.key} onChange={setRange} />}
        >
          {stats ? <SalesCollectionsChart monthly={stats.analytics.monthly} /> : <Skeleton className="h-72 w-full" />}
        </Panel>
        <Panel
          title="Cash snapshot"
          titleId="dash-cash-title"
          description="Money received by payment mode in this period"
          icon={Wallet}
          iconTone="emerald"
        >
          {stats ? <CashSnapshot paymentMix={stats.analytics.paymentMix} /> : <SkeletonRows />}
        </Panel>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2 xl:mt-6 xl:gap-6">
        <Panel
          title="Top customer balances"
          titleId="dash-top-title"
          description="Largest amounts owed to you today"
          icon={Users}
          action={<PanelLink to="/reports/receivables-payables">View all</PanelLink>}
        >
          {stats ? <TopCustomerBalances rows={stats.analytics.topCustomers} /> : <SkeletonRows />}
        </Panel>
        <Panel
          title="Profit & loss"
          titleId="dash-pnl-title"
          description={range.label}
          icon={PieChart}
          iconTone="amber"
          action={<PanelLink to="/reports/pnl">View P&L report</PanelLink>}
        >
          {current ? <ProfitLossDonut pnl={current} /> : <Skeleton className="h-48 w-full" />}
        </Panel>
      </div>

      <div className="mt-5 xl:mt-6">
        <Panel
          title="Recent invoices"
          titleId="dash-recent-title"
          description="Your latest sales invoices"
          action={<PanelLink to="/invoices">View all</PanelLink>}
        >
          {stats ? <RecentInvoicesTable rows={stats.recentInvoices} todayYmd={todayYmd} /> : <SkeletonRows />}
        </Panel>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

// Split button: the main half goes straight to a new invoice; the chevron
// opens the other ways to record a sale or purchase.
function NewInvoiceButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = 'block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-900';
  return (
    <div ref={rootRef} className="relative inline-flex rounded-lg shadow-sm">
      <Link
        to="/invoices/new"
        className="inline-flex h-10 items-center gap-2 rounded-l-lg bg-indigo-600 pl-4 pr-3.5 text-sm font-semibold text-white hover:bg-indigo-700"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        New invoice
      </Link>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 items-center rounded-r-lg border-l border-indigo-400/70 bg-indigo-600 px-2.5 text-white hover:bg-indigo-700"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More ways to create"
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-2 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          <Link role="menuitem" to="/invoices/new" className={item}>New invoice</Link>
          <Link role="menuitem" to="/pos" className={item}>Point of sale (POS)</Link>
          <Link role="menuitem" to="/purchases/new" className={item}>New purchase</Link>
          <Link role="menuitem" to="/payments" className={item}>Record payment</Link>
        </div>
      )}
    </div>
  );
}
