import { useEffect, useState } from 'react';
import { db } from '../../db';
import type { Advance, Invoice, Payment, Purchase } from '../../db/types';
import { paymentLifecycle } from '../../domain/paymentState';
import Money from '../components/Money';

interface Props {
  payment: Payment;
  partyName: string;
  onClose: () => void;
}

// Read-only detail view. Shown when the user clicks "View" in the Payments
// grid. Deliberately compact — no revision history yet (that's PR3 territory).
export default function ViewPaymentModal({ payment, partyName, onClose }: Props) {
  const [invoiceById, setInvoiceById] = useState<Map<string, Invoice>>(new Map());
  const [billById, setBillById] = useState<Map<string, Purchase>>(new Map());
  const [advanceById, setAdvanceById] = useState<Map<string, Advance>>(new Map());

  useEffect(() => {
    let alive = true;
    (async () => {
      const invIds = payment.allocations
        .map((a) => a.invoice_id)
        .filter((x): x is string => Boolean(x));
      const billIds = payment.allocations
        .map((a) => a.bill_id)
        .filter((x): x is string => Boolean(x));
      const advIds = payment.allocations
        .map((a) => a.advance_id)
        .filter((x): x is string => Boolean(x));

      const [invs, bills, advs] = await Promise.all([
        invIds.length ? db.invoices.bulkGet(invIds) : Promise.resolve([]),
        billIds.length ? db.purchases.bulkGet(billIds) : Promise.resolve([]),
        advIds.length ? db.advances.bulkGet(advIds) : Promise.resolve([]),
      ]);
      if (!alive) return;
      setInvoiceById(new Map((invs ?? []).filter(Boolean).map((i) => [i!.id, i as Invoice])));
      setBillById(new Map((bills ?? []).filter(Boolean).map((b) => [b!.id, b as Purchase])));
      setAdvanceById(new Map((advs ?? []).filter(Boolean).map((a) => [a!.id, a as Advance])));
    })();
    return () => {
      alive = false;
    };
  }, [payment]);

  const totalAllocated = payment.allocations.reduce((s, a) => s + a.amount_paise, 0);
  const unallocated = Math.max(0, payment.amount_paise - totalAllocated);
  const state = paymentLifecycle(payment);

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="bg-white rounded shadow-lg w-full max-w-xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-semibold">
            Payment {payment.payment_number}
            <span
              className={
                'ml-2 text-xs px-1.5 py-0.5 rounded ' +
                (payment.direction === 'in'
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-rose-100 text-rose-800')
              }
            >
              {payment.direction === 'in' ? 'Payment In' : 'Payment Out'}
            </span>
            {state !== 'ACTIVE' && (
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                {state}
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-900"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="px-4 py-3 text-sm flex flex-col gap-2">
          <Row label="Party">{partyName}</Row>
          <Row label="Date">{payment.payment_date}</Row>
          <Row label="Method">{payment.method}</Row>
          <Row label="Reference">{payment.reference || '—'}</Row>
          <Row label="Notes">{payment.notes || '—'}</Row>
          <Row label="Amount">
            <span className="font-semibold">
              <Money paise={payment.amount_paise} />
            </span>
          </Row>
          {payment.revision != null && (
            <Row label="Revision">#{payment.revision}</Row>
          )}

          <div className="border-t border-slate-100 pt-2 mt-1">
            <div className="text-slate-600 mb-1">Allocations</div>
            {payment.allocations.length === 0 ? (
              <div className="text-xs text-slate-500">No allocations.</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left">Target</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payment.allocations.map((a, idx) => {
                    let label = '';
                    if (a.invoice_id) {
                      label = `Invoice ${
                        invoiceById.get(a.invoice_id)?.invoice_number ??
                        a.invoice_id.slice(-8)
                      }`;
                    } else if (a.bill_id) {
                      label = `Bill ${
                        billById.get(a.bill_id)?.bill_number ?? a.bill_id.slice(-8)
                      }`;
                    } else if (a.advance_id) {
                      label = `Advance ${
                        advanceById.get(a.advance_id)?.advance_number ??
                        a.advance_id.slice(-8)
                      }`;
                    } else {
                      label = '(unallocated)';
                    }
                    return (
                      <tr key={idx} className="border-t border-slate-100">
                        <td className="py-1">{label}</td>
                        <td className="py-1 text-right">
                          <Money paise={a.amount_paise} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="text-slate-600">
                  <tr className="border-t border-slate-200">
                    <td className="py-1">Total allocated</td>
                    <td className="py-1 text-right font-medium">
                      <Money paise={totalAllocated} />
                    </td>
                  </tr>
                  {unallocated > 0 && (
                    <tr>
                      <td className="py-1 text-blue-700">On account (advance)</td>
                      <td className="py-1 text-right text-blue-700">
                        <Money paise={unallocated} />
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            )}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="text-slate-500">{label}</div>
      <div className="col-span-2">{children}</div>
    </div>
  );
}
