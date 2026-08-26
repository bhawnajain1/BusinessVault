import { useEffect, useMemo, useState } from 'react';
import { db } from '../../db';
import type {
  Invoice,
  InvoiceLine,
  Item,
  SalesReturn,
  SalesReturnItem,
  Unit,
} from '../../db/types';
import { SalesReturnService } from '../../domain/SalesReturnService';
import { log } from '../../lib/log';
import Money from '../components/Money';
import { formatQty } from '../components/Qty';

// Per-line sales-return picker. Given an invoice, renders one row per invoice
// line with a qty input capped at `available_to_return`. On submit, calls
// SalesReturnService.createSalesReturn with only the lines that have a
// positive requested qty and closes.
//
// Kept local — no need for a shared abstraction; Returns.tsx and InvoiceDetail
// both mount this component directly.
//
// Available math (authoritative — matches SalesReturnService's own guard):
//   available = original_line.qty_micros
//             - SUM(active sales_return_items.qty_micros where sales_return.status='posted')

interface Props {
  businessId: string;
  deviceId: string;
  invoiceId: string;
  onClose: () => void;
  onPosted: (sr: SalesReturn) => void;
}

interface LineRow {
  line: InvoiceLine;
  itemName: string;
  // §5.3: per-line columns must include the original economics from the
  // invoice line itself (never the current item-master), so a user can see
  // what they're getting refunded on. Unit is looked up from Item.unit_id.
  unitLabel: string;
  alreadyReturnedMicros: number;
  availableMicros: number;
  qtyStr: string; // user input, in display units (not micros)
}

function parseQtyToMicros(qtyStr: string): number {
  const trimmed = qtyStr.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 1_000_000);
}

export default function SalesReturnPicker({
  businessId,
  deviceId,
  invoiceId,
  onClose,
  onPosted,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [rows, setRows] = useState<LineRow[]>([]);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [returnDate, setReturnDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      log.info('salesReturnPicker', 'loading picker', { invoiceId });
      setLoading(true);
      try {
        const inv = await db.invoices.get(invoiceId);
        if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
        const lines = await db.invoice_lines
          .where('invoice_id')
          .equals(invoiceId)
          .sortBy('line_no');
        const items = await db.items
          .where('business_id')
          .equals(inv.business_id)
          .toArray();
        const itemById = new Map<string, Item>();
        for (const it of items) itemById.set(it.id, it);
        // Look up units once so we can render "PCS" / "KG" per row without
        // an N+1 fetch during render. Small dataset — full-table scan is fine.
        const units = await db.units
          .where('business_id')
          .equals(inv.business_id)
          .toArray();
        const unitById = new Map<string, Unit>();
        for (const u of units) unitById.set(u.id, u);

        // Authoritative already-returned per line: sum active
        // sales_return_items belonging to posted, non-deleted parents.
        const activeReturns = await db.sales_returns
          .where('[business_id+original_invoice_id]')
          .equals([inv.business_id, invoiceId])
          .toArray();
        const activeIds = new Set(
          activeReturns
            .filter((r) => r.status === 'posted' && !r.deleted_at)
            .map((r) => r.id),
        );
        const priorItems: SalesReturnItem[] = await db.sales_return_items
          .where('original_invoice_id')
          .equals(invoiceId)
          .toArray();
        const returnedByLine = new Map<string, number>();
        for (const it of priorItems) {
          if (!activeIds.has(it.sales_return_id)) continue;
          returnedByLine.set(
            it.original_invoice_line_id,
            (returnedByLine.get(it.original_invoice_line_id) ?? 0) +
              it.qty_micros,
          );
        }

        const nextRows: LineRow[] = lines.map((l) => {
          const alreadyReturned = returnedByLine.get(l.id) ?? 0;
          const available = Math.max(0, l.qty_micros - alreadyReturned);
          const it = itemById.get(l.item_id);
          const unit = it ? unitById.get(it.unit_id) : undefined;
          return {
            line: l,
            itemName: it?.name ?? l.description ?? l.item_id,
            unitLabel: unit?.code ?? unit?.name ?? '',
            alreadyReturnedMicros: alreadyReturned,
            availableMicros: available,
            qtyStr: '',
          };
        });
        if (cancelled) return;
        setInvoice(inv);
        setRows(nextRows);
        log.info('salesReturnPicker', 'picker ready', {
          invoiceId,
          invoiceNumber: inv.invoice_number,
          lineCount: nextRows.length,
          totalAvailableMicros: nextRows.reduce(
            (s, r) => s + r.availableMicros,
            0,
          ),
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        log.error('salesReturnPicker', 'failed to load picker', { invoiceId, error: msg });
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invoiceId]);

  function setRowQty(lineId: string, qtyStr: string) {
    setRows((prev) => prev.map((r) => (r.line.id === lineId ? { ...r, qtyStr } : r)));
  }

  function fillAll() {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        qtyStr:
          r.availableMicros > 0 ? (r.availableMicros / 1_000_000).toString() : '',
      })),
    );
  }

  function clearAll() {
    setRows((prev) => prev.map((r) => ({ ...r, qtyStr: '' })));
  }

  const parsedLines = useMemo(() => {
    // Parse rows into service input; validation happens against
    // availableMicros here so the user gets synchronous feedback (the
    // service will re-check anyway).
    const items: {
      lineId: string;
      qtyMicros: number;
      overAvailable: boolean;
      invalid: boolean;
    }[] = [];
    for (const r of rows) {
      const micros = parseQtyToMicros(r.qtyStr);
      if (Number.isNaN(micros)) {
        items.push({ lineId: r.line.id, qtyMicros: 0, overAvailable: false, invalid: true });
        continue;
      }
      items.push({
        lineId: r.line.id,
        qtyMicros: micros,
        overAvailable: micros > r.availableMicros,
        invalid: false,
      });
    }
    return items;
  }, [rows]);

  const anyInvalid = parsedLines.some((p) => p.invalid);
  const anyOver = parsedLines.some((p) => p.overAvailable);
  const nonZeroLines = parsedLines.filter((p) => p.qtyMicros > 0);
  const totalReturnMicros = nonZeroLines.reduce((s, p) => s + p.qtyMicros, 0);
  const canPost =
    !posting &&
    !anyInvalid &&
    !anyOver &&
    nonZeroLines.length > 0 &&
    reason.trim().length > 0;

  async function submit() {
    if (!invoice || !canPost) return;
    setPosting(true);
    setError(null);
    log.info('salesReturnPicker', 'submit clicked', {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      lineCount: nonZeroLines.length,
      totalReturnMicros,
    });
    try {
      const svc = new SalesReturnService(db);
      const sr = await svc.createSalesReturn({
        business_id: businessId,
        device_id: deviceId,
        original_invoice_id: invoiceId,
        return_date: returnDate,
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        lines: nonZeroLines.map((p) => ({
          original_invoice_line_id: p.lineId,
          qty_micros: p.qtyMicros,
        })),
      });
      log.info('salesReturnPicker', 'submit succeeded', {
        salesReturnId: sr.id,
        returnNumber: sr.return_number,
      });
      onPosted(sr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('salesReturnPicker', 'submit failed', { invoiceId, error: msg });
      setError(msg);
    } finally {
      setPosting(false);
    }
  }

  if (loading) {
    return <div className="p-4 text-fg-muted text-sm">Loading return picker…</div>;
  }
  if (!invoice) {
    return (
      <div className="p-4 text-danger text-sm">
        {error ?? 'Invoice not found.'}
      </div>
    );
  }

  return (
    <section className="border border-border rounded p-4 bg-surface flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-fg">
            Sales return for invoice{' '}
            <span className="font-mono">{invoice.invoice_number}</span>
          </h2>
          <p className="text-xs text-fg-subtle">
            Pick quantities line-by-line. Original invoice totals are preserved.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
      </div>

      <div className="text-sm text-fg-muted grid grid-cols-3 gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Invoice date</div>
          <div className="text-fg">{invoice.invoice_date}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Original total</div>
          <div className="text-fg tabular-nums">
            <Money paise={invoice.total_paise} />
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Outstanding balance</div>
          <div className="text-fg tabular-nums">
            <Money paise={invoice.balance_paise} />
          </div>
        </div>
      </div>

      {/* §5.3: per-line UI shows the ORIGINAL economics (rate, discount, GST)
          captured on the invoice line — never re-reads item master. */}
      <div className="border border-border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-hover text-xs uppercase text-fg-muted">
            <tr>
              <th className="text-left px-2 py-1.5">Item</th>
              <th className="text-right px-2 py-1.5 w-20">Sold qty</th>
              <th className="text-left px-2 py-1.5 w-14">Unit</th>
              <th className="text-right px-2 py-1.5 w-24">Prev. returned</th>
              <th className="text-right px-2 py-1.5 w-24">Available</th>
              <th className="text-right px-2 py-1.5 w-24">Orig. rate</th>
              <th className="text-right px-2 py-1.5 w-24">Discount</th>
              <th className="text-right px-2 py-1.5 w-20">GST %</th>
              <th className="text-right px-2 py-1.5 w-28">Return qty</th>
              <th className="text-right px-2 py-1.5 w-28">Return amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const parsed = parseQtyToMicros(r.qtyStr);
              const invalid = Number.isNaN(parsed);
              const over = !invalid && parsed > r.availableMicros;
              const frac =
                !invalid && r.line.qty_micros > 0
                  ? parsed / r.line.qty_micros
                  : 0;
              // "Return amount" preview mirrors what the service will post —
              // pro-rate the ORIGINAL line total by (return qty / sold qty).
              // Same rule the service uses when it splits GST + discount pro
              // rata; keeps the on-screen number consistent with the posted row.
              const projectedLinePaise = Math.round(r.line.line_total_paise * frac);
              const gstPct = (r.line.tax_rate_bps / 100).toFixed(
                r.line.tax_rate_bps % 100 === 0 ? 0 : 2,
              );
              return (
                <tr key={r.line.id} className="border-t border-border">
                  <td className="px-2 py-1.5">{r.itemName}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatQty(r.line.qty_micros)}
                  </td>
                  <td className="px-2 py-1.5 text-fg-muted">
                    {r.unitLabel || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">
                    {formatQty(r.alreadyReturnedMicros)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatQty(r.availableMicros)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    <Money paise={r.line.unit_price_paise} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">
                    {r.line.discount_paise > 0 ? (
                      <Money paise={r.line.discount_paise} />
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">
                    {gstPct}%
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={r.qtyStr}
                      onChange={(e) => setRowQty(r.line.id, e.target.value)}
                      disabled={r.availableMicros === 0}
                      placeholder={r.availableMicros === 0 ? '—' : '0'}
                      className={`w-24 text-right border rounded px-2 py-1 bg-surface text-fg tabular-nums ${
                        invalid || over
                          ? 'border-danger text-danger'
                          : 'border-border'
                      }`}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">
                    {!invalid && parsed > 0 && !over ? (
                      <Money paise={projectedLinePaise} />
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-fg-subtle">
                  Invoice has no lines to return.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={fillAll}
          className="text-blue-700 hover:underline"
        >
          Fill max on every line
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="text-fg-muted hover:text-fg"
        >
          Clear all
        </button>
        <span className="ml-auto text-fg-muted">
          Selected lines: <span className="text-fg">{nonZeroLines.length}</span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col text-sm">
          <span className="text-fg-muted mb-1">Return date</span>
          <input
            type="date"
            value={returnDate}
            onChange={(e) => setReturnDate(e.target.value)}
            className="border border-border rounded px-2 py-1.5 bg-surface text-fg"
          />
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-fg-muted mb-1">Reason for return</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Damaged goods"
            className="border border-border rounded px-2 py-1.5 bg-surface text-fg"
          />
        </label>
      </div>

      <label className="flex flex-col text-sm">
        <span className="text-fg-muted mb-1">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="border border-border rounded px-2 py-1.5 bg-surface text-fg"
        />
      </label>

      {(anyInvalid || anyOver) && (
        <div className="text-xs text-danger">
          {anyInvalid
            ? 'One or more return quantities are invalid.'
            : 'One or more return quantities exceed the available amount.'}
        </div>
      )}

      {error && (
        <div className="text-sm text-danger border border-danger/40 bg-danger/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canPost}
          className="bg-accent text-accent-fg text-sm rounded px-4 py-2 font-medium disabled:opacity-50"
        >
          {posting ? 'Posting…' : 'Post sales return'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm border border-border rounded px-3 py-2 hover:bg-surface-hover"
        >
          Back
        </button>
      </div>

      <p className="text-xs text-fg-subtle">
        Restores stock, posts a reversing journal, and either reduces the invoice
        balance or issues a customer credit for the excess. The original invoice
        is unchanged.
      </p>
    </section>
  );
}
