import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, SalesReturn } from '../../db/types';
import { downloadCsv } from '../../csv/streamCsvExport';
import { money } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { log } from '../../lib/log';

// Three report views over sales_returns, on one page so the shared date-
// range + business filter is set once (grug: locality-of-behaviour beats
// three separate report pages). Each view is a plain table with CSV export.
//
// Cancelled returns are shown but visually muted, and they are EXCLUDED from
// the by-reason and by-customer roll-ups since those represent economic
// activity — a cancelled return contributed nothing net.

type Tab = 'register' | 'by_reason' | 'by_customer';

interface RegisterRow {
  id: string;
  return_number: string;
  return_date: string;
  customer_id: string;
  customer_name: string;
  reason: string;
  status: SalesReturn['status'];
  total_paise: number;
}

interface RollupRow {
  key: string;
  label: string;
  count: number;
  total_paise: number;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdMonthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

export default function SalesReturnsReportPage() {
  const { businessId, error: bizError } = useBusinessId();
  const [tab, setTab] = useState<Tab>('register');
  const [fromYmd, setFromYmd] = useState<string>(ymdMonthsAgo(3));
  const [toYmd, setToYmd] = useState<string>(todayYmd());
  const [returns, setReturns] = useState<SalesReturn[]>([]);
  const [customersById, setCustomersById] = useState<Map<string, Customer>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const [rows, customers] = await Promise.all([
          db.sales_returns.where('business_id').equals(businessId).toArray(),
          db.customers.where('business_id').equals(businessId).toArray(),
        ]);
        if (!alive) return;
        rows.sort((a, b) => (a.return_date < b.return_date ? 1 : -1));
        const m = new Map<string, Customer>();
        for (const c of customers) m.set(c.id, c);
        setReturns(rows);
        setCustomersById(m);
        log.info('salesReturnsReport', 'loaded', {
          businessId,
          totalRows: rows.length,
          customerCount: customers.length,
        });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [businessId]);

  const inRange = useMemo(() => {
    return returns.filter(
      (r) =>
        (!fromYmd || r.return_date >= fromYmd) &&
        (!toYmd || r.return_date <= toYmd),
    );
  }, [returns, fromYmd, toYmd]);

  const registerRows = useMemo<RegisterRow[]>(() => {
    return inRange.map((r) => ({
      id: r.id,
      return_number: r.return_number,
      return_date: r.return_date,
      customer_id: r.customer_id,
      customer_name: customersById.get(r.customer_id)?.name ?? '(unknown)',
      reason: r.reason || '(no reason)',
      status: r.status,
      total_paise: r.total_paise,
    }));
  }, [inRange, customersById]);

  const registerTotalPaise = registerRows
    .filter((r) => r.status === 'posted')
    .reduce((s, r) => s + r.total_paise, 0);

  const byReasonRows = useMemo<RollupRow[]>(() => {
    const groups = new Map<string, RollupRow>();
    for (const r of inRange) {
      if (r.status !== 'posted') continue;
      const key = (r.reason || '(no reason)').trim() || '(no reason)';
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.total_paise += r.total_paise;
      } else {
        groups.set(key, {
          key,
          label: key,
          count: 1,
          total_paise: r.total_paise,
        });
      }
    }
    return Array.from(groups.values()).sort(
      (a, b) => b.total_paise - a.total_paise,
    );
  }, [inRange]);

  const byCustomerRows = useMemo<RollupRow[]>(() => {
    const groups = new Map<string, RollupRow>();
    for (const r of inRange) {
      if (r.status !== 'posted') continue;
      const key = r.customer_id;
      const label = customersById.get(r.customer_id)?.name ?? '(unknown)';
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.total_paise += r.total_paise;
      } else {
        groups.set(key, { key, label, count: 1, total_paise: r.total_paise });
      }
    }
    return Array.from(groups.values()).sort(
      (a, b) => b.total_paise - a.total_paise,
    );
  }, [inRange, customersById]);

  const activeRowCount =
    tab === 'register'
      ? registerRows.length
      : tab === 'by_reason'
        ? byReasonRows.length
        : byCustomerRows.length;

  async function exportCsv(): Promise<void> {
    const stamp = todayYmd();
    if (tab === 'register') {
      // Register CSV excludes cancelled rows so its column-sum matches the
      // on-screen "Total (posted only)" footer — no silent asymmetry.
      const postedRows = registerRows.filter((r) => r.status === 'posted');
      await downloadCsv({
        columns: ['date', 'return_no', 'customer', 'reason', 'total'],
        rows: postedRows,
        toRow: (r) => ({
          date: r.return_date,
          return_no: r.return_number,
          customer: r.customer_name,
          reason: r.reason,
          total: (r.total_paise / 100).toFixed(2),
        }),
        filename: `sales-returns-register-${stamp}.csv`,
      });
    } else if (tab === 'by_reason') {
      await downloadCsv({
        columns: ['reason', 'count', 'total'],
        rows: byReasonRows,
        toRow: (r) => ({
          reason: r.label,
          count: String(r.count),
          total: (r.total_paise / 100).toFixed(2),
        }),
        filename: `sales-returns-by-reason-${stamp}.csv`,
      });
    } else {
      await downloadCsv({
        columns: ['customer', 'count', 'total'],
        rows: byCustomerRows,
        toRow: (r) => ({
          customer: r.label,
          count: String(r.count),
          total: (r.total_paise / 100).toFixed(2),
        }),
        filename: `sales-returns-by-customer-${stamp}.csv`,
      });
    }
    log.info('salesReturnsReport', 'exported CSV', {
      tab,
      rowCount:
        tab === 'register'
          ? registerRows.length
          : tab === 'by_reason'
            ? byReasonRows.length
            : byCustomerRows.length,
    });
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sales Returns Report</h1>
          <p className="text-sm text-slate-500">
            Register + roll-ups by reason and by customer. Cancelled returns are
            excluded from the by-reason / by-customer roll-ups.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex flex-col text-xs">
            <span className="text-slate-600">From</span>
            <input
              type="date"
              value={fromYmd}
              onChange={(e) => setFromYmd(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="text-slate-600">To</span>
            <input
              type="date"
              value={toYmd}
              onChange={(e) => setToYmd(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={exportCsv}
            disabled={activeRowCount === 0}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="flex border-b border-slate-200 text-sm">
        {[
          { k: 'register', label: 'Register' },
          { k: 'by_reason', label: 'By reason' },
          { k: 'by_customer', label: 'By customer' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as Tab)}
            className={
              tab === t.k
                ? 'px-3 py-1.5 border-b-2 border-slate-900 font-medium'
                : 'px-3 py-1.5 text-slate-500 hover:text-slate-900'
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {bizError && <div className="text-rose-600 text-sm">{bizError}</div>}
      {err && <div className="text-rose-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      {tab === 'register' && (
        <div className="overflow-auto border border-slate-200 rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Return #</th>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {registerRows.map((r) => (
                <tr
                  key={r.id}
                  className={
                    r.status === 'cancelled'
                      ? 'border-t border-slate-100 text-slate-400'
                      : 'border-t border-slate-100'
                  }
                >
                  <td className="px-3 py-1.5">{r.return_date}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">
                    <Link
                      to={`/returns/${r.id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {r.return_number}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">{r.customer_name}</td>
                  <td className="px-3 py-1.5">{r.reason}</td>
                  <td className="px-3 py-1.5">{r.status}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {money(r.total_paise)}
                  </td>
                </tr>
              ))}
              {registerRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                    No sales returns in range.
                  </td>
                </tr>
              )}
            </tbody>
            {registerRows.length > 0 && (
              <tfoot className="bg-slate-50 font-semibold">
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-right">
                    Total (posted only)
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {money(registerTotalPaise)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {tab === 'by_reason' && (
        <div className="overflow-auto border border-slate-200 rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-right px-3 py-2">Count</th>
                <th className="text-right px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {byReasonRows.map((r) => (
                <tr key={r.key} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">{r.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.count}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {money(r.total_paise)}
                  </td>
                </tr>
              ))}
              {byReasonRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-slate-400">
                    No posted returns in range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'by_customer' && (
        <div className="overflow-auto border border-slate-200 rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-right px-3 py-2">Count</th>
                <th className="text-right px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {byCustomerRows.map((r) => (
                <tr key={r.key} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/customers/${r.key}`}
                      className="text-blue-700 hover:underline"
                    >
                      {r.label}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.count}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {money(r.total_paise)}
                  </td>
                </tr>
              ))}
              {byCustomerRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-slate-400">
                    No posted returns in range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
