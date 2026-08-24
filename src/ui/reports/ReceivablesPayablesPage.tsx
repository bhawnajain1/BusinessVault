import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Advance, Customer, Invoice, Purchase, Supplier } from '../../db/types';
import { money } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import {
  computePayables,
  computeReceivables,
  type CustomerReceivable,
  type DerivedPayables,
  type DerivedReceivables,
  type SupplierPayable,
} from '../../domain/partyLedger';

// Receivables & Payables — derived from transactions per payablesRec.md.
//
// Both sides recompute outstanding from scratch (grand_total − paid − reversals)
// rather than trusting `invoice.balance_paise` / `purchase.balance_paise`,
// because credit / debit notes leave the original row's cached balance
// untouched. Aging buckets and overdue counts come from the same derivation.

interface Loaded {
  ar: DerivedReceivables;
  ap: DerivedPayables;
  customerById: Map<string, Customer>;
  supplierById: Map<string, Supplier>;
  asOfYmd: string;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReceivablesPayablesPage() {
  const { businessId, error: bizError } = useBusinessId();
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const [invoices, customers, bills, suppliers, advances] = await Promise.all([
          db.invoices.where('business_id').equals(businessId).toArray() as Promise<
            Invoice[]
          >,
          db.customers.where('business_id').equals(businessId).toArray() as Promise<
            Customer[]
          >,
          db.purchases.where('business_id').equals(businessId).toArray() as Promise<
            Purchase[]
          >,
          db.suppliers.where('business_id').equals(businessId).toArray() as Promise<
            Supplier[]
          >,
          db.advances.where('business_id').equals(businessId).toArray() as Promise<
            Advance[]
          >,
        ]);
        const asOfYmd = todayYmd();
        const ar = computeReceivables(invoices, asOfYmd, advances, customers);
        const ap = computePayables(bills, asOfYmd, advances, suppliers);
        const customerById = new Map(customers.map((c) => [c.id, c]));
        const supplierById = new Map(suppliers.map((s) => [s.id, s]));
        if (alive) setData({ ar, ap, customerById, supplierById, asOfYmd });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [businessId]);

  const openArRows = useMemo<CustomerReceivable[]>(
    () =>
      data
        ? data.ar.perCustomer.filter(
            (r) => r.outstanding_paise > 0 || r.advance_paise > 0,
          )
        : [],
    [data],
  );
  const openApRows = useMemo<SupplierPayable[]>(
    () =>
      data
        ? data.ap.perSupplier.filter(
            (r) => r.outstanding_paise > 0 || r.advance_paise > 0,
          )
        : [],
    [data],
  );

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Receivables & Payables</h1>
        <p className="text-sm text-slate-500">
          Open balances by customer (money owed to you) and supplier (money you owe).
          Derived from invoices, payments and credit / debit notes — never from a
          cached balance field.
        </p>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SummaryCard
              label="Total Receivables"
              tone="ar"
              amountPaise={data.ar.totals.outstanding_paise}
              overduePaise={
                data.ar.totals.aging.total_paise -
                data.ar.totals.aging.current_paise
              }
              advancePaise={data.ar.totals.advance_paise}
              subtitle={`${openArRows.filter((r) => r.outstanding_paise > 0).length} customer(s) with open balance — ${
                data.ar.totals.overdue_count
              } overdue invoice(s)`}
            />
            <SummaryCard
              label="Total Payables"
              tone="ap"
              amountPaise={data.ap.totals.outstanding_paise}
              overduePaise={
                data.ap.totals.aging.total_paise -
                data.ap.totals.aging.current_paise
              }
              advancePaise={data.ap.totals.advance_paise}
              subtitle={`${openApRows.filter((r) => r.outstanding_paise > 0).length} supplier(s) with open balance — ${
                data.ap.totals.overdue_count
              } overdue bill(s)`}
            />
          </div>

          <section className="space-y-2">
            <h2 className="text-lg font-medium">By customer (Accounts Receivable)</h2>
            <div className="overflow-auto border border-slate-200 rounded bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">Customer</th>
                    <th className="text-right px-3 py-2"># Inv</th>
                    <th className="text-right px-3 py-2">Billed</th>
                    <th className="text-right px-3 py-2">Paid</th>
                    <th className="text-right px-3 py-2">Cr. Notes</th>
                    <th className="text-right px-3 py-2">Current</th>
                    <th className="text-right px-3 py-2">1-30</th>
                    <th className="text-right px-3 py-2">31-60</th>
                    <th className="text-right px-3 py-2">61-90</th>
                    <th className="text-right px-3 py-2">90+</th>
                    <th className="text-right px-3 py-2">Outstanding</th>
                    <th className="text-right px-3 py-2">Advance</th>
                  </tr>
                </thead>
                <tbody>
                  {openArRows.map((r) => (
                    <tr key={r.customer_id} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">
                        <Link
                          to={`/customers`}
                          className="text-blue-700 hover:underline"
                          title={`View customer ${data.customerById.get(r.customer_id)?.name ?? r.customer_id}`}
                        >
                          {data.customerById.get(r.customer_id)?.name ?? '(unknown)'}
                        </Link>
                        {r.overdue_count > 0 && (
                          <span className="ml-2 inline-block text-[10px] uppercase tracking-wide bg-rose-100 text-rose-700 rounded px-1.5 py-0.5">
                            {r.overdue_count} overdue
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.invoice_count}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.total_billed_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.total_paid_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.total_credit_note_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.current_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d1_30_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d31_60_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d61_90_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d90plus_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                        {money(r.outstanding_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">
                        {r.advance_paise > 0 ? money(r.advance_paise) : ''}
                      </td>
                    </tr>
                  ))}
                  {openArRows.length === 0 && !loading && (
                    <tr>
                      <td colSpan={12} className="px-3 py-6 text-center text-slate-400">
                        No customers with open receivables.
                      </td>
                    </tr>
                  )}
                </tbody>
                {openArRows.length > 0 && (
                  <tfoot className="bg-slate-50 font-semibold">
                    <tr>
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {openArRows.reduce((n, r) => n + r.invoice_count, 0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.total_billed_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.total_paid_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.total_credit_note_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.aging.current_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.aging.d1_30_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.aging.d31_60_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.aging.d61_90_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.aging.d90plus_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.outstanding_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ar.totals.advance_paise)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-medium">By supplier (Accounts Payable)</h2>
            <div className="overflow-auto border border-slate-200 rounded bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">Supplier</th>
                    <th className="text-right px-3 py-2"># Bills</th>
                    <th className="text-right px-3 py-2">Billed</th>
                    <th className="text-right px-3 py-2">Paid</th>
                    <th className="text-right px-3 py-2">Db. Notes</th>
                    <th className="text-right px-3 py-2">Current</th>
                    <th className="text-right px-3 py-2">1-30</th>
                    <th className="text-right px-3 py-2">31-60</th>
                    <th className="text-right px-3 py-2">61-90</th>
                    <th className="text-right px-3 py-2">90+</th>
                    <th className="text-right px-3 py-2">Outstanding</th>
                    <th className="text-right px-3 py-2">Advance</th>
                  </tr>
                </thead>
                <tbody>
                  {openApRows.map((r) => (
                    <tr key={r.supplier_id} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">
                        <Link
                          to={`/suppliers`}
                          className="text-blue-700 hover:underline"
                          title={`View supplier ${data.supplierById.get(r.supplier_id)?.name ?? r.supplier_id}`}
                        >
                          {data.supplierById.get(r.supplier_id)?.name ?? '(unknown)'}
                        </Link>
                        {r.overdue_count > 0 && (
                          <span className="ml-2 inline-block text-[10px] uppercase tracking-wide bg-rose-100 text-rose-700 rounded px-1.5 py-0.5">
                            {r.overdue_count} overdue
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.bill_count}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.total_billed_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.total_paid_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.total_debit_note_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.current_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d1_30_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d31_60_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d61_90_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {money(r.aging.d90plus_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                        {money(r.outstanding_paise)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">
                        {r.advance_paise > 0 ? money(r.advance_paise) : ''}
                      </td>
                    </tr>
                  ))}
                  {openApRows.length === 0 && !loading && (
                    <tr>
                      <td colSpan={12} className="px-3 py-6 text-center text-slate-400">
                        No suppliers with open payables.
                      </td>
                    </tr>
                  )}
                </tbody>
                {openApRows.length > 0 && (
                  <tfoot className="bg-slate-50 font-semibold">
                    <tr>
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {openApRows.reduce((n, r) => n + r.bill_count, 0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.total_billed_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.total_paid_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.total_debit_note_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.aging.current_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.aging.d1_30_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.aging.d31_60_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.aging.d61_90_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.aging.d90plus_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.outstanding_paise)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(data.ap.totals.advance_paise)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>

          <p className="text-xs text-slate-500">
            As of {data.asOfYmd}. Aging uses each invoice's <code>due_date</code>;
            invoices without a due date are treated as Current. Advances show money
            over-collected from customers / owed back by suppliers (from credit /
            debit notes exceeding outstanding).
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  tone,
  amountPaise,
  overduePaise,
  advancePaise,
  subtitle,
}: {
  label: string;
  tone: 'ar' | 'ap';
  amountPaise: number;
  overduePaise: number;
  advancePaise: number;
  subtitle: string;
}) {
  const accent = tone === 'ar' ? 'text-emerald-700' : 'text-rose-700';
  return (
    <div className="border border-slate-200 rounded p-4 bg-white">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-3xl font-semibold tabular-nums mt-1 ${accent}`}>
        {money(amountPaise)}
      </div>
      <div className="text-xs text-slate-500 mt-1">{subtitle}</div>
      <div className="text-xs mt-2 space-x-3">
        <span className="text-rose-700">Overdue: {money(overduePaise)}</span>
        {advancePaise > 0 && (
          <span className="text-emerald-700">Advance: {money(advancePaise)}</span>
        )}
      </div>
    </div>
  );
}
