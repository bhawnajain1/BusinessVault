import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Payment, Supplier } from '../../db/types';
import {
  PaymentService,
  PaymentRestoreConflictError,
} from '../../domain/PaymentService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import Money from '../components/Money';

// Recycle Bin for payments — lists every payment that has been soft-deleted
// (moved to bin) via PaymentsPage → Actions → Recycle. Restore rehydrates the
// original allocation shape; if some slice can no longer fit its target (e.g.
// the invoice has been fully paid by another payment in the meantime), the
// service throws PaymentRestoreConflictError. The UI then prompts once and
// retries with allow_partial:true, which lets the shortfall flow to advance.
export default function PaymentsRecycleBinPage() {
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [rows, setRows] = useState<Payment[]>([]);
  const [partyById, setPartyById] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!businessId) return;
    setError(null);
    try {
      const svc = new PaymentService();
      const [recycled, customers, suppliers] = await Promise.all([
        svc.listRecycledPayments(businessId),
        db.customers.where('business_id').equals(businessId).toArray() as Promise<
          Customer[]
        >,
        db.suppliers.where('business_id').equals(businessId).toArray() as Promise<
          Supplier[]
        >,
      ]);
      recycled.sort((a, b) =>
        (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''),
      );
      setRows(recycled);
      const map = new Map<string, string>();
      customers.forEach((c) => map.set(c.id, c.name));
      suppliers.forEach((s) => map.set(s.id, s.name));
      setPartyById(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [businessId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function restore(p: Payment) {
    if (!businessId || !deviceId) return;
    setBusyId(p.id);
    setError(null);
    const svc = new PaymentService();
    try {
      await svc.restorePayment({
        business_id: businessId,
        device_id: deviceId,
        payment_id: p.id,
      });
      await reload();
    } catch (e) {
      if (e instanceof PaymentRestoreConflictError) {
        // Shortfall — offer to restore what fits + park the rest as advance.
        const lines = e.conflicts
          .map(
            (c) =>
              `  ${c.target_number}: needed ₹${(
                c.requested_paise / 100
              ).toFixed(2)}, room ₹${(c.available_paise / 100).toFixed(2)}`,
          )
          .join('\n');
        const ok = window.confirm(
          `Some allocations for Payment ${p.payment_number} no longer fit — the target invoice/bill has been settled by other activity since it was deleted.\n\n${lines}\n\nRestore what fits and park the shortfall as an on-account advance?`,
        );
        if (!ok) {
          setBusyId(null);
          return;
        }
        try {
          await svc.restorePayment({
            business_id: businessId,
            device_id: deviceId,
            payment_id: p.id,
            allow_partial: true,
          });
          await reload();
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
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
          <Link to="/payments" className="text-sm text-blue-700 hover:underline">
            ← Payments
          </Link>
          <h1 className="text-xl font-semibold">Payments Recycle Bin</h1>
        </div>
        <span className="text-sm text-slate-500">
          {rows.length} deleted payment{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && <div className="text-sm text-rose-600">{error}</div>}

      {rows.length === 0 ? (
        <div className="text-sm text-slate-500 border border-dashed border-slate-300 rounded p-8 text-center">
          No deleted payments. Payments you move to the Recycle Bin from the
          Payments list appear here and can be restored.
        </div>
      ) : (
        <div className="border border-slate-200 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2">Payment #</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Party</th>
                <th className="text-left px-3 py-2">Method</th>
                <th className="text-right px-3 py-2">Amount</th>
                <th className="text-left px-3 py-2">Deleted</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.payment_number}
                  </td>
                  <td className="px-3 py-2">{r.payment_date}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        r.direction === 'in'
                          ? 'inline-block text-xs bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5'
                          : 'inline-block text-xs bg-rose-100 text-rose-800 rounded px-1.5 py-0.5'
                      }
                    >
                      {r.direction === 'in' ? 'In' : 'Out'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {partyById.get(r.party_id) ?? r.party_id}
                  </td>
                  <td className="px-3 py-2">{r.method}</td>
                  <td className="px-3 py-2 text-right">
                    <Money paise={r.amount_paise} />
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
