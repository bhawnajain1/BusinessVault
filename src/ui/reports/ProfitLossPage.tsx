import { useEffect, useState } from 'react';
import { profitAndLoss, type ProfitAndLoss } from '../../domain/AccountingService';
import { downloadCsv } from '../../csv/streamCsvExport';
import { money, parseDateInput, toDateString, financialYearStart } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { ReportTableToolbar, useReportTableControls } from './reportTableControls';

export default function ProfitLossPage() {
  const { businessId, error: bizError } = useBusinessId();
  const today = new Date();
  const [fromStr, setFromStr] = useState<string>(toDateString(financialYearStart(today)));
  const [toStr, setToStr] = useState<string>(toDateString(today));
  const [pl, setPl] = useState<ProfitAndLoss | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    profitAndLoss(businessId, parseDateInput(fromStr), parseDateInput(toStr))
      .then((r) => {
        if (alive) setPl(r);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, fromStr, toStr]);

  async function exportCsv(): Promise<void> {
    if (!pl) return;
    await downloadCsv({
      columns: ['section', 'code', 'name', 'amount'],
      rows: pl.by_account,
      toRow: (a) => ({
        section: a.type === 'income' ? 'Income' : 'Expense',
        code: a.code,
        name: a.name,
        amount: (a.amount_paise / 100).toFixed(2),
      }),
      filename: `profit-loss-${fromStr}-to-${toStr}.csv`,
    });
  }

  const income = pl?.by_account.filter((a) => a.type === 'income') ?? [];
  const expenses = pl?.by_account.filter((a) => a.type === 'expense') ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
          <p className="text-sm text-slate-500">Income and expense breakdown for the selected period.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">From</span>
            <input
              type="date"
              value={fromStr}
              onChange={(e) => setFromStr(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">To</span>
            <input
              type="date"
              value={toStr}
              onChange={(e) => setToStr(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={exportCsv}
            disabled={!pl}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      {pl && (
        <div className="grid md:grid-cols-2 gap-4">
          <Section title="Income" rows={income} total={pl.revenue_paise + pl.other_income_paise} totalLabel="Total Income" />
          <Section title="Expenses" rows={expenses} total={pl.operating_expenses_paise + pl.cogs_paise} totalLabel="Total Expenses" />
          <div className="md:col-span-2 border border-slate-200 rounded p-4 bg-slate-50">
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <Metric label="Revenue" value={money(pl.revenue_paise)} />
              <Metric label="COGS" value={money(pl.cogs_paise)} />
              <Metric label="Gross Profit" value={money(pl.gross_profit_paise)} />
              <Metric label="Operating Expenses" value={money(pl.operating_expenses_paise)} />
              <Metric label="Other Income" value={money(pl.other_income_paise)} />
              <Metric
                label="Net Income"
                value={money(pl.net_income_paise)}
                emphasis={pl.net_income_paise >= 0 ? 'positive' : 'negative'}
              />
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

interface Row {
  code: string;
  name: string;
  amount_paise: number;
}

function Section(props: { title: string; rows: Row[]; total: number; totalLabel: string }) {
  const controls = useReportTableControls(
    props.rows,
    (r) => `${r.code} ${r.name}`,
    (r, key) => key === 'amount' ? r.amount_paise : key === 'name' ? r.name : r.code,
    { key: 'code', direction: 'asc' },
  );
  return (
    <div className="border border-slate-200 rounded">
      <div className="px-3 py-2 bg-slate-50 font-semibold text-sm">{props.title}</div>
      <div className="px-3 pt-2"><ReportTableToolbar query={controls.query} onQueryChange={controls.setQuery} sort={controls.sort} onSortChange={controls.setSort} options={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'amount', label: 'Amount' }]} /></div>
      <table className="w-full text-sm">
        <tbody>
          {controls.filteredRows.map((r) => (
            <tr key={r.code} className="border-t border-slate-100">
              <td className="px-3 py-1.5 font-mono text-xs w-20">{r.code}</td>
              <td className="px-3 py-1.5">{r.name}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{money(r.amount_paise)}</td>
            </tr>
          ))}
          {controls.filteredRows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-4 text-center text-slate-400">No entries.</td>
            </tr>
          )}
        </tbody>
        <tfoot className="bg-slate-50 font-semibold">
          <tr>
            <td colSpan={2} className="px-3 py-2 text-right">{props.totalLabel}</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(props.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Metric(props: { label: string; value: string; emphasis?: 'positive' | 'negative' }) {
  const cls = props.emphasis === 'positive'
    ? 'text-emerald-700'
    : props.emphasis === 'negative'
      ? 'text-red-600'
      : 'text-slate-800';
  return (
    <div>
      <dt className="text-slate-500 text-xs uppercase tracking-wide">{props.label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${cls}`}>{props.value}</dd>
    </div>
  );
}
