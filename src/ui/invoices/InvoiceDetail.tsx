import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../../db';
import { InvoiceService } from '../../domain/InvoiceService';
import type {
  Customer,
  Invoice,
  InvoiceLine,
  Item,
  JournalEntry,
  JournalLine,
} from '../../db/types';
import Money from '../components/Money';
import Qty from '../components/Qty';
import StatusBadge from '../components/StatusBadge';

interface Loaded {
  invoice: Invoice;
  lines: InvoiceLine[];
  customer: Customer | undefined;
  items: Map<string, Item>;
  journal: JournalEntry | undefined;
  journalLines: JournalLine[];
}

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function load() {
    if (!id) return;
    setError(null);
    try {
      const invoice = await db.invoices.get(id);
      if (!invoice) throw new Error(`Invoice not found: ${id}`);
      const [lines, customer, journal] = await Promise.all([
        db.invoice_lines.where('invoice_id').equals(id).toArray(),
        db.customers.get(invoice.customer_id),
        db.journal_entries.get(invoice.journal_entry_id),
      ]);
      const journalLines = journal
        ? await db.journal_lines.where('entry_id').equals(journal.id).toArray()
        : [];
      const itemIds = Array.from(new Set(lines.map((l) => l.item_id)));
      const items = new Map<string, Item>();
      for (const iid of itemIds) {
        const it = await db.items.get(iid);
        if (it) items.set(iid, it);
      }
      setData({ invoice, lines, customer, items, journal, journalLines });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function voidInvoice() {
    if (!data) return;
    if (!voidReason.trim()) return;
    setVoiding(true);
    try {
      const svc = new InvoiceService();
      await svc.voidInvoice(data.invoice.id, voidReason.trim());
      setVoidReason('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoiding(false);
    }
  }

  async function deleteInvoice() {
    if (!data) return;
    const ok = window.confirm(
      `Delete invoice ${data.invoice.invoice_number}?\n\nIt will move to Recycle Bin (Invoices → Deleted) and can be restored later.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const svc = new InvoiceService();
      await svc.deleteInvoice(data.invoice.id, 'deleted from detail');
      navigate('/invoices');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  if (error) return <div className="p-6 text-rose-600">{error}</div>;
  if (!data) return <div className="p-6 text-slate-500">Loading...</div>;
  const { invoice, lines, customer, items, journal, journalLines } = data;
  const alreadyVoided = !!invoice.reversed_by_invoice_id;
  const isCreditNote = !!invoice.reverses_invoice_id;

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/invoices" className="text-sm text-blue-700 hover:underline">
            ← Invoices
          </Link>
          <h1 className="text-xl font-semibold">
            Invoice {invoice.invoice_number}
          </h1>
          <StatusBadge status={invoice.status} />
          {alreadyVoided && <StatusBadge status="cancelled" />}
          {isCreditNote && (
            <span className="text-xs text-slate-600">Credit Note</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!alreadyVoided && invoice.status !== 'cancelled' && (
            <Link
              to={`/invoices/${invoice.id}/edit`}
              className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
            >
              Edit
            </Link>
          )}
          <Link
            to={`/invoices/${invoice.id}/print`}
            className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
          >
            Print / PDF
          </Link>
          <button
            type="button"
            onClick={deleteInvoice}
            disabled={deleting}
            className="text-sm border border-rose-300 text-rose-700 rounded px-3 py-1.5 hover:bg-rose-50 disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div className="border border-slate-200 rounded p-3">
          <div className="text-slate-500">Customer</div>
          <div className="font-medium">{customer?.name ?? invoice.customer_id}</div>
          {customer?.gstin && <div className="text-slate-600">GSTIN: {customer.gstin}</div>}
          {customer?.billing_address && (
            <div className="text-slate-600 whitespace-pre-wrap">{customer.billing_address}</div>
          )}
        </div>
        <div className="border border-slate-200 rounded p-3">
          <div className="text-slate-500">Dates</div>
          <div>Invoice: {invoice.invoice_date}</div>
          <div>Due: {invoice.due_date ?? '—'}</div>
          <div>FY: {invoice.financial_year}</div>
        </div>
        <div className="border border-slate-200 rounded p-3">
          <div className="text-slate-500">Place of Supply</div>
          <div>
            {invoice.place_of_supply} ({invoice.customer_state_code}){' '}
            {invoice.is_interstate ? '— Interstate' : '— Intrastate'}
          </div>
        </div>
      </div>

      <div className="border border-slate-200 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-3 py-2">#</th>
              <th className="text-left px-3 py-2">Item</th>
              <th className="text-left px-3 py-2">HSN</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Unit Price</th>
              <th className="text-right px-3 py-2">Taxable</th>
              <th className="text-right px-3 py-2">GST %</th>
              <th className="text-right px-3 py-2">CGST</th>
              <th className="text-right px-3 py-2">SGST</th>
              <th className="text-right px-3 py-2">IGST</th>
              <th className="text-right px-3 py-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{l.line_no}</td>
                <td className="px-3 py-2">
                  {items.get(l.item_id)?.name ?? l.item_id}
                  {l.description && (
                    <div className="text-xs text-slate-500">{l.description}</div>
                  )}
                </td>
                <td className="px-3 py-2">{l.hsn}</td>
                <td className="px-3 py-2 text-right">
                  <Qty micros={l.qty_micros} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Money paise={l.unit_price_paise} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Money paise={l.taxable_paise} />
                </td>
                <td className="px-3 py-2 text-right">{(l.tax_rate_bps / 100).toFixed(2)}%</td>
                <td className="px-3 py-2 text-right">
                  <Money paise={l.cgst_paise} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Money paise={l.sgst_paise} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Money paise={l.igst_paise} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Money paise={l.line_total_paise} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <div className="w-80 text-sm border border-slate-200 rounded p-3 space-y-1">
          <Row label="Subtotal" paise={invoice.subtotal_paise} />
          <Row label="Discount" paise={-invoice.discount_paise} />
          <Row label="Taxable" paise={invoice.taxable_paise} />
          {invoice.cgst_paise !== 0 && <Row label="CGST" paise={invoice.cgst_paise} />}
          {invoice.sgst_paise !== 0 && <Row label="SGST" paise={invoice.sgst_paise} />}
          {invoice.igst_paise !== 0 && <Row label="IGST" paise={invoice.igst_paise} />}
          {invoice.cess_paise !== 0 && <Row label="Cess" paise={invoice.cess_paise} />}
          {invoice.round_off_paise !== 0 && (
            <Row label="Round off" paise={invoice.round_off_paise} />
          )}
          <div className="border-t border-slate-200 mt-2 pt-2">
            <Row label="Total" paise={invoice.total_paise} strong />
            <Row label="Paid" paise={invoice.paid_paise} />
            <Row label="Balance" paise={invoice.balance_paise} strong />
          </div>
        </div>
      </div>

      {journal && (
        <div className="border border-slate-200 rounded">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-sm font-medium">
            Journal Entry {journal.entry_number} — {journal.narration}
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Account</th>
                <th className="text-right px-3 py-2">Debit</th>
                <th className="text-right px-3 py-2">Credit</th>
                <th className="text-left px-3 py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {journalLines.map((jl) => (
                <tr key={jl.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{jl.line_no}</td>
                  <td className="px-3 py-2">{jl.account_id}</td>
                  <td className="px-3 py-2 text-right">
                    {jl.debit_paise > 0 ? <Money paise={jl.debit_paise} /> : ''}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {jl.credit_paise > 0 ? <Money paise={jl.credit_paise} /> : ''}
                  </td>
                  <td className="px-3 py-2">{jl.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!alreadyVoided && !isCreditNote && invoice.status !== 'cancelled' && (
        <div className="border border-rose-200 rounded p-3 bg-rose-50">
          <div className="text-sm font-medium text-rose-800 mb-2">
            Void invoice (issues a credit note — the original stays for audit)
          </div>
          <div className="flex gap-2">
            <input
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Reason (required)"
              className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={voidInvoice}
              disabled={voiding || voidReason.trim().length === 0}
              className="text-sm bg-rose-600 text-white rounded px-3 py-1.5 hover:bg-rose-700 disabled:opacity-50"
            >
              {voiding ? 'Voiding...' : 'Void'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  paise,
  strong,
}: {
  label: string;
  paise: number;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${strong ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
    >
      <span>{label}</span>
      <Money paise={paise} />
    </div>
  );
}
