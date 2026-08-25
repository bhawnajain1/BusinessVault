import { useEffect, useMemo, useState } from 'react';
import { ulid } from 'ulid';
import { db } from '../../db';
import type {
  Account,
  Advance,
  Payment,
  PaymentMethod,
  Purchase,
  Supplier,
} from '../../db/types';
import { PaymentService } from '../../domain/PaymentService';
import { ExpenseService } from '../../domain/ExpenseService';
import { SYSTEM_ACCOUNT_CODES } from '../../domain/coa';
import { isPaymentActive, isAdvanceActive } from '../../domain/paymentState';
import Money from '../components/Money';

// Shared Make-Payment modal (outbound). Two branches:
//   - Payment For = Supplier  → PaymentService.createPayment(direction='out') with
//                               allocations against outstanding purchase bills; leftover
//                               excess captured as a supplier advance via as_advance slice.
//   - Payment For = anything else → ExpenseService.create against a fixed P&L
//                               category account (Cr Cash/Bank, Dr Expense).
//
// Non-supplier path deliberately does NOT touch PaymentService — an expense
// payment doesn't need allocations, and forcing it through Payment would
// pollute the Payments list with rows that have no party. That's the exact
// separation payablesRec.md drew.

type PaymentFor = 'supplier' | 'expense' | 'salary' | 'rent' | 'tax' | 'loan' | 'other';

const METHODS: PaymentMethod[] = ['cash', 'upi', 'bank', 'cheque', 'card'];

// Non-supplier categories map to a fixed system expense account. Grug rule:
// no picker — one category, one account.
const CATEGORY_ACCOUNT_CODE: Record<Exclude<PaymentFor, 'supplier'>, string> = {
  expense: '6080', // Misc Expense
  salary: '6020',
  rent: '6010',
  tax: '6080', // no dedicated tax account; caller can re-categorise via Chart of Accounts later
  loan: '6080', // no loan liability tracking yet; recorded as Misc + note
  other: '6080',
};

const CATEGORY_LABEL: Record<PaymentFor, string> = {
  supplier: 'Supplier',
  expense: 'Expense',
  salary: 'Salary',
  rent: 'Rent',
  tax: 'Tax',
  loan: 'Loan',
  other: 'Other',
};

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateShort(ymd: string): string {
  if (!ymd || ymd.length < 10) return ymd;
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

interface BillRow {
  bill: Purchase;
  outstanding_paise: number;
}

function deriveOpenBills(
  purchases: Purchase[],
  payments: Payment[],
  advances: Advance[],
): BillRow[] {
  // Debit notes attach via reverses_purchase_id.
  const debitsByOriginal = new Map<string, Purchase[]>();
  for (const dn of purchases) {
    if (!dn.reverses_purchase_id) continue;
    const arr = debitsByOriginal.get(dn.reverses_purchase_id) ?? [];
    arr.push(dn);
    debitsByOriginal.set(dn.reverses_purchase_id, arr);
  }
  const rows: BillRow[] = [];
  for (const b of purchases) {
    if (b.reverses_purchase_id) continue;
    if (b.status === 'draft' || b.status === 'cancelled') continue;
    let paid = 0;
    for (const p of payments) {
      if (!isPaymentActive(p)) continue;
      for (const a of p.allocations) if (a.bill_id === b.id) paid += a.amount_paise;
    }
    for (const adv of advances) {
      if (!isAdvanceActive(adv)) continue;
      for (const app of adv.applications)
        if (app.bill_id === b.id) paid += app.amount_paise;
    }
    const dnReduction = (debitsByOriginal.get(b.id) ?? []).reduce(
      (s, dn) => s + Math.abs(dn.total_paise),
      0,
    );
    const outstanding = Math.max(0, b.total_paise - paid - dnReduction);
    if (outstanding > 0) rows.push({ bill: b, outstanding_paise: outstanding });
  }
  return rows.sort((a, b) => {
    if (a.bill.bill_date !== b.bill.bill_date)
      return a.bill.bill_date < b.bill.bill_date ? -1 : 1;
    if (a.bill.bill_number !== b.bill.bill_number)
      return a.bill.bill_number < b.bill.bill_number ? -1 : 1;
    return a.bill.id < b.bill.id ? -1 : 1;
  });
}

export interface MakePaymentModalProps {
  businessId: string;
  deviceId: string;
  preselectSupplierId?: string;
  preselectBillId?: string;
  preselectAmountPaise?: number;
  supplierPickerAllowed?: boolean;
  // When true (SupplierDetail case), the "Payment For" selector is locked to
  // Supplier and hidden.
  lockToSupplier?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function MakePaymentModal(props: MakePaymentModalProps) {
  const {
    businessId,
    deviceId,
    preselectSupplierId,
    preselectBillId,
    preselectAmountPaise,
    supplierPickerAllowed,
    lockToSupplier,
    onClose,
    onSaved,
  } = props;

  const [paymentFor, setPaymentFor] = useState<PaymentFor>(
    preselectSupplierId || lockToSupplier ? 'supplier' : 'supplier',
  );
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [supplierId, setSupplierId] = useState<string>(preselectSupplierId ?? '');
  const [supplierQuery, setSupplierQuery] = useState('');

  const [bills, setBills] = useState<Purchase[]>([]);
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
    preselectBillId ? 'manual' : 'auto',
  );
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ss, accs] = await Promise.all([
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.accounts.where('business_id').equals(businessId).toArray(),
      ]);
      if (!alive) return;
      setSuppliers(ss.sort((a, b) => (a.name < b.name ? -1 : 1)));
      setAccounts(accs);
      const cash = accs.find((a) => a.code === SYSTEM_ACCOUNT_CODES.CASH);
      if (cash) setAccountId(cash.id);
    })();
    return () => {
      alive = false;
    };
  }, [businessId]);

  useEffect(() => {
    if (!supplierId || paymentFor !== 'supplier') {
      setBills([]);
      setPayments([]);
      setAdvances([]);
      return;
    }
    let alive = true;
    setLoadingParty(true);
    (async () => {
      const [prs, pays, advs] = await Promise.all([
        db.purchases
          .where('business_id')
          .equals(businessId)
          .filter((p) => p.supplier_id === supplierId)
          .toArray(),
        db.payments
          .where('[business_id+direction]')
          .equals([businessId, 'out'])
          .filter((p) => p.party_id === supplierId && p.party_type === 'supplier')
          .toArray(),
        db.advances
          .where('business_id')
          .equals(businessId)
          .filter((a) => a.party_type === 'supplier' && a.party_id === supplierId)
          .toArray(),
      ]);
      if (!alive) return;
      setBills(prs);
      setPayments(pays);
      setAdvances(advs);
      setLoadingParty(false);
    })();
    return () => {
      alive = false;
    };
  }, [businessId, supplierId, paymentFor]);

  const openBillRows = useMemo(
    () => deriveOpenBills(bills, payments, advances),
    [bills, payments, advances],
  );

  useEffect(() => {
    if (!preselectBillId) return;
    const row = openBillRows.find((r) => r.bill.id === preselectBillId);
    if (!row) return;
    const preselectPaise = preselectAmountPaise ?? row.outstanding_paise;
    setAmountStr((prev) =>
      prev && prev !== '0' ? prev : (preselectPaise / 100).toFixed(2),
    );
    setAllocations((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      return { [preselectBillId]: (preselectPaise / 100).toFixed(2) };
    });
    setAllocMode('manual');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openBillRows.length, preselectBillId]);

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
    for (const r of openBillRows) {
      if (remain <= 0) break;
      const take = Math.min(r.outstanding_paise, remain);
      if (take > 0) {
        out[r.bill.id] = take;
        remain -= take;
      }
    }
    return out;
  }, [paymentAmountPaise, openBillRows]);

  const effectiveAllocations = useMemo(() => {
    if (allocMode === 'auto') return autoAllocations;
    const out: Record<string, number> = {};
    for (const [billId, str] of Object.entries(allocations)) {
      const paise = Math.round(Number(str) * 100);
      if (Number.isFinite(paise) && paise > 0) out[billId] = paise;
    }
    return out;
  }, [allocMode, autoAllocations, allocations]);

  const effectiveAllocTotal = useMemo(
    () => Object.values(effectiveAllocations).reduce((s, n) => s + n, 0),
    [effectiveAllocations],
  );

  const advanceExcessPaise = Math.max(0, paymentAmountPaise - effectiveAllocTotal);

  const paySvc = useMemo(() => new PaymentService(), []);
  const expSvc = useMemo(() => new ExpenseService({ db }), []);

  const supplier = useMemo(
    () => suppliers.find((s) => s.id === supplierId) ?? null,
    [suppliers, supplierId],
  );

  const filteredSuppliers = useMemo(() => {
    if (!supplierQuery.trim()) return suppliers.slice(0, 50);
    const q = supplierQuery.toLowerCase();
    return suppliers.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 50);
  }, [suppliers, supplierQuery]);

  const isSupplierMode = paymentFor === 'supplier';

  async function save() {
    setError(null);
    if (!Number.isFinite(paymentAmountPaise) || paymentAmountPaise <= 0)
      return setError('Amount must be positive.');
    if (!accountId) return setError('Pick a Pay-From account.');
    if (!date) return setError('Payment date is required.');

    if (isSupplierMode) {
      if (!supplier) return setError('Pick a supplier.');
      if (effectiveAllocTotal > paymentAmountPaise) {
        return setError(
          `Allocations total ₹${(effectiveAllocTotal / 100).toFixed(2)} exceeds payment amount.`,
        );
      }
      for (const [billId, paise] of Object.entries(effectiveAllocations)) {
        const row = openBillRows.find((r) => r.bill.id === billId);
        if (!row) return setError(`Unknown bill ${billId}.`);
        if (paise > row.outstanding_paise) {
          return setError(
            `Allocation to ${row.bill.bill_number} exceeds outstanding ₹${(row.outstanding_paise / 100).toFixed(2)}.`,
          );
        }
      }
      const apAccount = accounts.find((a) => a.code === SYSTEM_ACCOUNT_CODES.PAYABLE);
      if (!apAccount)
        return setError('Payable account (2010) missing in chart of accounts.');

      const paymentNumber = `PAY-${ulid().slice(-10)}`;
      const advanceNumber =
        advanceExcessPaise > 0 ? `ADV-${ulid().slice(-10)}` : undefined;

      const allocations_input = [
        ...Object.entries(effectiveAllocations).map(([bill_id, amount_paise]) => ({
          bill_id,
          amount_paise,
        })),
      ];
      if (advanceExcessPaise > 0) {
        allocations_input.push({
          as_advance: true,
          amount_paise: advanceExcessPaise,
        } as unknown as (typeof allocations_input)[number]);
      }

      setSaving(true);
      try {
        await paySvc.createPayment({
          business_id: businessId,
          device_id: deviceId,
          payment_number: paymentNumber,
          payment_date: date,
          direction: 'out',
          party_type: 'supplier',
          party_id: supplier.id,
          method,
          cash_or_bank_account_id: accountId,
          ar_or_ap_account_id: apAccount.id,
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
      return;
    }

    // Non-supplier: expense path.
    const categoryCode = CATEGORY_ACCOUNT_CODE[paymentFor];
    const categoryAcct = accounts.find((a) => a.code === categoryCode);
    if (!categoryAcct) {
      return setError(
        `Category account (code ${categoryCode}) missing — run "Repair chart of accounts" in Settings.`,
      );
    }
    const expenseNumber = `EXP-${ulid().slice(-10)}`;
    setSaving(true);
    try {
      await expSvc.create({
        businessId,
        deviceId,
        expenseNumber,
        expenseDate: date,
        categoryAccountId: categoryAcct.id,
        paymentAccountId: accountId,
        supplierId: null,
        description:
          notes.trim() ||
          `${CATEGORY_LABEL[paymentFor]}${reference.trim() ? ` — ${reference.trim()}` : ''}`,
        amountPaise: paymentAmountPaise,
        taxPaise: 0,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const payFromAccounts = accounts.filter(
    (a) =>
      a.active === 1 &&
      (a.code === SYSTEM_ACCOUNT_CODES.CASH || a.code === SYSTEM_ACCOUNT_CODES.BANK),
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="bg-white rounded shadow-lg w-full max-w-2xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-semibold">
            Make Payment
            {isSupplierMode && supplier ? ` — ${supplier.name}` : ''}
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
          {!lockToSupplier && (
            <div className="flex flex-col">
              <label className="text-slate-600 mb-1">Payment For *</label>
              <div className="flex flex-wrap gap-1">
                {(
                  ['supplier', 'expense', 'salary', 'rent', 'tax', 'loan', 'other'] as PaymentFor[]
                ).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setPaymentFor(p);
                      if (p !== 'supplier') {
                        setSupplierId('');
                        setAllocations({});
                      }
                    }}
                    className={
                      paymentFor === p
                        ? 'bg-slate-900 text-white rounded px-2.5 py-1 text-xs'
                        : 'border border-slate-300 rounded px-2.5 py-1 text-xs hover:bg-slate-50'
                    }
                  >
                    {CATEGORY_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isSupplierMode && supplierPickerAllowed && !preselectSupplierId && (
            <div className="flex flex-col">
              <label className="text-slate-600 mb-1">Supplier *</label>
              {supplier ? (
                <div className="flex items-center gap-2">
                  <span className="font-medium">{supplier.name}</span>
                  <button
                    type="button"
                    className="text-xs text-blue-700 hover:underline"
                    onClick={() => {
                      setSupplierId('');
                      setSupplierQuery('');
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
                    value={supplierQuery}
                    onChange={(e) => setSupplierQuery(e.target.value)}
                    placeholder="Search suppliers…"
                    className="border border-slate-300 rounded px-2 py-1.5"
                  />
                  {(supplierQuery || suppliers.length <= 20) && (
                    <div className="max-h-40 overflow-auto border border-slate-200 rounded mt-1 divide-y">
                      {filteredSuppliers.length === 0 && (
                        <div className="text-xs text-slate-500 px-2 py-1.5">
                          No suppliers match.
                        </div>
                      )}
                      {filteredSuppliers.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setSupplierId(s.id)}
                          className="w-full text-left px-2 py-1.5 hover:bg-slate-50 text-sm"
                        >
                          {s.name}
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
              <span className="text-slate-600 mb-1">Pay from *</span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 bg-white"
              >
                <option value="">— pick account —</option>
                {payFromAccounts.map((a) => (
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

          {isSupplierMode && supplier && (
            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">Outstanding purchases</div>
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
                        for (const [billId, paise] of Object.entries(autoAllocations)) {
                          seeded[billId] = (paise / 100).toFixed(2);
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
                <div className="text-xs text-slate-500">Loading supplier data…</div>
              ) : openBillRows.length === 0 ? (
                <div className="text-xs text-slate-500 border border-dashed border-slate-300 rounded p-3">
                  No outstanding purchase bills — the full amount will be held as a supplier advance.
                </div>
              ) : (
                <div className="border border-slate-200 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="text-left px-2 py-1.5">Bill</th>
                        <th className="text-left px-2 py-1.5">Date</th>
                        <th className="text-right px-2 py-1.5">Outstanding</th>
                        <th className="text-right px-2 py-1.5 w-32">
                          {allocMode === 'auto' ? 'Auto-apply' : 'Apply ₹'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {openBillRows.map((r) => {
                        const isPreselect = preselectBillId === r.bill.id;
                        const autoPaise = autoAllocations[r.bill.id] ?? 0;
                        const currentManual = allocations[r.bill.id] ?? '';
                        return (
                          <tr
                            key={r.bill.id}
                            className={`border-t border-slate-100 ${
                              isPreselect ? 'bg-emerald-50/50' : ''
                            }`}
                          >
                            <td className="px-2 py-1.5 font-mono">
                              {r.bill.bill_number}
                            </td>
                            <td className="px-2 py-1.5">
                              {fmtDateShort(r.bill.bill_date)}
                            </td>
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
                                      if (v === '' || Number(v) === 0)
                                        delete next[r.bill.id];
                                      else next[r.bill.id] = v;
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
                  <div className="text-slate-500">Applied to Purchases</div>
                  <div className="font-semibold tabular-nums">
                    <Money paise={effectiveAllocTotal} />
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Supplier Advance</div>
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

          {!isSupplierMode && (
            <div className="border-t border-slate-100 pt-3 text-xs text-slate-600">
              This will be recorded as an <strong>Expense</strong> against the{' '}
              <span className="font-mono">
                {CATEGORY_ACCOUNT_CODE[paymentFor]}
              </span>{' '}
              account and will reduce the selected Pay-From balance.
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
            disabled={saving || (isSupplierMode && !supplier)}
            onClick={save}
            className="text-sm bg-rose-700 text-white rounded px-3 py-1.5 hover:bg-rose-800 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Payment Out'}
          </button>
        </div>
      </div>
    </div>
  );
}
