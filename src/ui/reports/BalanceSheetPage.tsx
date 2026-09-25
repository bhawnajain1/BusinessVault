import { useEffect, useState } from 'react';
import { balanceSheet, type BalanceSheet } from '../../domain/AccountingService';
import { downloadCsv } from '../../csv/streamCsvExport';
import { money, parseDateInput, toDateString } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { ReportTableToolbar, useReportTableControls } from './reportTableControls';

export default function BalanceSheetPage() {
  const { businessId, error: bizError } = useBusinessId();
  const [asOfStr, setAsOfStr] = useState<string>(toDateString(new Date()));
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    balanceSheet(businessId, parseDateInput(asOfStr))
      .then((r) => {
        if (alive) setBs(r);
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
  }, [businessId, asOfStr]);

  async function exportCsv(): Promise<void> {
    if (!bs) return;
    type Row = { section: string; code: string; name: string; amount: string };
    const rows: Row[] = [];
    for (const a of bs.assets.by_account) {
      rows.push({ section: 'Assets', code: a.code, name: a.name, amount: (a.balance_paise / 100).toFixed(2) });
    }
    rows.push({ section: 'Assets', code: '', name: 'TOTAL ASSETS', amount: (bs.assets.total_paise / 100).toFixed(2) });
    for (const a of bs.liabilities.by_account) {
      rows.push({ section: 'Liabilities', code: a.code, name: a.name, amount: (a.balance_paise / 100).toFixed(2) });
    }
    rows.push({ section: 'Liabilities', code: '', name: 'TOTAL LIABILITIES', amount: (bs.liabilities.total_paise / 100).toFixed(2) });
    for (const a of bs.equity.by_account) {
      rows.push({ section: 'Equity', code: a.code, name: a.name, amount: (a.balance_paise / 100).toFixed(2) });
    }
    rows.push({ section: 'Equity', code: '', name: 'TOTAL EQUITY', amount: (bs.equity.total_paise / 100).toFixed(2) });

    await downloadCsv({
      columns: ['section', 'code', 'name', 'amount'],
      rows,
      toRow: (r) => r,
      filename: `balance-sheet-${asOfStr}.csv`,
    });
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Balance Sheet</h1>
          <p className="text-sm text-slate-500">Assets, liabilities, and equity as of the selected date.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">As of</span>
            <input
              type="date"
              value={asOfStr}
              onChange={(e) => setAsOfStr(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={exportCsv}
            disabled={!bs}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      {bs && (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            <Column title="Assets" rows={bs.assets.by_account} total={bs.assets.total_paise} />
            <Column title="Liabilities" rows={bs.liabilities.by_account} total={bs.liabilities.total_paise} />
            <Column title="Equity" rows={bs.equity.by_account} total={bs.equity.total_paise} />
          </div>
          <div className={`p-3 rounded text-sm ${bs.balanced ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
            {bs.balanced
              ? 'Balance sheet balances: Assets = Liabilities + Equity.'
              : `Balance sheet out of balance by ${money(bs.difference_paise)}. Investigate journals.`}
          </div>
        </>
      )}
    </div>
  );
}

interface Row {
  account_id: string;
  code: string;
  name: string;
  balance_paise: number;
}

function Column(props: { title: string; rows: Row[]; total: number }) {
  const controls = useReportTableControls(
    props.rows,
    (r) => `${r.code} ${r.name}`,
    (r, key) => key === 'balance' ? r.balance_paise : key === 'name' ? r.name : r.code,
    { key: 'code', direction: 'asc' },
  );
  return (
    <div className="border border-slate-200 rounded flex flex-col">
      <div className="px-3 py-2 bg-slate-50 font-semibold text-sm">{props.title}</div>
      <div className="px-3 pt-2"><ReportTableToolbar query={controls.query} onQueryChange={controls.setQuery} sort={controls.sort} onSortChange={controls.setSort} options={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'balance', label: 'Balance' }]} /></div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <tbody>
             {controls.filteredRows.map((r) => (
              <tr key={r.account_id} className="border-t border-slate-100">
                <td className="px-3 py-1.5 font-mono text-xs w-20">{r.code}</td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.balance_paise)}</td>
              </tr>
            ))}
             {controls.filteredRows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-slate-400">No accounts.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 flex justify-between text-sm font-semibold">
        <span>Total</span>
        <span className="tabular-nums">{money(props.total)}</span>
      </div>
    </div>
  );
}
