import { useCallback, useState } from 'react';
import {
  exportBusinessZip,
  downloadBlob,
  type ExportResult,
} from '../../export/businessZipExport';

// Spec §36 — Data Export Guarantee UI.
// Two checkboxes let the customer decide whether invoice PDFs and
// attachments are bundled. CSVs + manifest + schema + README are always in.

interface Props {
  businessId: string;
}

export default function DataExport({ businessId }: Props) {
  const [includePdfs, setIncludePdfs] = useState(true);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onExport = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ pct: 0, msg: 'Starting…' });
    try {
      const out = await exportBusinessZip(businessId, {
        includePdfs,
        includeAttachments,
        onProgress: (fraction, message) =>
          setProgress({ pct: Math.round(fraction * 100), msg: message }),
      });
      setResult(out);
      downloadBlob(out.blob, out.filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [businessId, includePdfs, includeAttachments]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Export My Business</h2>
        <p className="mt-1 text-sm text-slate-600">
          Downloads a ZIP containing every CSV, the manifest, schema, and a
          README explaining the layout. This export is understandable without
          BusinessVault.
        </p>
      </div>

      <fieldset className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={includePdfs}
            onChange={(e) => setIncludePdfs(e.target.checked)}
            disabled={busy}
            className="h-4 w-4 rounded border-slate-300"
          />
          Include invoice PDFs
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={includeAttachments}
            onChange={(e) => setIncludeAttachments(e.target.checked)}
            disabled={busy}
            className="h-4 w-4 rounded border-slate-300"
          />
          Include attachments (purchase bills, expense receipts, product images)
        </label>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onExport}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Download ZIP'}
        </button>
        {progress && (
          <div className="flex-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full bg-indigo-600 transition-[width]"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-slate-600">
              {progress.msg} ({progress.pct}%)
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Exported <span className="font-mono">{result.filename}</span> —{' '}
          {result.fileCount} files, {(result.bytes / 1024).toFixed(1)} KB.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          Export failed: {error}
        </div>
      )}
    </div>
  );
}
