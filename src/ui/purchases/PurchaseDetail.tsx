import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db } from '../../db';
import type {
  Item,
  JournalEntry,
  JournalLine,
  Purchase,
  PurchaseLine,
  Supplier,
} from '../../db/types';
import Money from '../components/Money';
import Qty from '../components/Qty';
import StatusBadge from '../components/StatusBadge';
import MakePaymentModal from '../payments/MakePaymentModal';
import { useActiveBusiness } from '../hooks/useActiveBusiness';

interface Loaded {
  purchase: Purchase;
  lines: PurchaseLine[];
  supplier: Supplier | undefined;
  items: Map<string, Item>;
  journal: JournalEntry | undefined;
  journalLines: JournalLine[];
}

export default function PurchaseDetail() {
  const { id } = useParams<{ id: string }>();
  const { businessId, deviceId } = useActiveBusiness();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [makeOpen, setMakeOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const purchase = await db.purchases.get(id);
        if (!purchase) throw new Error(`Purchase not found: ${id}`);
        const [lines, supplier, journal] = await Promise.all([
          db.purchase_lines.where('purchase_id').equals(id).toArray(),
          db.suppliers.get(purchase.supplier_id),
          purchase.journal_entry_id
            ? db.journal_entries.get(purchase.journal_entry_id)
            : Promise.resolve(undefined),
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
        setData({ purchase, lines, supplier, items, journal, journalLines });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [id, reloadKey]);

  if (error) return <div className="p-6 text-rose-600">{error}</div>;
  if (!data) return <div className="p-6 text-slate-500">Loading...</div>;
  const { purchase, lines, supplier, items, journal, journalLines } = data;
  const isDebitNote = !!purchase.reverses_purchase_id;
  const superseded = !!purchase.reversed_by_purchase_id;

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/purchases" className="text-sm text-blue-700 hover:underline">
            ← Purchases
          </Link>
          <h1 className="text-xl font-semibold">Bill {purchase.bill_number}</h1>
          <StatusBadge status={purchase.status} />
          {isDebitNote && (
            <span className="text-xs text-slate-600">Debit Note</span>
          )}
        </div>
        {!superseded &&
          !isDebitNote &&
          purchase.status !== 'cancelled' &&
          purchase.balance_paise > 0 && (
            <button
              type="button"
              onClick={() => setMakeOpen(true)}
              className="text-sm bg-rose-700 text-white rounded px-3 py-1.5 hover:bg-rose-800"
            >
              Record Payment
            </button>
          )}
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div className="border border-slate-200 rounded p-3">
          <div className="text-slate-500">Supplier</div>
          <div className="font-medium">{supplier?.name ?? purchase.supplier_id}</div>
          {supplier?.gstin && <div className="text-slate-600">GSTIN: {supplier.gstin}</div>}
          {supplier?.address && (
            <div className="text-slate-600 whitespace-pre-wrap">{supplier.address}</div>
          )}
        </div>
        <div className="border border-slate-200 rounded p-3">
          <div className="text-slate-500">Dates</div>
          <div>Bill: {purchase.bill_date}</div>
          <div>Due: {purchase.due_date ?? '—'}</div>
          <div>FY: {purchase.financial_year}</div>
        </div>
        <div className="border border-slate-200 rounded p-3">
          <div className="text-slate-500">Supplier Bill #</div>
          <div>{purchase.supplier_bill_number || '—'}</div>
          <div className="text-slate-600">
            {purchase.is_interstate ? 'Interstate' : 'Intrastate'} —{' '}
            {purchase.supplier_state_code}
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
              <th className="text-right px-3 py-2">Unit Cost</th>
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
                  <Money paise={l.unit_cost_paise} />
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
          <Row label="Subtotal" paise={purchase.subtotal_paise} />
          <Row label="Discount" paise={-purchase.discount_paise} />
          <Row label="Taxable" paise={purchase.taxable_paise} />
          {purchase.cgst_paise !== 0 && <Row label="CGST" paise={purchase.cgst_paise} />}
          {purchase.sgst_paise !== 0 && <Row label="SGST" paise={purchase.sgst_paise} />}
          {purchase.igst_paise !== 0 && <Row label="IGST" paise={purchase.igst_paise} />}
          {purchase.round_off_paise !== 0 && (
            <Row label="Round off" paise={purchase.round_off_paise} />
          )}
          <div className="border-t border-slate-200 mt-2 pt-2">
            <Row label="Total" paise={purchase.total_paise} strong />
            <Row label="Paid" paise={purchase.paid_paise} />
            <Row label="Balance" paise={purchase.balance_paise} strong />
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

      {makeOpen && businessId && (
        <MakePaymentModal
          businessId={businessId}
          deviceId={deviceId ?? ''}
          preselectSupplierId={purchase.supplier_id}
          preselectBillId={purchase.id}
          preselectAmountPaise={purchase.balance_paise}
          lockToSupplier
          onClose={() => setMakeOpen(false)}
          onSaved={() => {
            setMakeOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
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
