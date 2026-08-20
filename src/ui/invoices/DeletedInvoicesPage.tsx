import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Invoice } from '../../db/types';
import { InvoiceService } from '../../domain/InvoiceService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import Money from '../components/Money';
import StatusBadge from '../components/StatusBadge';

export default function DeletedInvoicesPage() {
  const { businessId, loading } = useActiveBusiness();
  const [rows, setRows] = useState<Invoice[]>([]);
  const [customerById, setCustomerById] = useState<Map<string, Customer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!businessId) return;
    setError(null);
    try {
      const [invoices, customers] = await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.customers.where('business_id').equals(businessId).toArray(),
      ]);
      const deleted = invoices
        .filter((i) => !!i.deleted_at)
        .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''));
      setRows(deleted);
      setCustomerById(new Map(customers.map((c) => [c.id, c])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [businessId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function restore(inv: Invoice) {
    setBusyId(inv.id);
    try {
      const svc = new InvoiceService();
      await svc.restoreInvoice(inv.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId) {
    return (
      <div className="p-6 text-slate-600">
        No active business — complete onboarding first.
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/invoices" className="text-sm text-blue-700 hover:underline">
            ← Invoices
          </Link>
          <h1 className="text-xl font-semibold">Recycle Bin</h1>
        </div>
        <span className="text-sm text-slate-500">
          {rows.length} deleted invoice{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && <div className="text-sm text-rose-600">{error}</div>}

      {rows.length === 0 ? (
        <div className="text-sm text-slate-500 border border-dashed border-slate-300 rounded p-8 text-center">
          No deleted invoices. Items you delete from the Invoices list appear here
          and can be restored.
        </div>
      ) : (
        <div className="border border-slate-200 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2">Invoice #</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-right px-3 py-2">Total</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Deleted</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <Link
                      to={`/invoices/${r.id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {r.invoice_number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.invoice_date}</td>
                  <td className="px-3 py-2">
                    {customerById.get(r.customer_id)?.name ?? r.customer_id}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money paise={r.total_paise} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.deleted_at?.slice(0, 10) ?? ''}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.deleted_reason ?? ''}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => restore(r)}
                      disabled={busyId === r.id}
                      className="text-xs bg-slate-900 text-white rounded px-2.5 py-1 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {busyId === r.id ? 'Restoring...' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
