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
  Purchase,
  Supplier,
} from '../../db/types';
import { PaymentService } from '../../domain/PaymentService';
import { SYSTEM_ACCOUNT_CODES } from '../../domain/coa';
import { isPaymentActive, isAdvanceActive } from '../../domain/paymentState';
import Money from '../components/Money';

// Edit an existing payment. Under the hood this calls PaymentService.updatePayment,
// which supersedes the current row and creates a new revision (same payment_number).
// The party is fixed — Edit can change amount/date/method/account/allocations/ref/notes
// but NOT switch which customer or supplier the payment relates to.
//
// Outstanding-target derivation deliberately EXCLUDES the payment being edited so
// the user sees room to re-allocate what this payment previously took.

const METHODS: PaymentMethod[] = ['cash', 'upi', 'bank', 'cheque', 'card'];

function fmtDateShort(ymd: string): string {
  if (!ymd || ymd.length < 10) return ymd;
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

interface TargetRow {
  id: string;
  number: string;
  date: string;
  outstanding_paise: number;
}

interface Props {
  businessId: string;
  deviceId: string;
  payment: Payment;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditPaymentModal({
  businessId,
  deviceId,
  payment,
  onClose,
  onSaved,
}: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [party, setParty] = useState<Customer | Supplier | null>(null);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [amountStr, setAmountStr] = useState<string>(
    (payment.amount_paise / 100).toFixed(2),
  );
  const [date, setDate] = useState<string>(payment.payment_date);
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [accountId, setAccountId] = useState<string>(payment.account_id);
  const [reference, setReference] = useState<string>(payment.reference ?? '');
  const [notes, setNotes] = useState<string>(payment.notes ?? '');

  // Seed manual allocations from the payment's current allocations, keyed by
  // invoice_id or bill_id (whichever this payment's direction implies).
  const [allocations, setAllocations] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const a of payment.allocations) {
      const targetId = a.invoice_id ?? a.bill_id;
      if (!targetId) continue; // skip advance-slice allocations
      out[targetId] = (a.amount_paise / 100).toFixed(2);
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const svc = useMemo(() => new PaymentService(), []);
  const isInbound = payment.direction === 'in';

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      if (isInbound) {
        const [accs, cust, invs, pays, advs] = await Promise.all([
          db.accounts.where('business_id').equals(businessId).toArray(),
          db.customers.get(payment.party_id),
          db.invoices
            .where('[business_id+customer_id]')
            .equals([businessId, payment.party_id])
            .toArray(),
          db.payments
            .where('[business_id+direction]')
            .equals([businessId, 'in'])
            .filter((p) => p.party_id === payment.party_id && p.party_type === 'customer')
            .toArray(),
          db.advances
            .where('business_id')
            .equals(businessId)
            .filter(
              (a) => a.party_type === 'customer' && a.party_id === payment.party_id,
            )
            .toArray(),
        ]);
        if (!alive) return;
        setAccounts(accs);
        setParty(cust ?? null);
        setTargets(deriveTargetsForInvoices(invs, pays, advs, payment.id));
      } else {
        const [accs, sup, bills, pays, advs] = await Promise.all([
          db.accounts.where('business_id').equals(businessId).toArray(),
          db.suppliers.get(payment.party_id),
          db.purchases
            .where('business_id')
            .equals(businessId)
            .filter((p) => p.supplier_id === payment.party_id)
            .toArray(),
          db.payments
            .where('[business_id+direction]')
            .equals([businessId, 'out'])
            .filter((p) => p.party_id === payment.party_id && p.party_type === 'supplier')
            .toArray(),
          db.advances
            .where('business_id')
            .equals(businessId)
            .filter(
              (a) => a.party_type === 'supplier' && a.party_id === payment.party_id,
            )
            .toArray(),
        ]);
        if (!alive) return;
        setAccounts(accs);
        setParty(sup ?? null);
        setTargets(deriveTargetsForBills(bills, pays, advs, payment.id));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [businessId, payment, isInbound]);

  const paymentAmountPaise = useMemo(
    () => Math.round(Number(amountStr || '0') * 100),
    [amountStr],
  );

  const effectiveAllocations = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, str] of Object.entries(allocations)) {
      const paise = Math.round(Number(str) * 100);
      if (Number.isFinite(paise) && paise > 0) out[id] = paise;
    }
    return out;
  }, [allocations]);

  const effectiveAllocTotal = useMemo(
    () => Object.values(effectiveAllocations).reduce((s, n) => s + n, 0),
    [effectiveAllocations],
  );

  const advanceExcessPaise = Math.max(0, paymentAmountPaise - effectiveAllocTotal);

  async function save() {
    setError(null);
    if (!Number.isFinite(paymentAmountPaise) || paymentAmountPaise <= 0)
      return setError('Amount must be positive.');
    if (!accountId) return setError('Pick an account.');
    if (effectiveAllocTotal > paymentAmountPaise) {
      return setError(
        `Allocations total ₹${(effectiveAllocTotal / 100).toFixed(2)} exceeds payment amount.`,
      );
    }
    for (const [id, paise] of Object.entries(effectiveAllocations)) {
      const t = targets.find((x) => x.id === id);
      if (!t) return setError(`Unknown target ${id}.`);
      if (paise > t.outstanding_paise) {
        return setError(
          `Allocation to ${t.number} exceeds available ₹${(t.outstanding_paise / 100).toFixed(2)}.`,
        );
      }
    }

    // Rebuild allocations array in the shape updatePayment expects.
    const allocations_input = Object.entries(effectiveAllocations).map(
      ([target_id, amount_paise]) =>
        isInbound
          ? { invoice_id: target_id, amount_paise }
          : { bill_id: target_id, amount_paise },
    );
    if (advanceExcessPaise > 0) {
      allocations_input.push({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        as_advance: true,
        amount_paise: advanceExcessPaise,
      } as unknown as (typeof allocations_input)[number]);
    }

    const advanceNumber = advanceExcessPaise > 0 ? `ADV-${ulid().slice(-10)}` : undefined;

    // AR/AP account is not stored on the Payment record — derive from party type
    // using the system COA code (1200 = Receivable, 2010 = Payable).
    const arApCode =
      payment.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.RECEIVABLE
        : SYSTEM_ACCOUNT_CODES.PAYABLE;
    const arApAccount = accounts.find((a) => a.code === arApCode);
    if (!arApAccount) {
      setError(
        `${payment.party_type === 'customer' ? 'Accounts Receivable' : 'Accounts Payable'} account (code ${arApCode}) not found — run "Repair chart of accounts" in Settings.`,
      );
      return;
    }

    setSaving(true);
    try {
      await svc.updatePayment({
        business_id: businessId,
        device_id: deviceId,
        payment_id: payment.id,
        payment_date: date,
        method,
        cash_or_bank_account_id: accountId,
        ar_or_ap_account_id: arApAccount.id,
        amount_paise: paymentAmountPaise,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        allocations: allocations_input,
        advance_number: advanceNumber,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const cashBankAccounts = accounts.filter(
    (a) =>
      a.active === 1 &&
      (a.code === SYSTEM_ACCOUNT_CODES.CASH || a.code === SYSTEM_ACCOUNT_CODES.BANK),
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="bg-white rounded shadow-lg w-full max-w-2xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-semibold">
            Edit {isInbound ? 'Receive Payment' : 'Make Payment'}
            {party ? ` — ${party.name}` : ''}
            <span className="ml-2 text-xs text-slate-500">
              #{payment.payment_number}
              {payment.revision != null ? ` (rev ${payment.revision})` : ''}
            </span>
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
        <div className="px-4 py-3 text-sm flex flex-col gap-3">
          <div className="text-xs text-slate-500 border border-slate-200 rounded bg-slate-50 px-2 py-1.5">
            Saving supersedes the current revision and creates a new one under the same
            payment number. The old row moves out of the main list but stays on the
            audit trail.
          </div>
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
              <span className="text-slate-600 mb-1">
                {isInbound ? 'Deposit to *' : 'Pay from *'}
              </span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 bg-white"
              >
                <option value="">— pick account —</option>
                {cashBankAccounts.map((a) => (
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

          <div className="border-t border-slate-100 pt-3">
            <div className="font-medium mb-2">
              Apply to {isInbound ? 'invoices' : 'bills'}
            </div>
            {loading ? (
              <div className="text-xs text-slate-500">Loading…</div>
            ) : targets.length === 0 ? (
              <div className="text-xs text-slate-500 border border-dashed border-slate-300 rounded p-3">
                No open targets — the full amount will be held as an advance.
              </div>
            ) : (
              <div className="border border-slate-200 rounded overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-2 py-1.5">
                        {isInbound ? 'Invoice' : 'Bill'}
                      </th>
                      <th className="text-left px-2 py-1.5">Date</th>
                      <th className="text-right px-2 py-1.5">Available</th>
                      <th className="text-right px-2 py-1.5 w-32">Apply ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {targets.map((t) => (
                      <tr key={t.id} className="border-t border-slate-100">
                        <td className="px-2 py-1.5 font-mono">{t.number}</td>
                        <td className="px-2 py-1.5">{fmtDateShort(t.date)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Money paise={t.outstanding_paise} />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max={t.outstanding_paise / 100}
                            value={allocations[t.id] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setAllocations((prev) => {
                                const next = { ...prev };
                                if (v === '' || Number(v) === 0) delete next[t.id];
                                else next[t.id] = v;
                                return next;
                              });
                            }}
                            placeholder="0.00"
                            className="w-24 border border-slate-300 rounded px-1.5 py-0.5 text-right"
                          />
                        </td>
                      </tr>
                    ))}
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
                <div className="text-slate-500">
                  Applied to {isInbound ? 'Invoices' : 'Purchases'}
                </div>
                <div className="font-semibold tabular-nums">
                  <Money paise={effectiveAllocTotal} />
                </div>
              </div>
              <div>
                <div className="text-slate-500">
                  {isInbound ? 'Customer' : 'Supplier'} Advance
                </div>
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
            disabled={saving}
            onClick={save}
            className={
              'text-sm text-white rounded px-3 py-1.5 disabled:opacity-50 ' +
              (isInbound
                ? 'bg-emerald-700 hover:bg-emerald-800'
                : 'bg-rose-700 hover:bg-rose-800')
            }
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Compute per-invoice available room, EXCLUDING the payment being edited from
// the "already paid" tally. `editingPaymentId` is what makes this different
// from ReceivePaymentModal's derive.
function deriveTargetsForInvoices(
  invoices: Invoice[],
  payments: Payment[],
  advances: Advance[],
  editingPaymentId: string,
): TargetRow[] {
  const creditsByOriginal = new Map<string, Invoice[]>();
  for (const cn of invoices) {
    if (!cn.reverses_invoice_id) continue;
    const arr = creditsByOriginal.get(cn.reverses_invoice_id) ?? [];
    arr.push(cn);
    creditsByOriginal.set(cn.reverses_invoice_id, arr);
  }
  const rows: TargetRow[] = [];
  for (const inv of invoices) {
    if (inv.reverses_invoice_id) continue;
    if (inv.status === 'draft' || inv.status === 'cancelled') continue;
    let paid = 0;
    for (const p of payments) {
      if (!isPaymentActive(p)) continue;
      if (p.id === editingPaymentId) continue; // exclude ourselves
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
    if (outstanding > 0)
      rows.push({
        id: inv.id,
        number: inv.invoice_number,
        date: inv.invoice_date,
        outstanding_paise: outstanding,
      });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function deriveTargetsForBills(
  purchases: Purchase[],
  payments: Payment[],
  advances: Advance[],
  editingPaymentId: string,
): TargetRow[] {
  const debitsByOriginal = new Map<string, Purchase[]>();
  for (const dn of purchases) {
    if (!dn.reverses_purchase_id) continue;
    const arr = debitsByOriginal.get(dn.reverses_purchase_id) ?? [];
    arr.push(dn);
    debitsByOriginal.set(dn.reverses_purchase_id, arr);
  }
  const rows: TargetRow[] = [];
  for (const b of purchases) {
    if (b.reverses_purchase_id) continue;
    if (b.status === 'draft' || b.status === 'cancelled') continue;
    let paid = 0;
    for (const p of payments) {
      if (!isPaymentActive(p)) continue;
      if (p.id === editingPaymentId) continue;
      for (const a of p.allocations) if (a.bill_id === b.id) paid += a.amount_paise;
    }
    for (const adv of advances) {
      if (!isAdvanceActive(adv)) continue;
      for (const app of adv.applications) if (app.bill_id === b.id) paid += app.amount_paise;
    }
    const dnReduction = (debitsByOriginal.get(b.id) ?? []).reduce(
      (s, dn) => s + Math.abs(dn.total_paise),
      0,
    );
    const outstanding = Math.max(0, b.total_paise - paid - dnReduction);
    if (outstanding > 0)
      rows.push({
        id: b.id,
        number: b.bill_number,
        date: b.bill_date,
        outstanding_paise: outstanding,
      });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}
