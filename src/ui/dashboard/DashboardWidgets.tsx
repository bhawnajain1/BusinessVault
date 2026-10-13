import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Banknote,
  CircleAlert,
  CircleCheck,
  Clock,
  CreditCard,
  Ellipsis,
  FileText,
  Landmark,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import Money, { formatMoney } from '../components/Money';
import type { DashboardAnalytics, RecentInvoiceRow } from '../../domain/dashboardStats';
import type { ProfitAndLoss } from '../../domain/AccountingService';
import { RANGE_OPTIONS, type RangeKey } from './dateRange';
import { DateWithTime } from '../components/DateTime';

// Building blocks for the Overview page. Everything is presentational: data
// comes in as props, already computed by domain code (dashboardStats.ts,
// AccountingService.profitAndLoss). No fetching and no money maths here
// beyond chart scaling and percentages for display.

// Whole-rupee INR for axes and compact labels: ₹2,00,000
const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
export function formatRupeesWhole(paise: number): string {
  return inrWhole.format(Math.round(paise / 100));
}

// ---------------------------------------------------------------------------
// Card shell

export function Panel({
  title,
  description,
  icon: Icon,
  iconTone = 'indigo',
  action,
  children,
  className = '',
  titleId,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  iconTone?: Tone;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-[14px] border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgb(15_23_42/0.04),0_4px_16px_rgb(15_23_42/0.04)] sm:p-6 ${className}`}
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && <IconTile icon={Icon} tone={iconTone} size="sm" />}
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold leading-6 text-slate-900">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-5 flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

export function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 rounded-md text-sm font-semibold text-indigo-600 hover:text-indigo-700 hover:underline"
    >
      {children}
      <ArrowRight className="h-4 w-4" aria-hidden="true" />
    </Link>
  );
}

type Tone = 'indigo' | 'emerald' | 'amber' | 'slate';

const TILE_TONE: Record<Tone, string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-600',
};

function IconTile({ icon: Icon, tone, size = 'md' }: { icon: LucideIcon; tone: Tone; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-10 w-10 rounded-[10px]' : 'h-11 w-11 rounded-xl';
  return (
    <span className={`grid shrink-0 place-items-center ${box} ${TILE_TONE[tone]}`} aria-hidden="true">
      <Icon className="h-5 w-5" strokeWidth={1.9} />
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`block animate-pulse rounded-md bg-slate-100 ${className}`} aria-hidden="true" />;
}

function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center">
      <Icon className="h-6 w-6 text-slate-400" aria-hidden="true" />
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card

export function KpiCard({
  label,
  paise,
  icon,
  tone,
  link,
  changePct,
  valueTone,
}: {
  label: string;
  paise: number | null; // null = still loading
  icon: LucideIcon;
  tone: Tone;
  link: { to: string; label: string };
  // Only passed when a real previous-period figure exists.
  changePct?: number | null;
  valueTone?: 'positive' | 'negative';
}) {
  const valueColor = valueTone === 'negative' ? 'text-red-600' : 'text-slate-900';
  return (
    <div className="flex min-w-0 flex-col rounded-[14px] border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgb(15_23_42/0.04),0_4px_16px_rgb(15_23_42/0.04)] transition-shadow hover:shadow-[0_2px_4px_rgb(15_23_42/0.05),0_10px_24px_rgb(15_23_42/0.07)]">
      <div className="flex items-start justify-between gap-3">
        <p className="pt-1 text-sm font-medium text-slate-500">{label}</p>
        <IconTile icon={icon} tone={tone} />
      </div>
      <div className={`mt-1 break-words text-[26px] font-semibold leading-9 tracking-tight tabular-nums ${valueColor}`}>
        {paise === null ? <Skeleton className="mt-1 h-8 w-40" /> : <Money paise={paise} className="" />}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <PanelLink to={link.to}>{link.label}</PanelLink>
        {changePct !== undefined && changePct !== null && Number.isFinite(changePct) && <ChangeBadge pct={changePct} />}
      </div>
    </div>
  );
}

function ChangeBadge({ pct }: { pct: number }) {
  const up = pct >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  const rounded = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.round(Math.abs(pct) * 10) / 10;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <span
        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold ${
          up ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
        }`}
      >
        <Icon className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">{up ? 'Up' : 'Down'}</span>
        {rounded}%
      </span>
      vs previous period
    </span>
  );
}

// ---------------------------------------------------------------------------
// Range select (used by the chart; the header has its own copy)

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (key: RangeKey) => void }) {
  return (
    <label className="relative inline-flex">
      <span className="sr-only">Chart date range</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as RangeKey)}
        className="h-9 rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
      >
        {RANGE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Sales & collections bar chart. Plain HTML/CSS bars so it stays responsive
// without measuring the container. Each month is focusable; hover or focus
// shows a tooltip, and a visually hidden table carries the same numbers for
// screen readers.

function niceCeil(paise: number): number {
  if (paise <= 0) return 100_000_00; // ₹1,00,000 scale for an empty chart
  const rupees = paise / 100;
  const pow = 10 ** Math.floor(Math.log10(rupees));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.find((s) => s * pow >= rupees) ?? 10;
  return step * pow * 100;
}

function monthLabelLong(key: string): string {
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${key}-01T00:00:00Z`),
  );
}

export function SalesCollectionsChart({ monthly }: { monthly: DashboardAnalytics['monthly'] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceCeil(Math.max(0, ...monthly.flatMap((m) => [m.sales_paise, m.collections_paise])));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => f * max);
  const empty = monthly.every((m) => m.sales_paise === 0 && m.collections_paise === 0);
  const showYear = new Set(monthly.map((m) => m.key.slice(0, 4))).size > 1;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-4 flex items-center gap-5 text-sm text-slate-600" aria-hidden="true">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-indigo-600" /> Sales
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" /> Collections
        </span>
      </div>
      <div className="flex flex-1 gap-3">
        {/* Y axis */}
        <div className="relative h-60 shrink-0 text-right text-xs tabular-nums text-slate-500" aria-hidden="true">
          {ticks.map((t, i) => (
            <div key={i} className="whitespace-nowrap leading-none" style={{ position: i === 0 ? 'relative' : 'absolute', top: i === 0 ? '-0.4em' : `calc(${i * 25}% - 0.4em)`, right: 0 }}>
              {formatRupeesWhole(t)}
            </div>
          ))}
          {/* invisible widest label keeps the column width stable */}
          <div className="invisible h-0 overflow-hidden whitespace-nowrap">{formatRupeesWhole(max)}</div>
        </div>
        {/* Plot */}
        <div className="min-w-0 flex-1">
          <div className="relative h-60">
            {ticks.map((_, i) => (
              <div
                key={i}
                className={`absolute inset-x-0 border-t ${i === ticks.length - 1 ? 'border-slate-300' : 'border-dashed border-slate-200'}`}
                style={{ top: `${i * 25}%` }}
                aria-hidden="true"
              />
            ))}
            {empty && (
              <div className="absolute inset-0 grid place-items-center">
                <p className="rounded-lg bg-white/90 px-3 py-1.5 text-sm text-slate-500">No sales or collections in this period</p>
              </div>
            )}
            <div className="absolute inset-0 flex items-end">
              {monthly.map((m, i) => {
                const label = `${monthLabelLong(m.key)}: sales ${formatMoney(m.sales_paise)}, collections ${formatMoney(m.collections_paise)}`;
                const align = i === 0 ? 'left-0' : i === monthly.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                return (
                  <div
                    key={m.key}
                    tabIndex={0}
                    aria-label={label}
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className={`group relative flex h-full min-w-0 flex-1 items-end justify-center gap-1 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${active === i ? 'bg-slate-50' : ''}`}
                  >
                    <Bar paise={m.sales_paise} max={max} className="bg-indigo-600" />
                    <Bar paise={m.collections_paise} max={max} className="bg-emerald-600" />
                    {active === i && (
                      <div className={`pointer-events-none absolute top-2 z-10 w-max min-w-[176px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-left shadow-lg ${align}`} aria-hidden="true">
                        <div className="text-xs font-semibold text-slate-900">{monthLabelLong(m.key)}</div>
                        <div className="mt-1.5 flex items-center justify-between gap-4 text-xs text-slate-600">
                          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-indigo-600" />Sales</span>
                          <span className="font-semibold tabular-nums text-slate-900">{formatMoney(m.sales_paise)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-4 text-xs text-slate-600">
                          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-600" />Collections</span>
                          <span className="font-semibold tabular-nums text-slate-900">{formatMoney(m.collections_paise)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {/* X axis */}
          <div className="mt-2 flex" aria-hidden="true">
            {monthly.map((m) => (
              <div key={m.key} className="min-w-0 flex-1 truncate text-center text-xs text-slate-500">
                {m.label}
                {showYear && m.key.endsWith('-01') ? ` ’${m.key.slice(2, 4)}` : ''}
              </div>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>Monthly sales and collections</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Sales</th>
            <th scope="col">Collections</th>
          </tr>
        </thead>
        <tbody>
          {monthly.map((m) => (
            <tr key={m.key}>
              <th scope="row">{monthLabelLong(m.key)}</th>
              <td>{formatMoney(m.sales_paise)}</td>
              <td>{formatMoney(m.collections_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar({ paise, max, className }: { paise: number; max: number; className: string }) {
  const pct = max > 0 ? (paise / max) * 100 : 0;
  return (
    <div
      className={`w-[38%] max-w-[28px] rounded-t-[4px] transition-[height] duration-300 ${className}`}
      style={{ height: paise > 0 ? `max(3px, ${pct}%)` : '0px' }}
    />
  );
}

// ---------------------------------------------------------------------------
// Cash snapshot — money received per payment mode in the selected period.

const MODE_META: Record<string, { label: string; icon: LucideIcon; tone: Tone }> = {
  bank: { label: 'Bank', icon: Landmark, tone: 'indigo' },
  upi: { label: 'UPI', icon: Smartphone, tone: 'indigo' },
  cash: { label: 'Cash', icon: Banknote, tone: 'emerald' },
  card: { label: 'Card', icon: CreditCard, tone: 'slate' },
  cheque: { label: 'Cheque', icon: FileText, tone: 'slate' },
};

export function CashSnapshot({ paymentMix }: { paymentMix: DashboardAnalytics['paymentMix'] }) {
  const byMethod = new Map(paymentMix.map((p) => [p.method, p.amount_paise]));
  // Bank, UPI and Cash always show (even at ₹0) so the card keeps its shape;
  // card / cheque only when used.
  const rows = ['bank', 'upi', 'cash', 'card', 'cheque']
    .filter((m) => ['bank', 'upi', 'cash'].includes(m) || (byMethod.get(m) ?? 0) > 0)
    .map((m) => ({ method: m, paise: byMethod.get(m) ?? 0 }));
  const total = rows.reduce((sum, r) => sum + r.paise, 0);

  return (
    <div className="flex flex-1 flex-col">
      <ul className="flex flex-1 flex-col justify-around gap-5">
        {rows.map((r) => {
          const meta = MODE_META[r.method] ?? { label: r.method.toUpperCase(), icon: Banknote, tone: 'slate' as Tone };
          const pct = total > 0 ? (r.paise / total) * 100 : 0;
          return (
            <li key={r.method} className="flex items-center gap-3">
              <IconTile icon={meta.icon} tone={meta.tone} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-800">{meta.label}</span>
                  <span className="text-sm font-semibold tabular-nums text-slate-900">{formatMoney(r.paise)}</span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"
                  role="progressbar"
                  aria-label={`${meta.label} share of collections`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                  aria-valuetext={`${Math.round(pct)}% of collections`}
                >
                  <div
                    className={`h-full rounded-full ${meta.tone === 'emerald' ? 'bg-emerald-600' : meta.tone === 'slate' ? 'bg-slate-400' : 'bg-indigo-600'}`}
                    style={{ width: r.paise > 0 ? `max(4px, ${pct}%)` : '0px' }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
        <span className="text-slate-500">Total received</span>
        <span className="font-semibold tabular-nums text-slate-900">{formatMoney(total)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top customer balances

export function TopCustomerBalances({ rows }: { rows: DashboardAnalytics['topCustomers'] }) {
  if (rows.length === 0) {
    return <EmptyState icon={CircleCheck} title="No outstanding customer balances" hint="Every customer is fully paid up." />;
  }
  return (
    <ol className="divide-y divide-slate-100">
      {rows.map((r, i) => (
        <li key={r.customer_id}>
          <Link
            to={`/customers/${r.customer_id}`}
            className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-slate-50"
          >
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                i === 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
              }`}
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 group-hover:text-indigo-700">
              {r.name}
            </span>
            <span className="text-sm font-semibold tabular-nums text-slate-900">{formatMoney(r.outstanding_paise)}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Profit & loss donut (SVG). Segments are the absolute sizes of the four
// P&L buckets; the centre shows net income.

export function ProfitLossDonut({ pnl }: { pnl: ProfitAndLoss }) {
  const segments = [
    { label: 'Revenue', paise: pnl.revenue_paise, color: '#4f46e5', dot: 'bg-indigo-600' },
    { label: 'COGS', paise: pnl.cogs_paise, color: '#f59e0b', dot: 'bg-amber-500' },
    { label: 'Operating expenses', paise: pnl.operating_expenses_paise, color: '#94a3b8', dot: 'bg-slate-400' },
    { label: 'Other income', paise: pnl.other_income_paise, color: '#059669', dot: 'bg-emerald-600' },
  ];
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.paise), 0);
  const r = 70;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && segments.filter((s) => s.paise > 0).length > 1 ? 2 : 0;
  let offset = 0;
  const loss = pnl.net_income_paise < 0;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 sm:flex-row sm:justify-around">
      <div className="relative h-[184px] w-[184px] shrink-0">
        <svg viewBox="0 0 184 184" className="h-full w-full -rotate-90" role="img" aria-label={`Profit and loss breakdown. Net ${loss ? 'loss' : 'income'} ${formatMoney(pnl.net_income_paise)}.`}>
          <circle cx="92" cy="92" r={r} fill="none" stroke="#f1f5f9" strokeWidth="18" />
          {total > 0 &&
            segments.map((s) => {
              const len = (Math.max(0, s.paise) / total) * c;
              if (len <= 0) return null;
              const el = (
                <circle
                  key={s.label}
                  cx="92"
                  cy="92"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="18"
                  strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                  strokeDashoffset={-offset}
                >
                  <title>{`${s.label}: ${formatMoney(s.paise)}`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xs font-medium text-slate-500">{loss ? 'Net loss' : 'Net income'}</span>
          <span
            className={`mt-1 max-w-[124px] break-words text-base font-semibold leading-6 tabular-nums ${loss ? 'text-red-600' : 'text-emerald-700'}`}
            title={formatMoney(pnl.net_income_paise)}
          >
            {formatRupeesWhole(pnl.net_income_paise)}
          </span>
        </div>
      </div>
      <ul className="w-full max-w-sm space-y-3.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="inline-flex min-w-0 items-center gap-2.5 text-slate-600">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-right">
              <span className="font-semibold tabular-nums text-slate-900">{formatMoney(s.paise)}</span>
              {total > 0 && (
                <span className="ml-2 inline-block w-10 text-xs tabular-nums text-slate-500">
                  {Math.round((Math.max(0, s.paise) / total) * 100)}%
                </span>
              )}
            </span>
          </li>
        ))}
        {total === 0 && <li className="pt-1 text-xs text-slate-500">No posted P&L activity in this period.</li>}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent invoices table

type InvoiceDisplayStatus = { label: string; className: string; icon: LucideIcon };

// Display-only status. Uses the stored invoice.status and adds "Overdue"
// when an open balance is past its due date. Every badge carries text + icon
// so status never relies on colour alone.
export function invoiceDisplayStatus(row: RecentInvoiceRow, todayYmd: string): InvoiceDisplayStatus {
  if (row.status === 'cancelled') return { label: 'Cancelled', className: 'bg-slate-100 text-slate-600', icon: CircleAlert };
  if (row.status === 'draft') return { label: 'Draft', className: 'bg-slate-100 text-slate-600', icon: FileText };
  if (row.status === 'paid' || row.balance_paise <= 0) return { label: 'Paid', className: 'bg-emerald-50 text-emerald-700', icon: CircleCheck };
  if (row.due_date && row.due_date < todayYmd) return { label: 'Overdue', className: 'bg-red-50 text-red-700', icon: CircleAlert };
  if (row.status === 'partial') return { label: 'Partially paid', className: 'bg-amber-50 text-amber-800', icon: Clock };
  return { label: 'Unpaid', className: 'bg-indigo-50 text-indigo-700', icon: Clock };
}

type SortKey = 'number' | 'date' | 'customerName' | 'total_paise' | 'balance_paise';

export function RecentInvoicesTable({ rows, todayYmd }: { rows: RecentInvoiceRow[]; todayYmd: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' });

  if (rows.length === 0) {
    return <EmptyState icon={FileText} title="No invoices yet" hint="Create your first invoice to see it here." />;
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'en-IN', { numeric: true });
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'customerName' || key === 'number' ? 'asc' : 'desc' }));

  const header = (key: SortKey, label: string, right = false) => {
    const activeSort = sort.key === key;
    const Icon = !activeSort ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th
        scope="col"
        aria-sort={activeSort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`h-11 whitespace-nowrap px-4 font-semibold ${right ? 'text-right' : 'text-left'}`}
      >
        <button
          type="button"
          onClick={() => toggle(key)}
          className={`inline-flex items-center gap-1 rounded uppercase tracking-[0.06em] hover:text-slate-900 ${right ? 'flex-row-reverse' : ''} ${activeSort ? 'text-slate-900' : ''}`}
        >
          {label}
          <Icon className={`h-3.5 w-3.5 ${activeSort ? 'text-indigo-600' : 'text-slate-400'}`} aria-hidden="true" />
        </button>
      </th>
    );
  };

  return (
    <div className="relative -mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            {header('number', 'Invoice #')}
            {header('date', 'Date')}
            {header('customerName', 'Customer')}
            {header('total_paise', 'Amount', true)}
            {header('balance_paise', 'Balance', true)}
            <th scope="col" className="h-11 px-4 text-left font-semibold uppercase tracking-[0.06em]">Status</th>
            <th scope="col" className="h-11 px-4 text-right font-semibold uppercase tracking-[0.06em]">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const st = invoiceDisplayStatus(r, todayYmd);
            const StatusIcon = st.icon;
            return (
              <tr key={r.id} className="hover:bg-indigo-50/40">
                <td className="h-14 whitespace-nowrap border-b border-slate-100 px-4">
                  <Link to={`/invoices/${r.id}`} className="rounded font-semibold text-indigo-600 hover:text-indigo-700 hover:underline">
                    {r.number}
                  </Link>
                </td>
                <td className="h-14 whitespace-nowrap border-b border-slate-100 px-4 tabular-nums text-slate-600"><DateWithTime date={r.date} at={r.created_at} /></td>
                <td className="h-14 max-w-[240px] truncate border-b border-slate-100 px-4 text-slate-700">{r.customerName}</td>
                <td className="h-14 whitespace-nowrap border-b border-slate-100 px-4 text-right tabular-nums text-slate-900">{formatMoney(r.total_paise)}</td>
                <td className={`h-14 whitespace-nowrap border-b border-slate-100 px-4 text-right tabular-nums ${r.balance_paise > 0 ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>
                  {formatMoney(r.balance_paise)}
                </td>
                <td className="h-14 border-b border-slate-100 px-4">
                  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${st.className}`}>
                    <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {st.label}
                  </span>
                </td>
                <td className="h-14 border-b border-slate-100 px-4 text-right">
                  <RowActions invoiceId={r.id} invoiceNumber={r.number} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowActions({ invoiceId, invoiceNumber }: { invoiceId: string; invoiceNumber: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = 'block rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-900';
  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for invoice ${invoiceNumber}`}
      >
        <Ellipsis className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white p-1 text-left shadow-lg">
          <Link role="menuitem" to={`/invoices/${invoiceId}`} className={item}>
            View invoice
          </Link>
          <Link role="menuitem" to={`/invoices/${invoiceId}/edit`} className={item}>
            Edit invoice
          </Link>
          <Link role="menuitem" to={`/invoices/${invoiceId}/print`} className={item}>
            Print / PDF
          </Link>
        </div>
      )}
    </div>
  );
}
