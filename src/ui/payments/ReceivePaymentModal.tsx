import { useEffect, useMemo, useState } from 'react';
import { ulid } from 'ulid';
import { db } from '../../db';
import type {
  Account,
  Advance,
  Customer,
  Invoice,
  Payment,
  PaymentMethod,
} from '../../db/types';
import { PaymentService } from '../../domain/PaymentService';
import { SYSTEM_ACCOUNT_CODES } from '../../domain/coa';
import { isPaymentActive, isAdvanceActive } from '../../domain/paymentState';
import Money from '../components/Money';

// Shared Receive-Payment modal used by:
//   - PaymentsPage           (+ Payment In button — customer picker required)
//   - CustomerDetailPage     (+ Add Payment — customer preselected)
//   - InvoiceDetail          (Record Payment — customer + invoice + amount preselected)
//
// Grug rule: 3+ call sites, no more premature-abstraction guilt. This IS the
// abstraction. It runs the entire flow inline — data fetch, allocation preview,
// service call, sync-log — so callers only pass preselect + close/success.

const METHODS: PaymentMethod[] = ['cash', 'upi', 'bank', 'cheque', 'card'];

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateShort(ymd: string): string {
  if (!ymd || ymd.length < 10) return ymd;
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

interface InvoiceRow {
  inv: Invoice;
  outstanding_paise: number;
}

// Derive outstanding for a single invoice from ACTIVE payments + ACTIVE
// advances + credit notes (invoices whose reverses_invoice_id === inv.id).
function deriveOpenInvoices(
  invoices: Invoice[],
  payments: Payment[],
  advances: Advance[],
): InvoiceRow[] {
  const creditsByOriginal = new Map<string, Invoice[]>();
  for (const cn of invoices) {
    if (!cn.reverses_invoice_id) continue;
    const arr = creditsByOriginal.get(cn.reverses_invoice_id) ?? [];
    arr.push(cn);
    creditsByOriginal.set(cn.reverses_invoice_id, arr);
  }
  const rows: InvoiceRow[] = [];
  for (const inv of invoices) {
    if (inv.reverses_invoice_id) continue; // skip credit notes
    if (inv.status === 'draft' || inv.status === 'cancelled') continue;
    let paid = 0;
    for (const p of payments) {
      if (!isPaymentActive(p)) continue;
      for (const a of p.allocations) if (a.invoice_id === inv.id) paid += a.amount_paise;
    }
    for (const adv of advances) {
      if (!isAdvanceActive(adv)) continue;
      for (const app of adv.applications)
        if (app.invoice_id === inv.id) paid += app.amount_paise;
    }
    const creditReduction = (creditsByOriginal.get(inv.id) ?? []).reduce(
      (s, cn) => s + Math.abs(cn.total_paise),
      0,
    );
    const outstanding = Math.max(0, inv.total_paise - paid - creditReduction);
    if (outstanding > 0) rows.push({ inv, outstanding_paise: outstanding });
  }
  return rows.sort((a, b) => {
    if (a.inv.invoice_date !== b.inv.invoice_date)
      return a.inv.invoice_date < b.inv.invoice_date ? -1 : 1;
    if (a.inv.invoice_number !== b.inv.invoice_number)
      return a.inv.invoice_number < b.inv.invoice_number ? -1 : 1;
    return a.inv.id < b.inv.id ? -1 : 1;
  });
}

export interface ReceivePaymentModalProps {
  businessId: string;
  deviceId: string;
  // Preselects — any subset:
  preselectCustomerId?: string;
  preselectInvoiceId?: string;
  preselectAmountPaise?: number;

  // When true, the customer picker is shown (Payments page case). When a
  // customer is preselected, the picker is hidden.
  customerPickerAllowed?: boolean;

  onClose: () => void;
  // Fired after successful save with the persisted Payment. Callers use this
  // to refresh their list / bump reloadKey.
  onSaved: (p: Payment) => void;
}

export default function ReceivePaymentModal(props: ReceivePaymentModalProps) {
  const {
    businessId,
    deviceId,
    preselectCustomerId,
    preselectInvoiceId,
    preselectAmountPaise,
    customerPickerAllowed,
    onClose,
    onSaved,
  } = props;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customerId, setCustomerId] = useState<string>(preselectCustomerId ?? '');
  const [customerQuery, setCustomerQuery] = useState('');

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [loadingParty, setLoadingParty] = useState(false);

  const [amountStr, setAmountStr] = useState<string>(
    preselectAmountPaise ? (preselectAmountPaise / 100).toFixed(2) : '',
  );
  const [date, setDate] = useState<string>(todayYmd());
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [accountId, setAccountId] = useState<string>('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [allocMode, setAllocMode] = useState<'auto' | 'manual'>(
    preselectInvoiceId ? 'manual' : 'auto',
  );
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load customers + accounts once.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [cs, accs] = await Promise.all([
        db.customers.where('business_id').equals(businessId).toArray(),
        db.accounts.where('business_id').equals(businessId).toArray(),
      ]);
      if (!alive) return;
      setCustomers(cs.sort((a, b) => (a.name < b.name ? -1 : 1)));
      setAccounts(accs);
      // default deposit account = system Cash
      const cash = accs.find((a) => a.code === SYSTEM_ACCOUNT_CODES.CASH);
      if (cash) setAccountId(cash.id);
    })();
    return () => {
      alive = false;
    };
  }, [businessId]);

  // Reload the customer's invoices / payments / advances on customer change.
  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      setPayments([]);
      setAdvances([]);
      return;
    }
    let alive = true;
    setLoadingParty(true);
    (async () => {
      const [invs, pays, advs] = await Promise.all([
        db.invoices
          .where('[business_id+customer_id]')
          .equals([businessId, customerId])
          .toArray(),
        db.payments
          .where('[business_id+direction]')
          .equals([businessId, 'in'])
          .filter((p) => p.party_id === customerId && p.party_type === 'customer')
          .toArray(),
        db.advances
          .where('business_id')
          .equals(businessId)
          .filter((a) => a.party_type === 'customer' && a.party_id === customerId)
          .toArray(),
      ]);
      if (!alive) return;
      setInvoices(invs);
      setPayments(pays);
      setAdvances(advs);
      setLoadingParty(false);
    })();
    return () => {
      alive = false;
    };
  }, [businessId, customerId]);

  const openInvoiceRows = useMemo(
    () => deriveOpenInvoices(invoices, payments, advances),
    [invoices, payments, advances],
  );

  // Once a customer + preselected invoice are both loaded, seed the amount +
  // manual allocation to that invoice's outstanding, unless the caller passed
  // an explicit preselectAmountPaise.
  useEffect(() => {
    if (!preselectInvoiceId) return;
    const row = openInvoiceRows.find((r) => r.inv.id === preselectInvoiceId);
    if (!row) return;
    const preselectPaise = preselectAmountPaise ?? row.outstanding_paise;
    setAmountStr((prev) =>
      prev && prev !== '0' ? prev : (preselectPaise / 100).toFixed(2),
    );
    setAllocations((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      return { [preselectInvoiceId]: (preselectPaise / 100).toFixed(2) };
    });
    setAllocMode('manual');
    // Only run once we have the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openInvoiceRows.length, preselectInvoiceId]);

  // On method change, pick cash for cash / bank for everything else.
  useEffect(() => {
    const cash = accounts.find((a) => a.code === SYSTEM_ACCOUNT_CODES.CASH);
    const bank = accounts.find((a) => a.code === SYSTEM_ACCOUNT_CODES.BANK);
    if (method === 'cash') {
      if (cash) setAccountId(cash.id);
    } else {
      if (bank) setAccountId(bank.id);
      else if (cash) setAccountId(cash.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  const paymentAmountPaise = useMemo(
    () => Math.round(Number(amountStr || '0') * 100),
    [amountStr],
  );

  const autoAllocations = useMemo(() => {
    if (!Number.isFinite(paymentAmountPaise) || paymentAmountPaise <= 0) return {};
    let remain = paymentAmountPaise;
    const out: Record<string, number> = {};
    for (const r of openInvoiceRows) {
      if (remain <= 0) break;
      const take = Math.min(r.outstanding_paise, remain);
      if (take > 0) {
        out[r.inv.id] = take;
        remain -= take;
      }
    }
    return out;
  }, [paymentAmountPaise, openInvoiceRows]);

  const effectiveAllocations = useMemo(() => {
    if (allocMode === 'auto') return autoAllocations;
    const out: Record<string, number> = {};
    for (const [invId, str] of Object.entries(allocations)) {
      const paise = Math.round(Number(str) * 100);
      if (Number.isFinite(paise) && paise > 0) out[invId] = paise;
    }
    return out;
  }, [allocMode, autoAllocations, allocations]);

  const effectiveAllocTotal = useMemo(
    () => Object.values(effectiveAllocations).reduce((s, n) => s + n, 0),
    [effectiveAllocations],
  );

  const advanceExcessPaise = Math.max(0, paymentAmountPaise - effectiveAllocTotal);

  const svc = useMemo(() => new PaymentService(), []);

  const customer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  );

  const filteredCustomers = useMemo(() => {
    if (!customerQuery.trim()) return customers.slice(0, 50);
    const q = customerQuery.toLowerCase();
    return customers.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50);
  }, [customers, customerQuery]);

  async function save() {
    setError(null);
    if (!customer) return setError('Pick a customer.');
    if (!Number.isFinite(paymentAmountPaise) || paymentAmountPaise <= 0)
      return setError('Payment amount must be positive.');
    if (!accountId) return setError('Pick a deposit account.');

    if (effectiveAllocTotal > paymentAmountPaise) {
      return setError(
        `Allocations total ₹${(effectiveAllocTotal / 100).toFixed(2)} exceeds payment amount ₹${(paymentAmountPaise / 100).toFixed(2)}.`,
      );
    }
    for (const [invId, paise] of Object.entries(effectiveAllocations)) {
      const row = openInvoiceRows.find((r) => r.inv.id === invId);
      if (!row) return setError(`Unknown invoice ${invId}.`);
      if (paise > row.outstanding_paise) {
        return setError(
          `Allocation to ${row.inv.invoice_number} exceeds outstanding ₹${(row.outstanding_paise / 100).toFixed(2)}.`,
        );
      }
    }

    const arAccount = accounts.find((a) => a.code === SYSTEM_ACCOUNT_CODES.RECEIVABLE);
    if (!arAccount)
      return setError('Receivable account (1200) missing in chart of accounts.');

    const paymentNumber = `PAY-${ulid().slice(-10)}`;
    const advanceNumber = advanceExcessPaise > 0 ? `ADV-${ulid().slice(-10)}` : undefined;

    const allocations_input = [
      ...Object.entries(effectiveAllocations).map(([invoice_id, amount_paise]) => ({
        invoice_id,
        amount_paise,
      })),
    ];
    if (advanceExcessPaise > 0) {
      allocations_input.push({
        as_advance: true,
        amount_paise: advanceExcessPaise,
        // invoice_id absent — service tags this slice as an on-account advance
      } as unknown as (typeof allocations_input)[number]);
    }

    setSaving(true);
    try {
      const p = await svc.createPayment({
        business_id: businessId,
        device_id: deviceId,
        payment_number: paymentNumber,
        payment_date: date,
        direction: 'in',
        party_type: 'customer',
        party_id: customer.id,
        method,
        cash_or_bank_account_id: accountId,
        ar_or_ap_account_id: arAccount.id,
        amount_paise: paymentAmountPaise,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        allocations: allocations_input,
        advance_number: advanceNumber,
      });
      onSaved(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const depositAccounts = accounts.filter(
    (a) =>
      a.active === 1 &&
      (a.code === SYSTEM_ACCOUNT_CODES.CASH || a.code === SYSTEM_ACCOUNT_CODES.BANK),
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="bg-white rounded shadow-lg w-full max-w-2xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-semibold">
            Receive Payment{customer ? ` — ${customer.name}` : ''}
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

        <div className="px-4 py-3 flex flex-col gap-3 text-sm">
          {customerPickerAllowed && !preselectCustomerId && (
            <div className="flex flex-col">
              <label className="text-slate-600 mb-1">Customer *</label>
              {customer ? (
                <div className="flex items-center gap-2">
                  <span className="font-medium">{customer.name}</span>
                  <button
                    type="button"
                    className="text-xs text-blue-700 hover:underline"
                    onClick={() => {
                      setCustomerId('');
                      setCustomerQuery('');
                      setAllocations({});
                    }}
                  >
                    change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    autoFocus
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    placeholder="Search customers…"
                    className="border border-slate-300 rounded px-2 py-1.5"
                  />
                  {(customerQuery || customers.length <= 20) && (
                    <div className="max-h-40 overflow-auto border border-slate-200 rounded mt-1 divide-y">
                      {filteredCustomers.length === 0 && (
                        <div className="text-xs text-slate-500 px-2 py-1.5">
                          No customers match.
                        </div>
                      )}
                      {filteredCustomers.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setCustomerId(c.id)}
                          className="w-full text-left px-2 py-1.5 hover:bg-slate-50 text-sm"
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col">
              <span className="text-slate-600 mb-1">Amount ₹ *</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 text-right"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-slate-600 mb-1">Payment date *</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-slate-600 mb-1">Payment method *</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                className="border border-slate-300 rounded px-2 py-1.5 bg-white"
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m === 'bank' ? 'bank transfer' : m}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-slate-600 mb-1">Deposit to *</span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 bg-white"
              >
                <option value="">— pick account —</option>
                {depositAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col col-span-2">
              <span className="text-slate-600 mb-1">Reference / UTR</span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5"
                placeholder="UPI txn / cheque # / bank ref"
              />
            </label>
            <label className="flex flex-col col-span-2">
              <span className="text-slate-600 mb-1">Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 h-14"
              />
            </label>
          </div>

          {customer && (
            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">Outstanding invoices</div>
                <div className="flex gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setAllocMode('auto')}
                    className={
                      allocMode === 'auto'
                        ? 'bg-slate-900 text-white rounded px-2 py-1'
                        : 'border border-slate-300 rounded px-2 py-1 hover:bg-slate-50'
                    }
                  >
                    Auto (oldest first)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAllocMode('manual');
                      setAllocations((prev) => {
                        if (Object.keys(prev).length > 0) return prev;
                        const seeded: Record<string, string> = {};
                        for (const [invId, paise] of Object.entries(autoAllocations)) {
                          seeded[invId] = (paise / 100).toFixed(2);
                        }
                        return seeded;
                      });
                    }}
                    className={
                      allocMode === 'manual'
                        ? 'bg-slate-900 text-white rounded px-2 py-1'
                        : 'border border-slate-300 rounded px-2 py-1 hover:bg-slate-50'
                    }
                  >
                    Manual
                  </button>
                </div>
              </div>

              {loadingParty ? (
                <div className="text-xs text-slate-500">Loading customer data…</div>
              ) : openInvoiceRows.length === 0 ? (
                <div className="text-xs text-slate-500 border border-dashed border-slate-300 rounded p-3">
                  No outstanding invoices — the full amount will be held as a customer advance.
                </div>
              ) : (
                <div className="border border-slate-200 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="text-left px-2 py-1.5">Invoice</th>
                        <th className="text-left px-2 py-1.5">Date</th>
                        <th className="text-right px-2 py-1.5">Outstanding</th>
                        <th className="text-right px-2 py-1.5 w-32">
                          {allocMode === 'auto' ? 'Auto-apply' : 'Apply ₹'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {openInvoiceRows.map((r) => {
                        const isPreselect = preselectInvoiceId === r.inv.id;
                        const autoPaise = autoAllocations[r.inv.id] ?? 0;
                        const currentManual = allocations[r.inv.id] ?? '';
                        return (
                          <tr
                            key={r.inv.id}
                            className={`border-t border-slate-100 ${
                              isPreselect ? 'bg-emerald-50/50' : ''
                            }`}
                          >
                            <td className="px-2 py-1.5 font-mono">
                              {r.inv.invoice_number}
                            </td>
                            <td className="px-2 py-1.5">{fmtDateShort(r.inv.invoice_date)}</td>
                            <td className="px-2 py-1.5 text-right">
                              <Money paise={r.outstanding_paise} />
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {allocMode === 'auto' ? (
                                autoPaise > 0 ? (
                                  <Money paise={autoPaise} />
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )
                              ) : (
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  max={r.outstanding_paise / 100}
                                  value={currentManual}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setAllocations((prev) => {
                                      const next = { ...prev };
                                      if (v === '' || Number(v) === 0) delete next[r.inv.id];
                                      else next[r.inv.id] = v;
                                      return next;
                                    });
                                  }}
                                  placeholder="0.00"
                                  className="w-24 border border-slate-300 rounded px-1.5 py-0.5 text-right"
                                />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-3 rounded bg-slate-50 border border-slate-200 p-2 text-xs grid grid-cols-3 gap-2">
                <div>
                  <div className="text-slate-500">Payment Amount</div>
                  <div className="font-semibold tabular-nums">
                    <Money paise={paymentAmountPaise > 0 ? paymentAmountPaise : 0} />
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Applied to Invoices</div>
                  <div className="font-semibold tabular-nums">
                    <Money paise={effectiveAllocTotal} />
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Customer Advance</div>
                  <div
                    className={`font-semibold tabular-nums ${
                      advanceExcessPaise > 0 ? 'text-blue-700' : ''
                    }`}
                  >
                    <Money paise={advanceExcessPaise} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-4 mb-3 text-xs text-rose-600 whitespace-pre-wrap border border-rose-200 bg-rose-50 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !customer}
            onClick={save}
            className="text-sm bg-emerald-700 text-white rounded px-3 py-1.5 hover:bg-emerald-800 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Payment In'}
          </button>
        </div>
      </div>
    </div>
  );
}
