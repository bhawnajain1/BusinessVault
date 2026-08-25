import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../../db';
import type {
  Advance,
  Payment,
  Purchase,
  Supplier,
} from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { isPaymentActive, isAdvanceActive } from '../../domain/paymentState';
import Money from '../components/Money';
import { streamCsvExport } from '../../csv/streamCsvExport';
import MakePaymentModal from '../payments/MakePaymentModal';

type Tab = 'bills' | 'payments' | 'statement';

interface BillRow {
  bill: Purchase;
  paid_paise: number;
  outstanding_paise: number;
  dyn_status: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'OVERDUE' | 'CANCELLED';
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateShort(ymd: string): string {
  if (!ymd || ymd.length < 10) return ymd;
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

// Derived outstanding for a single bill, ignoring cached purchase.paid_paise.
// paid = SUM of payment_allocations targeting this bill.
// debit_note reductions come from Purchase.reverses_purchase_id === bill.id.
function deriveBill(
  bill: Purchase,
  payments: Payment[],
  debitNotesForThis: Purchase[],
  advances: Advance[],
  asOfYmd: string,
): BillRow {
  let paid = 0;
  for (const p of payments) {
    for (const a of p.allocations) {
      if (a.bill_id === bill.id) paid += a.amount_paise;
    }
  }
  for (const adv of advances) {
    for (const app of adv.applications) {
      if (app.bill_id === bill.id) paid += app.amount_paise;
    }
  }
  const debitReduction = debitNotesForThis.reduce(
    (s, dn) => s + Math.abs(dn.total_paise),
    0,
  );
  const grossOutstanding = bill.total_paise - paid - debitReduction;
  const outstanding = Math.max(0, grossOutstanding);
  let dyn: BillRow['dyn_status'];
  if (bill.status === 'cancelled') dyn = 'CANCELLED';
  else if (outstanding === 0) dyn = 'PAID';
  else if (outstanding < bill.total_paise) dyn = 'PARTIALLY_PAID';
  else if (bill.due_date && asOfYmd > bill.due_date) dyn = 'OVERDUE';
  else dyn = 'UNPAID';
  return { bill, paid_paise: paid, outstanding_paise: outstanding, dyn_status: dyn };
}

// Statement direction: bills = credit (you owe), payments out = debit (you paid),
// advances given to supplier = debit (you paid the money out).
interface StatementRow {
  date: string;
  transaction: string;
  debit_paise: number;
  credit_paise: number;
}

function buildStatement(
  bills: Purchase[],
  payments: Payment[],
  advances: Advance[],
): StatementRow[] {
  const out: StatementRow[] = [];
  for (const bill of bills) {
    if (bill.status === 'cancelled') continue;
    if (bill.reverses_purchase_id) {
      out.push({
        date: bill.bill_date,
        transaction: `Debit Note ${bill.bill_number}`,
        debit_paise: Math.abs(bill.total_paise),
        credit_paise: 0,
      });
    } else {
      out.push({
        date: bill.bill_date,
        transaction: `Bill ${bill.bill_number}`,
        debit_paise: 0,
        credit_paise: bill.total_paise,
      });
    }
  }
  for (const pay of payments) {
    out.push({
      date: pay.payment_date,
      transaction: `Payment ${pay.payment_number}${pay.method ? ` (${pay.method})` : ''}`,
      debit_paise: pay.amount_paise,
      credit_paise: 0,
    });
  }
  for (const adv of advances) {
    out.push({
      date: adv.advance_date,
      transaction: `Advance ${adv.advance_number}`,
      debit_paise: adv.amount_paise,
      credit_paise: 0,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { businessId, deviceId, loading } = useActiveBusiness();

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [bills, setBills] = useState<Purchase[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('bills');

  // Payment modal — shared MakePaymentModal instance. Only preselect state is
  // local; the modal owns its own form/allocation/save state.
  const [makeOpen, setMakeOpen] = useState(false);
  const [makePreselectBillId, setMakePreselectBillId] = useState<string | undefined>(
    undefined,
  );
  const [makePreselectAmountPaise, setMakePreselectAmountPaise] = useState<
    number | undefined
  >(undefined);

  useEffect(() => {
    if (!businessId || !id) return;
    let cancelled = false;
    setDataLoading(true);
    setError(null);
    (async () => {
      try {
        const [sup, purs, pays, advs] = await Promise.all([
          db.suppliers.get(id),
          db.purchases
            .where('[business_id+supplier_id]')
            .equals([businessId, id])
            .toArray(),
          db.payments
            .where('[business_id+direction]')
            .equals([businessId, 'out'])
            .filter(
              (p) =>
                p.party_id === id &&
                p.party_type === 'supplier' &&
                isPaymentActive(p),
            )
            .toArray(),
          db.advances
            .where('business_id')
            .equals(businessId)
            .filter(
              (a) =>
                a.party_type === 'supplier' &&
                a.party_id === id &&
                isAdvanceActive(a),
            )
            .toArray(),
        ]);
        if (cancelled) return;
        setSupplier(sup ?? null);
        setBills(
          purs.sort((a, b) => {
            if (a.bill_date !== b.bill_date)
              return a.bill_date < b.bill_date ? 1 : -1;
            if (a.bill_number !== b.bill_number)
              return a.bill_number < b.bill_number ? 1 : -1;
            return a.id < b.id ? 1 : -1;
          }),
        );
        setPayments(
          pays.sort((a, b) => {
            if (a.payment_date !== b.payment_date)
              return a.payment_date < b.payment_date ? 1 : -1;
            return a.id < b.id ? 1 : -1;
          }),
        );
        setAdvances(advs);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, id, reloadKey]);

  const asOfYmd = todayYmd();

  // Split originals from debit notes and index by reverses_purchase_id.
  const { originals, debitsByOriginalId } = useMemo(() => {
    const originals = bills.filter(
      (b) => !b.reverses_purchase_id && b.status !== 'draft',
    );
    const debitsByOriginalId = new Map<string, Purchase[]>();
    for (const dn of bills) {
      if (!dn.reverses_purchase_id) continue;
      const arr = debitsByOriginalId.get(dn.reverses_purchase_id) ?? [];
      arr.push(dn);
      debitsByOriginalId.set(dn.reverses_purchase_id, arr);
    }
    return { originals, debitsByOriginalId };
  }, [bills]);

  const billRows: BillRow[] = useMemo(() => {
    return originals.map((bill) =>
      deriveBill(
        bill,
        payments,
        debitsByOriginalId.get(bill.id) ?? [],
        advances,
        asOfYmd,
      ),
    );
  }, [originals, payments, advances, debitsByOriginalId, asOfYmd]);

  // Financial summary cards. No credit-limit for suppliers — 4 cards not 5.
  const summary = useMemo(() => {
    const nonCancelled = billRows.filter((r) => r.dyn_status !== 'CANCELLED');
    const totalBilled = nonCancelled.reduce((s, r) => s + r.bill.total_paise, 0);
    const totalPaid = nonCancelled.reduce((s, r) => s + r.paid_paise, 0);
    const totalDue = nonCancelled.reduce((s, r) => s + r.outstanding_paise, 0);
    const advance = advances.reduce((s, a) => s + Math.max(0, a.remaining_paise), 0);
    return { totalBilled, totalPaid, totalDue, advance };
  }, [billRows, advances]);

  const statementRows = useMemo(() => {
    const rows = buildStatement(bills, payments, advances);
    // Supplier opening balance is what you owe them — a credit from your POV.
    let bal = -(supplier?.opening_balance_paise ?? 0);
    return rows.map((r) => {
      bal += r.debit_paise - r.credit_paise;
      return { ...r, balance_paise: bal };
    });
  }, [bills, payments, advances, supplier]);

  function openPaymentModal(preselectBillId?: string) {
    setMakePreselectBillId(preselectBillId);
    if (preselectBillId) {
      const row = billRows.find((r) => r.bill.id === preselectBillId);
      setMakePreselectAmountPaise(row?.outstanding_paise);
    } else {
      setMakePreselectAmountPaise(undefined);
    }
    setMakeOpen(true);
  }

  const billById = useMemo(() => {
    const m = new Map<string, Purchase>();
    for (const bill of bills) m.set(bill.id, bill);
    return m;
  }, [bills]);

  const exportStatementCsv = useCallback(async () => {
    if (!supplier) return;
    const fname = `supplier-statement-${(supplier.name || 'unknown')
      .replace(/[^a-zA-Z0-9-]+/g, '_')
      .slice(0, 40)}-${todayYmd()}.csv`;
    const rows = statementRows;
    await streamCsvExport({
      filename: fname,
      columns: [
        { header: 'Date', get: (r: (typeof rows)[number]) => r.date },
        { header: 'Transaction', get: (r: (typeof rows)[number]) => r.transaction },
        {
          header: 'Debit ₹',
          get: (r: (typeof rows)[number]) =>
            r.debit_paise ? (r.debit_paise / 100).toFixed(2) : '',
        },
        {
          header: 'Credit ₹',
          get: (r: (typeof rows)[number]) =>
            r.credit_paise ? (r.credit_paise / 100).toFixed(2) : '',
        },
        {
          header: 'Balance ₹',
          get: (r: (typeof rows)[number]) => (r.balance_paise / 100).toFixed(2),
        },
      ],
      rows,
    });
  }, [statementRows, supplier]);

  if (loading || dataLoading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId)
    return (
      <div className="p-6 text-slate-600">No active business — complete onboarding first.</div>
    );
  if (!supplier) return <div className="p-6 text-slate-600">Supplier not found.</div>;
  if (error) return <div className="p-6 text-rose-600 whitespace-pre-wrap">{error}</div>;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link to="/suppliers" className="text-sm text-blue-700 hover:underline">
          ← Suppliers
        </Link>
      </div>

      {/* Section 1: Header */}
      <section className="border border-slate-200 rounded p-4 bg-white flex flex-col gap-2">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{supplier.name}</h1>
            <div className="text-sm text-slate-600 flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
              {supplier.phone && <span>📞 {supplier.phone}</span>}
              {supplier.gstin && <span>GSTIN: {supplier.gstin}</span>}
              {supplier.state && <span>State: {supplier.state}</span>}
            </div>
            <div className="text-sm text-slate-600 mt-1">
              {supplier.address || '—'}
            </div>
            <div className="text-xs text-slate-500 mt-2">
              Opening balance: <Money paise={supplier.opening_balance_paise} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => openPaymentModal()}
                className="text-sm bg-rose-700 text-white rounded px-3 py-1.5 hover:bg-rose-800"
              >
                + Payment Out
              </button>
            </div>
            <div className="flex gap-2 text-xs">
              <Link
                to={`/parties/supplier/${supplier.id}/ledger`}
                className="text-blue-700 hover:underline"
              >
                View Statement
              </Link>
              <button
                type="button"
                onClick={() => navigate(`/suppliers?edit=${supplier.id}`)}
                className="text-slate-700 hover:underline"
              >
                Edit Supplier
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Financial Summary — 4 cards (no credit-limit) */}
      <section className="grid grid-cols-4 gap-3">
        <SummaryCard label="Total Billed" paise={summary.totalBilled} />
        <SummaryCard label="Total Paid" paise={summary.totalPaid} tone="emerald" />
        <SummaryCard
          label="Total Due"
          paise={summary.totalDue}
          tone={summary.totalDue > 0 ? 'rose' : 'slate'}
        />
        <SummaryCard
          label="Supplier Advance"
          paise={summary.advance}
          tone={summary.advance > 0 ? 'blue' : 'slate'}
        />
      </section>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 text-sm">
        {(['bills', 'payments', 'statement'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActiveTab(t)}
            className={
              activeTab === t
                ? 'px-4 py-2 border-b-2 border-slate-900 font-medium'
                : 'px-4 py-2 text-slate-600 hover:text-slate-900'
            }
          >
            {t === 'bills'
              ? `Bills (${billRows.filter((r) => r.dyn_status !== 'CANCELLED').length})`
              : t === 'payments'
                ? `Payments (${payments.length})`
                : 'Statement'}
          </button>
        ))}
      </div>

      {activeTab === 'bills' && (
        <section className="border border-slate-200 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th className="text-left px-2 py-2">Bill #</th>
                <th className="text-left px-2 py-2">Date</th>
                <th className="text-left px-2 py-2">Due Date</th>
                <th className="text-right px-2 py-2">Amount</th>
                <th className="text-right px-2 py-2">Paid</th>
                <th className="text-right px-2 py-2">Due</th>
                <th className="text-left px-2 py-2">Status</th>
                <th className="text-right px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {billRows.length === 0 && (
                <tr>
                  <td className="px-2 py-4 text-slate-500 text-center" colSpan={8}>
                    No bills for this supplier yet.
                  </td>
                </tr>
              )}
              {billRows.map((r) => (
                <tr key={r.bill.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">
                    <Link
                      to={`/purchases/${r.bill.id}`}
                      className="text-blue-700 hover:underline font-mono text-xs"
                    >
                      {r.bill.bill_number}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5">{fmtDateShort(r.bill.bill_date)}</td>
                  <td className="px-2 py-1.5">
                    {r.bill.due_date ? fmtDateShort(r.bill.due_date) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Money paise={r.bill.total_paise} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Money paise={r.paid_paise} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Money paise={r.outstanding_paise} />
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusPill status={r.dyn_status} />
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {r.outstanding_paise > 0 && r.dyn_status !== 'CANCELLED' && (
                      <button
                        type="button"
                        onClick={() => openPaymentModal(r.bill.id)}
                        className="text-xs text-rose-700 hover:underline"
                      >
                        Record Payment
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === 'payments' && (
        <section className="border border-slate-200 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th className="text-left px-2 py-2">Date</th>
                <th className="text-left px-2 py-2">Payment #</th>
                <th className="text-right px-2 py-2">Amount</th>
                <th className="text-left px-2 py-2">Method</th>
                <th className="text-left px-2 py-2">Reference</th>
                <th className="text-left px-2 py-2">Allocated to</th>
                <th className="text-right px-2 py-2">Unallocated</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 && (
                <tr>
                  <td className="px-2 py-4 text-slate-500 text-center" colSpan={7}>
                    No payments recorded for this supplier yet.
                  </td>
                </tr>
              )}
              {payments.map((p) => {
                const allocTotal = p.allocations.reduce((s, a) => s + a.amount_paise, 0);
                const unalloc = Math.max(0, p.amount_paise - allocTotal);
                return (
                  <tr key={p.id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-1.5">{fmtDateShort(p.payment_date)}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{p.payment_number}</td>
                    <td className="px-2 py-1.5 text-right">
                      <Money paise={p.amount_paise} />
                    </td>
                    <td className="px-2 py-1.5">{p.method}</td>
                    <td className="px-2 py-1.5">{p.reference || '—'}</td>
                    <td className="px-2 py-1.5 text-xs">
                      {p.allocations.length === 0 ? (
                        <span className="text-slate-500">—</span>
                      ) : (
                        <div className="flex flex-col">
                          {p.allocations.map((a, idx) => (
                            <span key={idx}>
                              {a.bill_id ? (
                                <Link
                                  to={`/purchases/${a.bill_id}`}
                                  className="text-blue-700 hover:underline font-mono"
                                >
                                  {billById.get(a.bill_id)?.bill_number ??
                                    a.bill_id.slice(-8)}
                                </Link>
                              ) : (
                                a.invoice_id
                              )}{' '}
                              → <Money paise={a.amount_paise} />
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {unalloc > 0 ? (
                        <span className="text-blue-700">
                          <Money paise={unalloc} />
                        </span>
                      ) : (
                        <Money paise={0} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === 'statement' && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">
              Chronological running-balance statement (Debit = you paid, Credit = you owe the supplier).
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={exportStatementCsv}
                className="text-xs bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
              >
                Download CSV
              </button>
              <Link
                to={`/parties/supplier/${supplier.id}/ledger`}
                className="text-xs text-blue-700 hover:underline self-center"
              >
                Full ledger view →
              </Link>
            </div>
          </div>
          <div className="border border-slate-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                <tr>
                  <th className="text-left px-2 py-2 w-28">Date</th>
                  <th className="text-left px-2 py-2">Transaction</th>
                  <th className="text-right px-2 py-2 w-28">Debit</th>
                  <th className="text-right px-2 py-2 w-28">Credit</th>
                  <th className="text-right px-2 py-2 w-32">Balance</th>
                </tr>
              </thead>
              <tbody>
                {statementRows.length === 0 && (
                  <tr>
                    <td className="px-2 py-4 text-slate-500 text-center" colSpan={5}>
                      No transactions yet.
                    </td>
                  </tr>
                )}
                {statementRows.map((r, idx) => (
                  <tr key={idx} className="border-t border-slate-100">
                    <td className="px-2 py-1.5">{fmtDateShort(r.date)}</td>
                    <td className="px-2 py-1.5">{r.transaction}</td>
                    <td className="px-2 py-1.5 text-right">
                      {r.debit_paise ? <Money paise={r.debit_paise} /> : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {r.credit_paise ? <Money paise={r.credit_paise} /> : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Money paise={r.balance_paise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {makeOpen && businessId && (
        <MakePaymentModal
          businessId={businessId}
          deviceId={deviceId ?? ''}
          preselectSupplierId={supplier.id}
          preselectBillId={makePreselectBillId}
          preselectAmountPaise={makePreselectAmountPaise}
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

function SummaryCard({
  label,
  paise,
  tone = 'slate',
  fallback,
}: {
  label: string;
  paise: number | null;
  tone?: 'slate' | 'emerald' | 'rose' | 'blue';
  fallback?: string;
}) {
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50/60'
      : tone === 'rose'
        ? 'border-rose-200 bg-rose-50/60'
        : tone === 'blue'
          ? 'border-blue-200 bg-blue-50/60'
          : 'border-slate-200 bg-white';
  return (
    <div className={`border ${toneClass} rounded p-3`}>
      <div className="text-xs text-slate-600">{label}</div>
      <div className="text-xl font-semibold mt-1">
        {paise === null ? (
          <span className="text-slate-400 text-base font-normal">{fallback ?? '—'}</span>
        ) : (
          <Money paise={paise} />
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: BillRow['dyn_status'] }) {
  const cls =
    status === 'PAID'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'PARTIALLY_PAID'
        ? 'bg-amber-100 text-amber-800'
        : status === 'OVERDUE'
          ? 'bg-rose-100 text-rose-800'
          : status === 'CANCELLED'
            ? 'bg-slate-100 text-slate-500'
            : 'bg-slate-100 text-slate-700';
  const label =
    status === 'PAID'
      ? 'Paid'
      : status === 'PARTIALLY_PAID'
        ? 'Partially Paid'
        : status === 'OVERDUE'
          ? 'Overdue'
          : status === 'CANCELLED'
            ? 'Cancelled'
            : 'Unpaid';
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded ${cls}`}>{label}</span>
  );
}
