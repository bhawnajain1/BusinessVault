import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../../db';
import type {
  Advance,
  AuditLogEntry,
  Customer,
  Invoice,
  Item,
  JournalEntry,
  JournalLine,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
  Warehouse,
} from '../../db/types';
import { SalesReturnService, SalesReturnValidationError } from '../../domain/SalesReturnService';
import Money from '../components/Money';
import Qty from '../components/Qty';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { log } from '../../lib/log';

// Dedicated view for a single Sales Return. Shows header, per-line rows,
// stock movements, the reversing JE (with lines), customer-credit advance
// (if any), and the audit-log trail. Cancel action posts a reversal JE +
// reverses stock + restores balance in one atomic tx via SalesReturnService.

interface Loaded {
  sr: SalesReturn;
  items: SalesReturnItem[];
  originalInvoice: Invoice | undefined;
  customer: Customer | undefined;
  itemById: Map<string, Item>;
  warehouseById: Map<string, Warehouse>;
  journal: JournalEntry | undefined;
  journalLines: JournalLine[];
  reversalJournal: JournalEntry | undefined;
  reversalJournalLines: JournalLine[];
  creditAdvance: Advance | undefined;
  stockMovements: StockMovement[];
  auditRows: AuditLogEntry[];
}

export default function SalesReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async (isAlive?: () => boolean): Promise<void> => {
    if (!id) return;
    const alive = () => (isAlive ? isAlive() : true);
    setError(null);
    try {
      const sr = await db.sales_returns.get(id);
      if (!alive()) return;
      if (!sr) throw new Error('Sales return not found.');
      if (businessId && sr.business_id !== businessId) {
        throw new Error('This sales return belongs to a different business.');
      }
      const [items, originalInvoice, customer, journal] = await Promise.all([
        db.sales_return_items.where('sales_return_id').equals(sr.id).toArray(),
        db.invoices.get(sr.original_invoice_id),
        db.customers.get(sr.customer_id),
        db.journal_entries.get(sr.journal_entry_id),
      ]);
      items.sort((a, b) => a.line_no - b.line_no);
      const [journalLines, stockMovements] = await Promise.all([
        journal
          ? db.journal_lines.where('entry_id').equals(journal.id).toArray()
          : Promise.resolve([] as JournalLine[]),
        db.stock_movements
          .where('[business_id+ref_type+ref_id]')
          .equals([sr.business_id, 'reversal', sr.id])
          .toArray(),
      ]);
      stockMovements.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));

      // Reversal JE (posted on cancel). Referenced by reverses_id = original.id.
      let reversalJournal: JournalEntry | undefined;
      let reversalJournalLines: JournalLine[] = [];
      if (journal?.reversed_by_id) {
        reversalJournal = await db.journal_entries.get(journal.reversed_by_id);
        if (reversalJournal) {
          reversalJournalLines = await db.journal_lines
            .where('entry_id')
            .equals(reversalJournal.id)
            .toArray();
          reversalJournalLines.sort((a, b) => a.line_no - b.line_no);
        }
      }

      // Credit advance created by this SR, if any. Reference format:
      // 'sales_return:<return_number>'.
      const creditAdvance = (
        await db.advances
          .where('business_id')
          .equals(sr.business_id)
          .filter((a) => a.reference === `sales_return:${sr.return_number}`)
          .toArray()
      )[0];

      const itemIds = Array.from(new Set(items.map((it) => it.item_id)));
      const whIds = Array.from(new Set(items.map((it) => it.warehouse_id)));
      const itemById = new Map<string, Item>();
      const warehouseById = new Map<string, Warehouse>();
      await Promise.all(
        itemIds.map(async (iid) => {
          const it = await db.items.get(iid);
          if (it) itemById.set(iid, it);
        }),
      );
      await Promise.all(
        whIds.map(async (wid) => {
          const w = await db.warehouses.get(wid);
          if (w) warehouseById.set(wid, w);
        }),
      );

      // Audit rows for this SR entity.
      const auditRows = await db.audit_log
        .where('[business_id+entity_type+entity_id]')
        .equals([sr.business_id, 'sales_return', sr.id])
        .toArray();
      auditRows.sort((a, b) => (a.at < b.at ? 1 : -1));

      if (!alive()) return;
      setData({
        sr,
        items,
        originalInvoice,
        customer,
        itemById,
        warehouseById,
        journal,
        journalLines: journalLines.sort((a, b) => a.line_no - b.line_no),
        reversalJournal,
        reversalJournalLines,
        creditAdvance,
        stockMovements,
        auditRows,
      });
      log.debug('salesReturnDetail', 'loaded', {
        returnId: sr.id,
        returnNumber: sr.return_number,
        itemCount: items.length,
        hasReversalJe: !!reversalJournal,
        auditCount: auditRows.length,
      });
    } catch (e) {
      if (!alive()) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, businessId]);

  useEffect(() => {
    let alive = true;
    void load(() => alive);
    return () => {
      alive = false;
    };
  }, [load]);

  async function onCancel(): Promise<void> {
    if (!data || !businessId) return;
    if (data.sr.status === 'cancelled') return;
    const reason = window.prompt(
      `Cancel sales return ${data.sr.return_number}?\n\nA reversal journal entry will be posted, stock movements will be reversed, and invoice balance will be restored. If a customer credit was issued and any of it has been applied elsewhere, cancel will refuse.\n\nEnter cancel reason:`,
      '',
    );
    if (reason === null) return;
    setCancelling(true);
    setError(null);
    try {
      const svc = new SalesReturnService(db);
      await svc.cancelSalesReturn(data.sr.id, businessId, reason.trim());
      await load();
    } catch (e) {
      const msg =
        e instanceof SalesReturnValidationError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
    } finally {
      setCancelling(false);
    }
  }

  if (loading) return <div className="p-6 text-fg-muted">Loading...</div>;
  if (!businessId || !deviceId) {
    return (
      <div className="p-6 text-fg-muted">
        No active business — complete onboarding first.
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="p-6 space-y-3">
        <div className="text-rose-600 text-sm">{error}</div>
        <Link to="/returns" className="text-sm text-blue-700 hover:underline">
          ← Back to returns
        </Link>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-fg-muted">Loading return…</div>;

  const { sr, items, originalInvoice, customer, itemById, warehouseById } = data;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Link to="/returns" className="text-sm text-blue-700 hover:underline">
            ← All sales returns
          </Link>
          <h1 className="text-xl font-semibold text-fg">
            Sales return <span className="font-mono">{sr.return_number}</span>
            <span
              className={
                sr.status === 'cancelled'
                  ? 'ml-2 text-xs font-normal px-2 py-0.5 rounded bg-slate-200 text-slate-700'
                  : 'ml-2 text-xs font-normal px-2 py-0.5 rounded bg-emerald-100 text-emerald-800'
              }
            >
              {sr.status}
            </span>
          </h1>
          <div className="text-sm text-fg-muted">
            {sr.return_date} · Against{' '}
            {originalInvoice ? (
              <Link
                to={`/invoices/${originalInvoice.id}`}
                className="font-mono text-blue-700 hover:underline"
              >
                {originalInvoice.invoice_number}
              </Link>
            ) : (
              '(invoice not found)'
            )}
            {customer && (
              <>
                {' · '}
                <Link
                  to={`/customers/${customer.id}`}
                  className="text-blue-700 hover:underline"
                >
                  {customer.name}
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {sr.status === 'posted' && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="text-sm border border-rose-300 text-rose-700 rounded px-3 py-1.5 hover:bg-rose-50 disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel return'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="text-rose-700 text-sm bg-rose-50 border border-rose-200 rounded p-2 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Summary */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <SummaryTile label="Reason" value={sr.reason || '—'} />
        <SummaryTile label="Total" value={<Money paise={sr.total_paise} />} />
        <SummaryTile label="Taxable" value={<Money paise={sr.taxable_paise} />} />
        <SummaryTile
          label="Tax"
          value={
            <Money
              paise={sr.cgst_paise + sr.sgst_paise + sr.igst_paise + sr.cess_paise}
            />
          }
        />
      </section>

      {sr.notes && (
        <section className="text-sm text-fg whitespace-pre-wrap bg-surface border border-border rounded p-3">
          <div className="text-xs uppercase text-fg-muted mb-1">Notes</div>
          {sr.notes}
        </section>
      )}

      {/* Returned lines */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">Returned lines</h2>
        <div className="border border-border rounded overflow-hidden bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-hover text-xs uppercase text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2 w-10">#</th>
                <th className="text-left px-3 py-2">Item</th>
                <th className="text-left px-3 py-2">Warehouse</th>
                <th className="text-right px-3 py-2">Qty</th>
                <th className="text-right px-3 py-2">Unit price</th>
                <th className="text-right px-3 py-2">Taxable</th>
                <th className="text-right px-3 py-2">Tax</th>
                <th className="text-right px-3 py-2">Line total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-border">
                  <td className="px-3 py-1.5 text-fg-muted">{it.line_no}</td>
                  <td className="px-3 py-1.5">
                    <div>{itemById.get(it.item_id)?.name ?? it.description}</div>
                    <div className="text-xs text-fg-muted font-mono">
                      {it.hsn ? `HSN ${it.hsn}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    {warehouseById.get(it.warehouse_id)?.name ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <Qty micros={it.qty_micros} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <Money paise={it.unit_price_paise} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <Money paise={it.taxable_paise} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <Money
                      paise={
                        it.cgst_paise + it.sgst_paise + it.igst_paise + it.cess_paise
                      }
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <Money paise={it.line_total_paise} />
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-fg-subtle">
                    No lines on this return.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Journal entry */}
      {data.journal && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg">
            Journal entry{' '}
            <span className="font-mono text-fg-muted">{data.journal.entry_number}</span>
          </h2>
          <JournalTable lines={data.journalLines} />
        </section>
      )}

      {/* Reversal JE (cancel) */}
      {data.reversalJournal && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg">
            Reversal (cancellation){' '}
            <span className="font-mono text-fg-muted">
              {data.reversalJournal.entry_number}
            </span>
          </h2>
          <JournalTable lines={data.reversalJournalLines} />
        </section>
      )}

      {/* Stock movements */}
      {data.stockMovements.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg">Stock movements</h2>
          <div className="border border-border rounded overflow-hidden bg-surface">
            <table className="w-full text-sm">
              <thead className="bg-surface-hover text-xs uppercase text-fg-muted">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-left px-3 py-2">Warehouse</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-left px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.stockMovements.map((mv) => (
                  <tr key={mv.id} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono text-xs">{mv.occurred_at}</td>
                    <td className="px-3 py-1.5">
                      {itemById.get(mv.item_id)?.name ?? mv.item_id}
                    </td>
                    <td className="px-3 py-1.5">
                      {warehouseById.get(mv.warehouse_id)?.name ?? mv.warehouse_id}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <Qty micros={mv.qty_micros} />
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted">{mv.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Customer credit */}
      {data.creditAdvance && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg">Customer credit</h2>
          <div className="border border-border rounded bg-surface p-3 text-sm flex items-center justify-between">
            <div>
              <div className="font-mono">
                {data.creditAdvance.advance_number}
              </div>
              <div className="text-fg-muted text-xs">
                Applied so far:{' '}
                <Money
                  paise={
                    data.creditAdvance.amount_paise -
                    data.creditAdvance.remaining_paise
                  }
                />{' '}
                / <Money paise={data.creditAdvance.amount_paise} />
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className="text-xs text-fg-muted">Remaining</div>
              <Money paise={data.creditAdvance.remaining_paise} />
            </div>
          </div>
        </section>
      )}

      {/* Audit trail */}
      {data.auditRows.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg">Audit trail</h2>
          <div className="border border-border rounded overflow-hidden bg-surface">
            <table className="w-full text-sm">
              <thead className="bg-surface-hover text-xs uppercase text-fg-muted">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-left px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Actor</th>
                  <th className="text-left px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.auditRows.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="px-3 py-1.5 font-mono text-xs">{row.at}</td>
                    <td className="px-3 py-1.5">{row.action}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{row.actor}</td>
                    <td className="px-3 py-1.5 text-xs text-fg-muted whitespace-pre-wrap">
                      <pre className="whitespace-pre-wrap">
                        {JSON.stringify(row.after, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded bg-surface p-2">
      <div className="text-xs uppercase text-fg-muted">{label}</div>
      <div className="text-sm mt-1 font-medium">{value}</div>
    </div>
  );
}

function JournalTable({ lines }: { lines: JournalLine[] }) {
  const totalDebit = lines.reduce((s, l) => s + l.debit_paise, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit_paise, 0);
  return (
    <div className="border border-border rounded overflow-hidden bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-hover text-xs uppercase text-fg-muted">
          <tr>
            <th className="text-left px-3 py-2 w-10">#</th>
            <th className="text-left px-3 py-2">Description</th>
            <th className="text-right px-3 py-2">Debit</th>
            <th className="text-right px-3 py-2">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-border">
              <td className="px-3 py-1.5 text-fg-muted">{l.line_no}</td>
              <td className="px-3 py-1.5">{l.description}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {l.debit_paise ? <Money paise={l.debit_paise} /> : ''}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {l.credit_paise ? <Money paise={l.credit_paise} /> : ''}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-surface-hover font-medium">
            <td className="px-3 py-1.5" colSpan={2}>
              Totals
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums">
              <Money paise={totalDebit} />
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums">
              <Money paise={totalCredit} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
