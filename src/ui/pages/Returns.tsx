import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { db } from '../../db';
import type { Customer, Invoice, SalesReturn } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import SalesReturnPicker from '../returns/SalesReturnPicker';
import Money from '../components/Money';
import { log } from '../../lib/log';

// Sales Returns are per-line, first-class documents (schema v5). Distinct
// from Invoice Edits, which reissue the invoice. This page:
//   - lists posted sales_returns for the active business
//   - lets the user pick an eligible source invoice and open the per-line
//     picker to post a new return
//
// Data source: `sales_returns` + `sales_return_items`. We NEVER read
// `invoices.reverses_invoice_id` here — that field belongs to the old
// full-invoice-reversal CN flow and has been superseded by native returns.

export default function Returns() {
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  // All invoices for this business — small enough to filter client-side, and
  // we need them for the "reverses invoice" join column below.
  const invoices = useLiveQuery<Invoice[]>(
    async () => {
      if (!businessId) return [];
      return db.invoices.where('business_id').equals(businessId).toArray();
    },
    [businessId],
    [] as Invoice[],
  );

  const customers = useLiveQuery<Customer[]>(
    async () => {
      if (!businessId) return [];
      return db.customers.where('business_id').equals(businessId).toArray();
    },
    [businessId],
    [] as Customer[],
  );

  const salesReturns = useLiveQuery<SalesReturn[]>(
    async () => {
      if (!businessId) return [];
      const rows = await db.sales_returns
        .where('business_id')
        .equals(businessId)
        .toArray();
      return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },
    [businessId],
    [] as SalesReturn[],
  );

  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customers ?? []) m.set(c.id, c);
    return m;
  }, [customers]);

  const invoicesById = useMemo(() => {
    const m = new Map<string, Invoice>();
    for (const i of invoices ?? []) m.set(i.id, i);
    return m;
  }, [invoices]);

  // Eligible source invoices: not cancelled, not a legacy CN, not superseded
  // by an edit reissue. Full-quantity-returned invoices are technically still
  // eligible (the picker will show 0 available on every line and disable
  // Post), but they're a small population and filtering them out here would
  // require joining sales_return_items — cheaper to let the picker handle it.
  const returnableInvoices = useMemo(() => {
    return (invoices ?? [])
      .filter(
        (i) =>
          i.reverses_invoice_id === null &&
          i.reversed_by_invoice_id === null &&
          i.status !== 'cancelled',
      )
      .sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1));
  }, [invoices]);

  const filteredReturnable = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return returnableInvoices;
    return returnableInvoices.filter((i) => {
      const cust = customerById.get(i.customer_id);
      return (
        i.invoice_number.toLowerCase().includes(q) ||
        (cust?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [returnableInvoices, pickerQuery, customerById]);

  function beginNew() {
    log.info('returnsPage', 'begin new sales return', { businessId });
    setPickerQuery('');
    setSelectedInvoiceId(null);
    setPickerOpen(true);
  }

  function pickInvoice(id: string) {
    log.info('returnsPage', 'picked source invoice', { invoiceId: id });
    setSelectedInvoiceId(id);
    setPickerOpen(false);
  }

  function cancelFlow() {
    setSelectedInvoiceId(null);
    setPickerOpen(false);
  }

  if (loading) return <div className="p-6 text-fg-muted">Loading...</div>;
  if (!businessId || !deviceId) {
    return (
      <div className="p-6 text-fg-muted">
        No active business — complete onboarding first.
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-fg">Sales returns</h1>
          <p className="text-sm text-fg-muted">
            Per-line returns against posted invoices — stock restored, invoice
            balance adjusted, credit issued for excess.
          </p>
        </div>
        {!pickerOpen && !selectedInvoiceId && (
          <button
            type="button"
            onClick={beginNew}
            className="bg-accent text-accent-fg text-sm rounded px-3 py-1.5 font-medium"
          >
            New sales return
          </button>
        )}
      </div>

      {/* Invoice picker */}
      {pickerOpen && (
        <section className="border border-border rounded p-3 bg-surface flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-fg">
              Pick an invoice to return
            </h2>
            <button
              type="button"
              onClick={cancelFlow}
              className="text-xs text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
          </div>
          <input
            type="text"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="Search by invoice # or customer name…"
            className="w-full border border-border rounded px-2 py-1.5 text-sm bg-surface text-fg"
            autoFocus
          />
          <div className="max-h-96 overflow-auto border border-border rounded">
            <table className="w-full text-sm">
              <thead className="bg-surface-hover text-xs uppercase text-fg-muted sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Invoice #</th>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="w-16"></th>
                </tr>
              </thead>
              <tbody>
                {filteredReturnable.map((inv) => (
                  <tr key={inv.id} className="border-t border-border">
                    <td className="px-3 py-1.5 text-fg-muted">{inv.invoice_date}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {inv.invoice_number}
                    </td>
                    <td className="px-3 py-1.5">
                      {customerById.get(inv.customer_id)?.name ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <Money paise={inv.total_paise} />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => pickInvoice(inv.id)}
                        className="text-xs text-blue-700 hover:underline"
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredReturnable.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-fg-subtle">
                      {returnableInvoices.length === 0
                        ? 'No invoices eligible for return.'
                        : 'No matches.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Per-line picker */}
      {selectedInvoiceId && (
        <SalesReturnPicker
          businessId={businessId}
          deviceId={deviceId}
          invoiceId={selectedInvoiceId}
          onClose={cancelFlow}
          onPosted={() => cancelFlow()}
        />
      )}

      {/* Existing sales returns */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">Existing sales returns</h2>
        <div className="border border-border rounded overflow-hidden bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-hover text-xs uppercase text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Return #</th>
                <th className="text-left px-3 py-2">Against invoice</th>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Amount</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {(salesReturns ?? []).map((sr) => {
                const original = invoicesById.get(sr.original_invoice_id);
                return (
                  <tr key={sr.id} className="border-t border-border">
                    <td className="px-3 py-1.5 text-fg-muted">{sr.return_date}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{sr.return_number}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {original ? (
                        <Link
                          to={`/invoices/${original.id}`}
                          className="text-blue-700 hover:underline"
                        >
                          {original.invoice_number}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {customerById.get(sr.customer_id)?.name ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          sr.status === 'cancelled'
                            ? 'text-fg-muted'
                            : 'text-fg'
                        }
                      >
                        {sr.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <Money paise={sr.total_paise} />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {original && (
                        <Link
                          to={`/invoices/${original.id}`}
                          className="text-xs text-blue-700 hover:underline"
                        >
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(salesReturns ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-fg-subtle">
                    No sales returns yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
