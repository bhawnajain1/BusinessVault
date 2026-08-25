import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../../db';
import type {
  Account,
  Advance,
  Customer,
  Invoice,
  Payment,
} from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import { isPaymentActive, isAdvanceActive } from '../../domain/paymentState';
import Money from '../components/Money';
import { streamCsvExport } from '../../csv/streamCsvExport';
import ReceivePaymentModal from '../payments/ReceivePaymentModal';

type Tab = 'invoices' | 'payments' | 'statement';

interface InvoiceRow {
  inv: Invoice;
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

// Derived outstanding for a single invoice, ignoring cached invoice.paid_paise.
// paid = SUM of payment_allocations targeting this invoice.
// credit_note reductions come from Invoice.reverses_invoice_id === inv.id.
function deriveInvoice(
  inv: Invoice,
  payments: Payment[],
  creditNotesForThis: Invoice[],
  advances: Advance[],
  asOfYmd: string,
): InvoiceRow {
  let paid = 0;
  for (const p of payments) {
    for (const a of p.allocations) {
      if (a.invoice_id === inv.id) paid += a.amount_paise;
    }
  }
  for (const adv of advances) {
    for (const app of adv.applications) {
      if (app.invoice_id === inv.id) paid += app.amount_paise;
    }
  }
  const creditReduction = creditNotesForThis.reduce(
    (s, cn) => s + Math.abs(cn.total_paise),
    0,
  );
  const grossOutstanding = inv.total_paise - paid - creditReduction;
  const outstanding = Math.max(0, grossOutstanding);
  let dyn: InvoiceRow['dyn_status'];
  if (inv.status === 'cancelled') dyn = 'CANCELLED';
  else if (outstanding === 0) dyn = 'PAID';
  else if (outstanding < inv.total_paise) dyn = 'PARTIALLY_PAID';
  else if (inv.due_date && asOfYmd > inv.due_date) dyn = 'OVERDUE';
  else dyn = 'UNPAID';
  return { inv, paid_paise: paid, outstanding_paise: outstanding, dyn_status: dyn };
}

// Statement rows sorted chronologically. Same shape as PartyLedgerPage but
// scoped to a single customer and inline (no CSV — the party-ledger route
// handles the export).
interface StatementRow {
  date: string;
  transaction: string;
  debit_paise: number;
  credit_paise: number;
}

function buildStatement(
  invoices: Invoice[],
  payments: Payment[],
  advances: Advance[],
): StatementRow[] {
  const out: StatementRow[] = [];
  for (const inv of invoices) {
    if (inv.status === 'cancelled' || inv.status === 'draft') continue;
    if (inv.reverses_invoice_id) {
      out.push({
        date: inv.invoice_date,
        transaction: `Credit Note ${inv.invoice_number}`,
        debit_paise: 0,
        credit_paise: Math.abs(inv.total_paise),
      });
    } else {
      out.push({
        date: inv.invoice_date,
        transaction: `Invoice ${inv.invoice_number}`,
        debit_paise: inv.total_paise,
        credit_paise: 0,
      });
    }
  }
  for (const pay of payments) {
    out.push({
      date: pay.payment_date,
      transaction: `Payment ${pay.payment_number}${pay.method ? ` (${pay.method})` : ''}`,
      debit_paise: 0,
      credit_paise: pay.amount_paise,
    });
  }
  for (const adv of advances) {
    out.push({
      date: adv.advance_date,
      transaction: `Advance ${adv.advance_number}`,
      debit_paise: 0,
      credit_paise: adv.amount_paise,
    });
    // Advance applications don't move the combined AR+advance balance — they
    // convert prepayment (a credit already booked at adv.advance_date) into
    // invoice payment (which already shows as the invoice's own debit netting
    // against this credit). Emitting an "applied" row would double-count.
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { businessId, deviceId, loading } = useActiveBusiness();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('invoices');

  // Payment modal — shared ReceivePaymentModal instance. Only preselect state
  // is local; the modal owns its own form/allocation/save state.
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receivePreselectInvoiceId, setReceivePreselectInvoiceId] =
    useState<string | undefined>(undefined);
  const [receivePreselectAmountPaise, setReceivePreselectAmountPaise] =
    useState<number | undefined>(undefined);

  useEffect(() => {
    if (!businessId || !id) return;
    let cancelled = false;
    setDataLoading(true);
    setError(null);
    (async () => {
      try {
        const [cust, invs, pays, advs, accs] = await Promise.all([
          db.customers.get(id),
          db.invoices
            .where('[business_id+customer_id]')
            .equals([businessId, id])
            .toArray(),
          db.payments
            .where('[business_id+direction]')
            .equals([businessId, 'in'])
            .filter(
              (p) =>
                p.party_id === id &&
                p.party_type === 'customer' &&
                isPaymentActive(p),
            )
            .toArray(),
          db.advances
            .where('business_id')
            .equals(businessId)
            .filter(
              (a) =>
                a.party_type === 'customer' &&
                a.party_id === id &&
                isAdvanceActive(a),
            )
            .toArray(),
          db.accounts.where('business_id').equals(businessId).toArray(),
        ]);
        if (cancelled) return;
        setCustomer(cust ?? null);
        setInvoices(
          invs.sort((a, b) => {
            if (a.invoice_date !== b.invoice_date)
              return a.invoice_date < b.invoice_date ? 1 : -1;
            if (a.invoice_number !== b.invoice_number)
              return a.invoice_number < b.invoice_number ? 1 : -1;
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
        setAccounts(accs);
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

  // Split originals from credit notes and index by reverses_invoice_id.
  const { originals, creditsByOriginalId } = useMemo(() => {
    const originals = invoices.filter(
      (i) => !i.reverses_invoice_id && i.status !== 'draft',
    );
    const creditsByOriginalId = new Map<string, Invoice[]>();
    for (const cn of invoices) {
      if (!cn.reverses_invoice_id) continue;
      const arr = creditsByOriginalId.get(cn.reverses_invoice_id) ?? [];
      arr.push(cn);
      creditsByOriginalId.set(cn.reverses_invoice_id, arr);
    }
    return { originals, creditsByOriginalId };
  }, [invoices]);

  const invoiceRows: InvoiceRow[] = useMemo(() => {
    return originals.map((inv) =>
      deriveInvoice(
        inv,
        payments,
        creditsByOriginalId.get(inv.id) ?? [],
        advances,
        asOfYmd,
      ),
    );
  }, [originals, payments, advances, creditsByOriginalId, asOfYmd]);

  // Financial summary cards.
  const summary = useMemo(() => {
    const nonCancelledOriginals = invoiceRows.filter(
      (r) => r.dyn_status !== 'CANCELLED',
    );
    const totalInvoiced = nonCancelledOriginals.reduce(
      (s, r) => s + r.inv.total_paise,
      0,
    );
    const totalPaid = nonCancelledOriginals.reduce((s, r) => s + r.paid_paise, 0);
    const totalDue = nonCancelledOriginals.reduce(
      (s, r) => s + r.outstanding_paise,
      0,
    );
    const advance = advances.reduce((s, a) => s + Math.max(0, a.remaining_paise), 0);
    const creditLimit = customer?.credit_limit_paise ?? 0;
    const availableCredit =
      creditLimit > 0 ? Math.max(0, creditLimit - totalDue) : null;
    return { totalInvoiced, totalPaid, totalDue, advance, creditLimit, availableCredit };
  }, [invoiceRows, advances, customer]);

  const statementRows = useMemo(() => {
    const rows = buildStatement(invoices, payments, advances);
    let bal = customer?.opening_balance_paise ?? 0;
    return rows.map((r) => {
      bal += r.debit_paise - r.credit_paise;
      return { ...r, balance_paise: bal };
    });
  }, [invoices, payments, advances, customer]);

  function openPaymentModal(preselectInvoiceId?: string) {
    setReceivePreselectInvoiceId(preselectInvoiceId);
    if (preselectInvoiceId) {
      const row = invoiceRows.find((r) => r.inv.id === preselectInvoiceId);
      setReceivePreselectAmountPaise(row?.outstanding_paise);
    } else {
      setReceivePreselectAmountPaise(undefined);
    }
    setReceiveOpen(true);
  }

  const invoiceById = useMemo(() => {
    const m = new Map<string, Invoice>();
    for (const inv of invoices) m.set(inv.id, inv);
    return m;
  }, [invoices]);

  const exportStatementCsv = useCallback(async () => {
    if (!customer) return;
    const fname = `customer-statement-${(customer.name || 'unknown')
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
  }, [statementRows, customer]);

  if (loading || dataLoading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId)
    return (
      <div className="p-6 text-slate-600">No active business — complete onboarding first.</div>
    );
  if (!customer) return <div className="p-6 text-slate-600">Customer not found.</div>;
  if (error) return <div className="p-6 text-rose-600 whitespace-pre-wrap">{error}</div>;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link to="/customers" className="text-sm text-blue-700 hover:underline">
          ← Customers
        </Link>
      </div>

      {/* Section 1: Header */}
      <section className="border border-slate-200 rounded p-4 bg-white flex flex-col gap-2">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{customer.name}</h1>
            <div className="text-sm text-slate-600 flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
              {customer.phone && <span>📞 {customer.phone}</span>}
              {customer.gstin && <span>GSTIN: {customer.gstin}</span>}
              {customer.state && <span>State: {customer.state}</span>}
            </div>
            <div className="text-sm text-slate-600 mt-1">
              {customer.billing_address || '—'}
            </div>
            <div className="text-xs text-slate-500 mt-2 flex gap-4">
              <span>
                Credit limit: <Money paise={customer.credit_limit_paise} />
              </span>
              <span>
                Opening balance: <Money paise={customer.opening_balance_paise} />
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => navigate(`/invoices/new?customer=${customer.id}`)}
                className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
              >
                + New Invoice
              </button>
              <button
                type="button"
                onClick={() => openPaymentModal()}
                className="text-sm bg-emerald-700 text-white rounded px-3 py-1.5 hover:bg-emerald-800"
              >
                + Add Payment
              </button>
            </div>
            <div className="flex gap-2 text-xs">
              <Link
                to={`/parties/customer/${customer.id}/ledger`}
                className="text-blue-700 hover:underline"
              >
                View Statement
              </Link>
              <button
                type="button"
                onClick={() => navigate(`/customers?edit=${customer.id}`)}
                className="text-slate-700 hover:underline"
              >
                Edit Customer
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Financial Summary */}
      <section className="grid grid-cols-5 gap-3">
        <SummaryCard label="Total Invoiced" paise={summary.totalInvoiced} />
        <SummaryCard label="Total Paid" paise={summary.totalPaid} tone="emerald" />
        <SummaryCard
          label="Total Due"
          paise={summary.totalDue}
          tone={summary.totalDue > 0 ? 'rose' : 'slate'}
        />
        <SummaryCard
          label="Customer Advance"
          paise={summary.advance}
          tone={summary.advance > 0 ? 'blue' : 'slate'}
        />
        <SummaryCard
          label="Available Credit"
          paise={summary.availableCredit}
          tone={
            summary.availableCredit === null
              ? 'slate'
              : summary.availableCredit === 0
                ? 'rose'
                : 'emerald'
          }
          fallback={summary.availableCredit === null ? 'No limit set' : undefined}
        />
      </section>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 text-sm">
        {(['invoices', 'payments', 'statement'] as Tab[]).map((t) => (
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
            {t === 'invoices'
              ? `Invoices (${invoiceRows.filter((r) => r.dyn_status !== 'CANCELLED').length})`
              : t === 'payments'
                ? `Payments (${payments.length})`
                : 'Statement'}
          </button>
        ))}
      </div>

      {activeTab === 'invoices' && (
        <section className="border border-slate-200 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th className="text-left px-2 py-2">Invoice #</th>
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
              {invoiceRows.length === 0 && (
                <tr>
                  <td className="px-2 py-4 text-slate-500 text-center" colSpan={8}>
                    No invoices for this customer yet.
                  </td>
                </tr>
              )}
              {invoiceRows.map((r) => (
                <tr key={r.inv.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">
                    <Link
                      to={`/invoices/${r.inv.id}`}
                      className="text-blue-700 hover:underline font-mono text-xs"
                    >
                      {r.inv.invoice_number}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5">{fmtDateShort(r.inv.invoice_date)}</td>
                  <td className="px-2 py-1.5">
                    {r.inv.due_date ? fmtDateShort(r.inv.due_date) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Money paise={r.inv.total_paise} />
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
                        onClick={() => openPaymentModal(r.inv.id)}
                        className="text-xs text-emerald-700 hover:underline mr-2"
                      >
                        Record Payment
                      </button>
                    )}
                    <Link
                      to={`/invoices/${r.inv.id}/print`}
                      className="text-xs text-slate-600 hover:underline"
                    >
                      Print
                    </Link>
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
                <th className="text-left px-2 py-2">Receipt #</th>
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
                    No payments recorded for this customer yet.
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
                              {a.invoice_id ? (
                                <Link
                                  to={`/invoices/${a.invoice_id}`}
                                  className="text-blue-700 hover:underline font-mono"
                                >
                                  {invoiceById.get(a.invoice_id)?.invoice_number ??
                                    a.invoice_id.slice(-8)}
                                </Link>
                              ) : (
                                a.bill_id
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
              Chronological running-balance statement (Debit = customer owes you, Credit = money received).
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
                to={`/parties/customer/${customer.id}/ledger`}
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

      {receiveOpen && businessId && (
        <ReceivePaymentModal
          businessId={businessId}
          deviceId={deviceId ?? ''}
          preselectCustomerId={customer.id}
          preselectInvoiceId={receivePreselectInvoiceId}
          preselectAmountPaise={receivePreselectAmountPaise}
          onClose={() => setReceiveOpen(false)}
          onSaved={() => {
            setReceiveOpen(false);
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

function StatusPill({ status }: { status: InvoiceRow['dyn_status'] }) {
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

