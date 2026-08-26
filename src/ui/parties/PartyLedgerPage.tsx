import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db } from '../../db';
import type {
  Advance,
  Customer,
  Invoice,
  PartyType,
  Payment,
  Purchase,
  Supplier,
} from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import Money from '../components/Money';
import { streamCsvExport } from '../../csv/streamCsvExport';

// A single running-balance ledger row for one party (customer or supplier).
// For a customer we build receivables: invoices increase balance owed BY them,
// payments/credit-notes/applied-advances decrease it, unapplied-advance remainder
// is shown as a credit balance line (party owes negative).
// For a supplier the sign is flipped semantically (invoices → we owe THEM),
// but the running arithmetic is symmetric — we just relabel the header.
interface LedgerRow {
  date: string; // YYYY-MM-DD
  ref: string;
  kind:
    | 'invoice'
    | 'credit_note'
    | 'purchase'
    | 'debit_note'
    | 'payment'
    | 'advance'
    | 'advance_applied'
    | 'sales_return_credit';
  description: string;
  debit_paise: number; // increases outstanding
  credit_paise: number; // decreases outstanding
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function tsCompare(a: LedgerRow, b: LedgerRow): number {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  const rank: Record<LedgerRow['kind'], number> = {
    invoice: 0,
    purchase: 0,
    credit_note: 1,
    debit_note: 1,
    sales_return_credit: 2,
    advance: 2,
    advance_applied: 3,
    payment: 4,
  };
  return rank[a.kind] - rank[b.kind];
}

export default function PartyLedgerPage() {
  const { partyType, id } = useParams<{ partyType: PartyType; id: string }>();
  const { businessId, loading } = useActiveBusiness();

  const [party, setParty] = useState<Customer | Supplier | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [fromYmd, setFromYmd] = useState<string>('');
  const [toYmd, setToYmd] = useState<string>(todayYmd());

  useEffect(() => {
    if (!businessId || !partyType || !id) return;
    let cancelled = false;
    setDataLoading(true);
    setDataError(null);
    (async () => {
      try {
        if (partyType === 'customer') {
          const [cust, invs, pays, advs] = await Promise.all([
            db.customers.get(id),
            db.invoices
              .where('[business_id+customer_id]')
              .equals([businessId, id])
              .toArray(),
            db.payments
              .where('[business_id+direction]')
              .equals([businessId, 'in'])
              .filter((p) => p.party_id === id && p.party_type === 'customer')
              .toArray(),
            db.advances
              .where('business_id')
              .equals(businessId)
              .filter((a) => a.party_type === 'customer' && a.party_id === id)
              .toArray(),
          ]);
          if (cancelled) return;
          setParty(cust ?? null);
          setRows(buildCustomerRows(cust ?? null, invs, pays, advs));
        } else {
          const [sup, bills, pays, advs] = await Promise.all([
            db.suppliers.get(id),
            db.purchases
              .where('[business_id+supplier_id]')
              .equals([businessId, id])
              .toArray(),
            db.payments
              .where('[business_id+direction]')
              .equals([businessId, 'out'])
              .filter((p) => p.party_id === id && p.party_type === 'supplier')
              .toArray(),
            db.advances
              .where('business_id')
              .equals(businessId)
              .filter((a) => a.party_type === 'supplier' && a.party_id === id)
              .toArray(),
          ]);
          if (cancelled) return;
          setParty(sup ?? null);
          setRows(buildSupplierRows(sup ?? null, bills, pays, advs));
        }
      } catch (e) {
        if (!cancelled) setDataError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, partyType, id]);

  const filteredRows = useMemo(() => {
    return rows
      .filter((r) => (fromYmd ? r.date >= fromYmd : true))
      .filter((r) => (toYmd ? r.date <= toYmd : true))
      .sort(tsCompare);
  }, [rows, fromYmd, toYmd]);

  // Opening balance: party's stored opening_balance_paise, plus any rows
  // strictly before fromYmd folded in.
  const openingBalance = useMemo(() => {
    let bal = party?.opening_balance_paise ?? 0;
    if (!fromYmd) return bal;
    for (const r of [...rows].sort(tsCompare)) {
      if (r.date >= fromYmd) break;
      bal += r.debit_paise - r.credit_paise;
    }
    return bal;
  }, [rows, fromYmd, party]);

  const rowsWithBalance = useMemo(() => {
    let bal = openingBalance;
    return filteredRows.map((r) => {
      bal += r.debit_paise - r.credit_paise;
      return { ...r, balance_paise: bal };
    });
  }, [filteredRows, openingBalance]);

  const closingBalance = rowsWithBalance.length
    ? rowsWithBalance[rowsWithBalance.length - 1].balance_paise
    : openingBalance;

  const totalDebit = filteredRows.reduce((s, r) => s + r.debit_paise, 0);
  const totalCredit = filteredRows.reduce((s, r) => s + r.credit_paise, 0);

  async function exportCsv() {
    if (!party) return;
    const fname = `${partyType}-ledger-${(party.name || id || 'unknown')
      .replace(/[^a-zA-Z0-9-]+/g, '_')
      .slice(0, 40)}-${todayYmd()}.csv`;
    const iter = function* () {
      yield {
        date: '',
        ref: '',
        kind: '',
        description: 'Opening Balance',
        debit_paise: 0,
        credit_paise: 0,
        balance_paise: openingBalance,
      };
      for (const r of rowsWithBalance) yield r;
      yield {
        date: '',
        ref: '',
        kind: '',
        description: 'Period Totals',
        debit_paise: totalDebit,
        credit_paise: totalCredit,
        balance_paise: closingBalance,
      };
      yield {
        date: '',
        ref: '',
        kind: '',
        description: 'Closing Balance',
        debit_paise: 0,
        credit_paise: 0,
        balance_paise: closingBalance,
      };
    };
    await streamCsvExport({
      filename: fname,
      columns: [
        { header: 'Date', get: (r: { date: string }) => r.date },
        { header: 'Ref #', get: (r: { ref: string }) => r.ref },
        { header: 'Type', get: (r: { kind: string }) => r.kind },
        { header: 'Description', get: (r: { description: string }) => r.description },
        {
          header: 'Debit ₹',
          get: (r: { debit_paise: number }) =>
            r.debit_paise ? (r.debit_paise / 100).toFixed(2) : '',
        },
        {
          header: 'Credit ₹',
          get: (r: { credit_paise: number }) =>
            r.credit_paise ? (r.credit_paise / 100).toFixed(2) : '',
        },
        {
          header: 'Balance ₹',
          get: (r: { balance_paise: number }) => (r.balance_paise / 100).toFixed(2),
        },
      ],
      rows: iter(),
    });
  }

  if (loading || dataLoading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId)
    return (
      <div className="p-6 text-slate-600">No active business — complete onboarding first.</div>
    );
  if (!party)
    return (
      <div className="p-6 text-slate-600">
        {partyType === 'customer' ? 'Customer' : 'Supplier'} not found.
      </div>
    );
  if (dataError)
    return <div className="p-6 text-rose-600 whitespace-pre-wrap">{dataError}</div>;

  const backLink = partyType === 'customer' ? '/customers' : '/suppliers';
  const detailLink =
    partyType === 'customer' ? `/customers/${id}` : `/suppliers/${id}`;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to={backLink} className="text-sm text-blue-700 hover:underline">
            ← {partyType === 'customer' ? 'Customers' : 'Suppliers'}
          </Link>
          <h1 className="text-xl font-semibold">
            Ledger — <Link to={detailLink} className="text-blue-700 hover:underline">{party.name}</Link>
          </h1>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
        >
          Download statement (CSV)
        </button>
      </div>

      <section className="flex gap-4 items-end text-sm">
        <label className="flex flex-col">
          <span className="text-slate-600 mb-1">From</span>
          <input
            type="date"
            value={fromYmd}
            onChange={(e) => setFromYmd(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-600 mb-1">To</span>
          <input
            type="date"
            value={toYmd}
            onChange={(e) => setToYmd(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5"
          />
        </label>
        <div className="ml-auto text-right text-xs text-slate-500">
          <div>
            Opening balance: <Money paise={openingBalance} />
          </div>
          <div>
            Closing balance: <strong><Money paise={closingBalance} /></strong>
            {' — '}
            {closingBalance > 0
              ? partyType === 'customer'
                ? 'party owes you'
                : 'you owe party'
              : closingBalance < 0
                ? partyType === 'customer'
                  ? 'you hold advance'
                  : 'party holds advance'
                : 'settled'}
          </div>
        </div>
      </section>

      <section className="border border-slate-200 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="text-left px-2 py-2 w-28">Date</th>
              <th className="text-left px-2 py-2 w-32">Ref #</th>
              <th className="text-left px-2 py-2 w-28">Type</th>
              <th className="text-left px-2 py-2">Description</th>
              <th className="text-right px-2 py-2 w-28">Debit</th>
              <th className="text-right px-2 py-2 w-28">Credit</th>
              <th className="text-right px-2 py-2 w-32">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-100 bg-slate-50/60">
              <td className="px-2 py-2 text-slate-500" colSpan={3}>
                {fromYmd || '—'}
              </td>
              <td className="px-2 py-2 text-slate-500">Opening balance</td>
              <td className="px-2 py-2"></td>
              <td className="px-2 py-2"></td>
              <td className="px-2 py-2 text-right">
                <Money paise={openingBalance} />
              </td>
            </tr>
            {rowsWithBalance.length === 0 && (
              <tr className="border-t border-slate-100">
                <td className="px-2 py-4 text-slate-500 text-center" colSpan={7}>
                  No ledger entries in range.
                </td>
              </tr>
            )}
            {rowsWithBalance.map((r, idx) => (
              <tr key={idx} className="border-t border-slate-100 align-top">
                <td className="px-2 py-1.5">{r.date}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{r.ref || '—'}</td>
                <td className="px-2 py-1.5 text-xs text-slate-500">
                  {r.kind === 'sales_return_credit' ? (
                    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                      Sales return credit
                    </span>
                  ) : (
                    r.kind
                  )}
                </td>
                <td className="px-2 py-1.5">{r.description}</td>
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
            <tr className="border-t border-slate-200 bg-slate-50 font-medium">
              <td className="px-2 py-2" colSpan={4}>
                Totals for period
              </td>
              <td className="px-2 py-2 text-right">
                <Money paise={totalDebit} />
              </td>
              <td className="px-2 py-2 text-right">
                <Money paise={totalCredit} />
              </td>
              <td className="px-2 py-2 text-right">
                <Money paise={closingBalance} />
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

function buildCustomerRows(
  _cust: Customer | null,
  invs: Invoice[],
  pays: Payment[],
  advs: Advance[],
): LedgerRow[] {
  // Opening balance is seeded from cust.opening_balance_paise directly into
  // the running-balance computation — don't push a synthetic dated row here.
  const out: LedgerRow[] = [];

  for (const inv of invs) {
    if (inv.status === 'cancelled' || inv.status === 'draft') continue;
    if (inv.reverses_invoice_id) {
      // credit note — inv.total_paise is negative; flip to positive credit.
      out.push({
        date: inv.invoice_date,
        ref: inv.invoice_number,
        kind: 'credit_note',
        description: `Credit note (reverses ${inv.reverses_invoice_id})`,
        debit_paise: 0,
        credit_paise: Math.abs(inv.total_paise),
      });
    } else {
      out.push({
        date: inv.invoice_date,
        ref: inv.invoice_number,
        kind: 'invoice',
        description: `Sale invoice${inv.due_date ? ` (due ${inv.due_date})` : ''}`,
        debit_paise: inv.total_paise,
        credit_paise: 0,
      });
    }
  }

  for (const pay of pays) {
    out.push({
      date: pay.payment_date,
      ref: pay.payment_number,
      kind: 'payment',
      description: `Payment received (${pay.method})${pay.reference ? ` · ${pay.reference}` : ''}`,
      debit_paise: 0,
      credit_paise: pay.amount_paise,
    });
  }

  for (const adv of advs) {
    const isReturnCredit = adv.reference?.startsWith('sales_return:') ?? false;
    out.push({
      date: adv.advance_date,
      ref: adv.advance_number,
      kind: isReturnCredit ? 'sales_return_credit' : 'advance',
      description: isReturnCredit
        ? `Sales return credit${adv.reference ? ` · ${adv.reference}` : ''}`
        : `Advance received (${adv.method})${adv.reference ? ` · ${adv.reference}` : ''}`,
      debit_paise: 0,
      credit_paise: adv.amount_paise,
    });
    // Advance applications don't move the combined AR+advance balance — the
    // invoice's own debit already nets against this credit. Emitting an
    // "applied" debit row would double-count.
  }

  return out;
}

function buildSupplierRows(
  _sup: Supplier | null,
  bills: Purchase[],
  pays: Payment[],
  advs: Advance[],
): LedgerRow[] {
  // Opening balance is seeded from sup.opening_balance_paise directly into
  // the running-balance computation — don't push a synthetic dated row here.
  const out: LedgerRow[] = [];

  for (const bill of bills) {
    if (bill.status === 'cancelled') continue;
    if (bill.total_paise < 0) {
      // debit note (purchase return)
      out.push({
        date: bill.bill_date,
        ref: bill.bill_number,
        kind: 'debit_note',
        description: `Debit note (purchase return)`,
        debit_paise: 0,
        credit_paise: Math.abs(bill.total_paise),
      });
    } else {
      out.push({
        date: bill.bill_date,
        ref: bill.bill_number,
        kind: 'purchase',
        description: `Purchase bill${bill.due_date ? ` (due ${bill.due_date})` : ''}`,
        debit_paise: bill.total_paise,
        credit_paise: 0,
      });
    }
  }

  for (const pay of pays) {
    out.push({
      date: pay.payment_date,
      ref: pay.payment_number,
      kind: 'payment',
      description: `Payment made (${pay.method})${pay.reference ? ` · ${pay.reference}` : ''}`,
      debit_paise: 0,
      credit_paise: pay.amount_paise,
    });
  }

  for (const adv of advs) {
    out.push({
      date: adv.advance_date,
      ref: adv.advance_number,
      kind: 'advance',
      description: `Advance paid (${adv.method})${adv.reference ? ` · ${adv.reference}` : ''}`,
      debit_paise: 0,
      credit_paise: adv.amount_paise,
    });
    // Advance applications don't move the combined AP+advance balance — the
    // bill's own debit already nets against this credit. Emitting an "applied"
    // debit row would double-count.
  }

  return out;
}
