import { useEffect, useMemo, useState } from 'react';
import { db } from '../../db';
import type { Invoice, InvoiceLine, Item } from '../../db/types';
import { downloadCsv } from '../../csv/streamCsvExport';
import { downloadGstrCsv, downloadGstrJson, downloadGstrExcel, buildGstrReport, type GstrReportKind } from '../../domain/gstrExport';
import { money, toDateString, financialYearStart } from './reportUtils';
import { useBusinessId } from './useBusinessId';

interface SlabRow {
  rate_bps: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  cess_paise: number;
  line_count: number;
  invoice_count: number;
}

export default function GstSummaryPage() {
  const { businessId, error: bizError } = useBusinessId();
  const today = new Date();
  const [fromStr, setFromStr] = useState<string>(toDateString(financialYearStart(today)));
  const [toStr, setToStr] = useState<string>(toDateString(today));
  const [rows, setRows] = useState<SlabRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reportKind, setReportKind] = useState<GstrReportKind>('gstr1');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const invoices: Invoice[] = await db.invoices
          .where('[business_id+invoice_date]')
          .between([businessId, fromStr], [businessId, toStr], true, true)
          .toArray();
        const invIds = new Set(
          invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled').map((i) => i.id),
        );
        const invById = new Map(invoices.map((i) => [i.id, i]));

        const allLines: InvoiceLine[] = await db.invoice_lines
          .where('business_id')
          .equals(businessId)
          .toArray();
        const lines = allLines.filter((l) => invIds.has(l.invoice_id));

        const items: Item[] = await db.items.where('business_id').equals(businessId).toArray();
        const itemById = new Map(items.map((i) => [i.id, i]));

        const bySlab = new Map<number, SlabRow & { _invIds: Set<string> }>();
        for (const l of lines) {
          const rate = l.tax_rate_bps > 0 ? l.tax_rate_bps : (itemById.get(l.item_id)?.tax_rate_bps ?? 0);
          const s = bySlab.get(rate) ?? {
            rate_bps: rate,
            taxable_paise: 0,
            cgst_paise: 0,
            sgst_paise: 0,
            igst_paise: 0,
            cess_paise: 0,
            line_count: 0,
            invoice_count: 0,
            _invIds: new Set<string>(),
          };
          s.taxable_paise += l.taxable_paise;
          s.cgst_paise += l.cgst_paise;
          s.sgst_paise += l.sgst_paise;
          s.igst_paise += l.igst_paise;
          s.cess_paise += l.cess_paise;
          s.line_count += 1;
          if (invById.get(l.invoice_id)) s._invIds.add(l.invoice_id);
          bySlab.set(rate, s);
        }
        const out: SlabRow[] = Array.from(bySlab.values())
          .map((s) => ({ ...s, invoice_count: s._invIds.size }))
          .sort((a, b) => a.rate_bps - b.rate_bps);

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
  }, [businessId, fromStr, toStr]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.taxable += r.taxable_paise;
        acc.cgst += r.cgst_paise;
        acc.sgst += r.sgst_paise;
        acc.igst += r.igst_paise;
        acc.cess += r.cess_paise;
        acc.lines += r.line_count;
        return acc;
      },
      { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, lines: 0 },
    );
  }, [rows]);

  async function exportCsv(): Promise<void> {
    await downloadCsv({
      columns: ['tax_rate_pct', 'invoice_count', 'line_count', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'total_tax'],
      rows,
      toRow: (r) => ({
        tax_rate_pct: (r.rate_bps / 100).toFixed(2),
        invoice_count: r.invoice_count,
        line_count: r.line_count,
        taxable: (r.taxable_paise / 100).toFixed(2),
        cgst: (r.cgst_paise / 100).toFixed(2),
        sgst: (r.sgst_paise / 100).toFixed(2),
        igst: (r.igst_paise / 100).toFixed(2),
        cess: (r.cess_paise / 100).toFixed(2),
        total_tax: ((r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise) / 100).toFixed(2),
      }),
      filename: `gst-summary-${fromStr}-to-${toStr}.csv`,
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
      const warnings = result.issues.filter((issue) => issue.severity === 'warning');
      if (warnings.length > 0) setErr(`Excel exported with ${warnings.length} validation warning(s). Verify GSTIN and filing-specific fields before submission.`);
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
          <h1 className="text-2xl font-semibold">GST Summary</h1>
          <p className="text-sm text-slate-500">Per-slab breakdown of outward supplies (GSTR-1 style).</p>
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
              <option value="gstr1">GSTR1 outward</option>
              <option value="gstr2">GSTR2 inward</option>
            </select>
          </label>
          <button onClick={() => void exportGstr('csv')} disabled={!businessId || exporting} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50">
            {exporting ? 'Preparing...' : 'Download GSTR CSV'}
          </button>
          <button onClick={() => void exportGstr('json')} disabled={!businessId || exporting} className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50">
            Download GSTR JSON
          </button>
          <button onClick={() => void exportGstrExcel()} disabled={!businessId || exporting} className="bg-slate-800 text-white rounded px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50">
            {exporting ? 'Preparing...' : 'Download GSTR Excel'}
          </button>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      <div className="overflow-auto border border-slate-200 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Tax Rate</th>
              <th className="text-right px-3 py-2">Invoices</th>
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
            {rows.map((r) => (
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
                  {money(r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                  No taxable outward supplies in this period.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
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
                  {money(totals.cgst + totals.sgst + totals.igst + totals.cess)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
