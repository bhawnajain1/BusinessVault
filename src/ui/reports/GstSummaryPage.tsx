import { useEffect, useMemo, useState } from 'react';
import { downloadCsv } from '../../csv/streamCsvExport';
import { addPaise, downloadGstrCsv, downloadGstrJson, downloadGstrExcel, buildGstrReport, loadGstSlabSummary, type GstrReportKind, type GstSlabSummaryRow } from '../../domain/gstrExport';
import { money, toDateString, financialYearStart } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { ReportTableToolbar, useReportTableControls } from './reportTableControls';

export default function GstSummaryPage() {
  const { businessId, error: bizError } = useBusinessId();
  const today = new Date();
  const [fromStr, setFromStr] = useState<string>(toDateString(financialYearStart(today)));
  const [toStr, setToStr] = useState<string>(toDateString(today));
  const [rows, setRows] = useState<GstSlabSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reportKind, setReportKind] = useState<GstrReportKind>('gstr1');
  const [exporting, setExporting] = useState(false);
  const controls = useReportTableControls(
    rows,
    (r) => `${r.rate_bps / 100}% ${r.invoice_count} ${r.line_count}`,
    (r, key) => key === 'rate' ? r.rate_bps : key === 'tax' ? r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise : key === 'taxable' ? r.taxable_paise : r.line_count,
    { key: 'rate', direction: 'asc' },
  );

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const out = await loadGstSlabSummary(businessId, reportKind, fromStr, toStr);
        if (alive) setRows(out);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [businessId, fromStr, toStr, reportKind]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.taxable = addPaise(acc.taxable, r.taxable_paise);
        acc.cgst = addPaise(acc.cgst, r.cgst_paise);
        acc.sgst = addPaise(acc.sgst, r.sgst_paise);
        acc.igst = addPaise(acc.igst, r.igst_paise);
        acc.cess = addPaise(acc.cess, r.cess_paise);
        acc.lines += r.line_count;
        return acc;
      },
      { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, lines: 0 },
    );
  }, [rows]);

  async function exportCsv(): Promise<void> {
    await downloadCsv({
       columns: ['tax_rate_pct', reportKind === 'gstr1' ? 'invoice_count' : 'bill_count', 'line_count', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'total_tax'],
      rows,
      toRow: (r) => ({
        tax_rate_pct: (r.rate_bps / 100).toFixed(2),
         [reportKind === 'gstr1' ? 'invoice_count' : 'bill_count']: r.invoice_count,
        line_count: r.line_count,
        taxable: (r.taxable_paise / 100).toFixed(2),
        cgst: (r.cgst_paise / 100).toFixed(2),
        sgst: (r.sgst_paise / 100).toFixed(2),
        igst: (r.igst_paise / 100).toFixed(2),
        cess: (r.cess_paise / 100).toFixed(2),
        total_tax: ((r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise) / 100).toFixed(2),
      }),
       filename: `gst-analysis-${fromStr}-to-${toStr}.csv`,
    });
  }

  async function exportGstr(format: 'csv' | 'json'): Promise<void> {
    if (!businessId) return;
    setExporting(true);
    try {
      const report = await buildGstrReport(businessId, reportKind, fromStr, toStr);
      if (format === 'csv') await downloadGstrCsv(report);
      else await downloadGstrJson(report);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  async function exportGstrExcel(): Promise<void> {
    if (!businessId) return;
    setExporting(true);
    try {
      const result = await downloadGstrExcel(businessId, reportKind, fromStr, toStr);
      const blocking = result.issues.filter((issue) => issue.severity === 'blocking_error');
      const warnings = result.issues.filter((issue) => issue.severity === 'warning');
      if (blocking.length > 0 || warnings.length > 0) setErr(`Workpaper exported incomplete with ${blocking.length} blocking issue(s) and ${warnings.length} warning(s). It is not proof of filing.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
           <h1 className="text-2xl font-semibold">GST Reports</h1>
           <p className="text-sm text-slate-500">GSTR-1 preparation and purchase-side GST workpapers. Exports are not proof of filing.</p>
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
            disabled={rows.length === 0}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">GST report</span>
            <select value={reportKind} onChange={(e) => setReportKind(e.target.value as GstrReportKind)} className="border border-slate-300 rounded px-2 py-1 text-sm">
               <option value="gstr1">GSTR-1 Preparation</option>
               <option value="purchaseRegister">Purchase Register</option>
            </select>
          </label>
          <button onClick={() => void exportGstr('csv')} disabled={!businessId || exporting} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50">
             {exporting ? 'Preparing...' : 'Download Workpaper CSV'}
          </button>
          <button onClick={() => void exportGstr('json')} disabled={!businessId || exporting} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50">
             Download BusinessVault Report JSON
          </button>
          <button onClick={() => void exportGstrExcel()} disabled={!businessId || exporting} className="bg-slate-800 text-white rounded px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50">
             {exporting ? 'Preparing...' : 'Download Workpaper Excel'}
          </button>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      <div className="overflow-auto border border-slate-200 rounded">
        <ReportTableToolbar query={controls.query} onQueryChange={controls.setQuery} sort={controls.sort} onSortChange={controls.setSort} options={[{ key: 'rate', label: 'Tax rate' }, { key: 'taxable', label: 'Taxable' }, { key: 'tax', label: 'Total tax' }, { key: 'lines', label: 'Lines' }]} />
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Tax Rate</th>
              <th className="text-right px-3 py-2">{reportKind === 'gstr1' ? 'Invoices' : 'Bills'}</th>
              <th className="text-right px-3 py-2">Lines</th>
              <th className="text-right px-3 py-2">Taxable</th>
              <th className="text-right px-3 py-2">CGST</th>
              <th className="text-right px-3 py-2">SGST</th>
              <th className="text-right px-3 py-2">IGST</th>
              <th className="text-right px-3 py-2">Cess</th>
              <th className="text-right px-3 py-2">Total Tax</th>
            </tr>
          </thead>
          <tbody>
            {controls.filteredRows.map((r) => (
              <tr key={r.rate_bps} className="border-t border-slate-100">
                <td className="px-3 py-1.5">{(r.rate_bps / 100).toFixed(2)}%</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.invoice_count}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.line_count}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.taxable_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.cgst_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.sgst_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.igst_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.cess_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                  {money(addPaise(addPaise(r.cgst_paise, r.sgst_paise), addPaise(r.igst_paise, r.cess_paise)))}
                </td>
              </tr>
            ))}
            {controls.filteredRows.length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                  No taxable {reportKind === 'gstr1' ? 'outward supplies' : 'inward purchases'} in this period.
                </td>
              </tr>
            )}
          </tbody>
          {controls.filteredRows.length > 0 && (
            <tfoot className="bg-slate-50 font-semibold">
              <tr>
                <td className="px-3 py-2 text-right">Totals</td>
                <td className="px-3 py-2 text-right tabular-nums">—</td>
                <td className="px-3 py-2 text-right tabular-nums">{totals.lines}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(totals.taxable)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(totals.cgst)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(totals.sgst)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(totals.igst)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(totals.cess)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(addPaise(addPaise(totals.cgst, totals.sgst), addPaise(totals.igst, totals.cess)))}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
