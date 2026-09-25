import { useEffect, useMemo, useState } from 'react';
import { trialBalance, type TrialBalanceRow } from '../../domain/AccountingService';
import { downloadCsv } from '../../csv/streamCsvExport';
import { buildBusinessExcelExport } from '../../excel/excelExport';
import { triggerDownload } from '../../csv/streamCsvExport';
import { money, parseDateInput, toDateString } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { ReportTableToolbar, useReportTableControls } from './reportTableControls';

export default function TrialBalancePage() {
  const { businessId, error: bizError } = useBusinessId();
  const [asOfStr, setAsOfStr] = useState<string>(toDateString(new Date()));
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const controls = useReportTableControls(
    rows,
    (r) => `${r.code} ${r.name} ${r.type}`,
    (r, key) => key === 'debits' ? r.debits_paise : key === 'credits' ? r.credits_paise : key === 'balance' ? r.balance_paise : key === 'name' ? r.name : r.code,
    { key: 'code', direction: 'asc' },
  );
  const [exporting, setExporting] = useState<'' | 'csv' | 'xlsx'>('');

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    trialBalance(businessId, parseDateInput(asOfStr))
      .then((r) => {
        if (alive) setRows(r);
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

  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const r of rows) {
      dr += r.debits_paise;
      cr += r.credits_paise;
    }
    return { dr, cr };
  }, [rows]);

  async function exportCsv(): Promise<void> {
    setExporting('csv');
    try {
      await downloadCsv({
        columns: ['code', 'name', 'type', 'debits', 'credits', 'balance'],
        rows,
        toRow: (r) => ({
          code: r.code,
          name: r.name,
          type: r.type,
          debits: (r.debits_paise / 100).toFixed(2),
          credits: (r.credits_paise / 100).toFixed(2),
          balance: (r.balance_paise / 100).toFixed(2),
        }),
        filename: `trial-balance-${asOfStr}.csv`,
      });
    } finally {
      setExporting('');
    }
  }

  async function exportXlsx(): Promise<void> {
    if (!businessId) return;
    setExporting('xlsx');
    try {
      const { blob, filename } = await buildBusinessExcelExport(businessId, {
        asOf: parseDateInput(asOfStr),
      });
      triggerDownload(blob, filename);
    } finally {
      setExporting('');
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Trial Balance</h1>
          <p className="text-sm text-slate-500">All accounts, debits and credits, as-of a date.</p>
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
            disabled={rows.length === 0 || exporting !== ''}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {exporting === 'csv' ? 'Exporting...' : 'Export CSV'}
          </button>
          <button
            onClick={exportXlsx}
            disabled={!businessId || exporting !== ''}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {exporting === 'xlsx' ? 'Exporting...' : 'Export Excel'}
          </button>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      <div className="overflow-auto border border-slate-200 rounded">
        <ReportTableToolbar query={controls.query} onQueryChange={controls.setQuery} sort={controls.sort} onSortChange={controls.setSort} options={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'debits', label: 'Debits' }, { key: 'credits', label: 'Credits' }, { key: 'balance', label: 'Balance' }]} />
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Code</th>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-right px-3 py-2">Debits</th>
              <th className="text-right px-3 py-2">Credits</th>
              <th className="text-right px-3 py-2">Balance</th>
            </tr>
          </thead>
          <tbody>
             {controls.filteredRows.map((r) => (
              <tr key={r.account_id} className="border-t border-slate-100">
                <td className="px-3 py-1.5 font-mono text-xs">{r.code}</td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5">{r.type}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.debits_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.credits_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.balance_paise)}</td>
              </tr>
            ))}
             {controls.filteredRows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                  No accounts.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-slate-50 font-semibold">
            <tr>
              <td colSpan={3} className="px-3 py-2 text-right">Totals</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(totals.dr)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(totals.cr)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {totals.dr === totals.cr ? (
                  <span className="text-emerald-700">Balanced</span>
                ) : (
                  <span className="text-red-600">Diff {money(totals.dr - totals.cr)}</span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
