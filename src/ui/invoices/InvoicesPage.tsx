import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Invoice, InvoiceStatus } from '../../db/types';
import { InvoiceService } from '../../domain/InvoiceService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import StatusBadge from '../components/StatusBadge';
import { paginateCollection, matchesText } from '../components/pagination';

const STATUSES: InvoiceStatus[] = ['draft', 'issued', 'partial', 'paid', 'cancelled'];

export default function InvoicesPage() {
  const { businessId, loading } = useActiveBusiness();
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | ''>('');
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [fyFilter, setFyFilter] = useState<string>('');
  const [showVoided, setShowVoided] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerById, setCustomerById] = useState<Map<string, Customer>>(new Map());
  const [reloadTick, setReloadTick] = useState(0);
  const serviceRef = useRef<InvoiceService | null>(null);
  if (serviceRef.current === null) serviceRef.current = new InvoiceService();

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const rows = await db.customers.where('business_id').equals(businessId).toArray();
      setCustomers(rows);
      setCustomerById(new Map(rows.map((c) => [c.id, c])));
    })();
  }, [businessId]);

  const fetchPage = useCallback(
    async ({
      offset,
      limit,
      search,
      filters,
    }: {
      offset: number;
      limit: number;
      search: string;
      filters: Record<string, string>;
    }) => {
      if (!businessId) return { rows: [], total: 0 };
      const makeCol = () => {
        let c;
        if (statusFilter) {
          c = db.invoices
            .where('[business_id+status]')
            .equals([businessId, statusFilter]);
        } else if (customerFilter) {
          c = db.invoices
            .where('[business_id+customer_id]')
            .equals([businessId, customerFilter]);
        } else if (fyFilter) {
          c = db.invoices
            .where('[business_id+financial_year]')
            .equals([businessId, fyFilter]);
        } else {
          c = db.invoices.where('business_id').equals(businessId);
        }
        c = c.reverse();
        c = c.filter((inv) => {
          // Recycle-bin: soft-deleted invoices never appear on the main list.
          // They live at /invoices/deleted and can be restored from there.
          if (inv.deleted_at) return false;
          // Credit notes are audit rows created by voiding/editing; hiding
          // them keeps the list showing one entry per real invoice number.
          if (!showVoided && inv.reverses_invoice_id) return false;
          if (!showVoided && inv.reversed_by_invoice_id) return false;
          if (
            search &&
            !(
              matchesText(inv.invoice_number, search) ||
              matchesText(inv.notes, search) ||
              matchesText(customerById.get(inv.customer_id)?.name, search)
            )
          ) {
            return false;
          }
          if (
            filters.invoice_number &&
            !matchesText(inv.invoice_number, filters.invoice_number)
          ) {
            return false;
          }
          if (
            filters.customer &&
            !matchesText(customerById.get(inv.customer_id)?.name, filters.customer)
          ) {
            return false;
          }
          return true;
        });
        return c;
      };
      return paginateCollection<Invoice>(makeCol, offset, limit);
    },
    [businessId, statusFilter, customerFilter, fyFilter, customerById, showVoided],
  );

  const columns: ColumnDef<Invoice>[] = [
    {
      key: 'invoice_number',
      header: 'Invoice #',
      filterable: true,
      render: (r) => (
        <Link to={`/invoices/${r.id}`} className="text-blue-700 hover:underline">
          {r.invoice_number}
        </Link>
      ),
    },
    { key: 'invoice_date', header: 'Date', render: (r) => r.invoice_date },
    {
      key: 'customer',
      header: 'Customer',
      filterable: true,
      render: (r) => customerById.get(r.customer_id)?.name ?? r.customer_id,
    },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      render: (r) => <Money paise={r.total_paise} />,
    },
    {
      key: 'balance',
      header: 'Balance',
      className: 'text-right',
      render: (r) => <Money paise={r.balance_paise} />,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'fy', header: 'FY', render: (r) => r.financial_year },
    {
      key: 'edit',
      header: '',
      render: (r) => (
        <div className="flex items-center gap-3 justify-end">
          {r.reversed_by_invoice_id ? (
            <span className="text-xs text-slate-400">voided</span>
          ) : r.status === 'cancelled' ? (
            <span className="text-xs text-slate-400">cancelled</span>
          ) : (
            <Link
              to={`/invoices/${r.id}/edit`}
              className="text-xs text-blue-700 hover:underline"
            >
              Edit
            </Link>
          )}
          <button
            type="button"
            onClick={() => handleDelete(r)}
            className="text-xs text-rose-700 hover:underline"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  async function handleDelete(inv: Invoice) {
    const ok = window.confirm(
      `Delete invoice ${inv.invoice_number}?\n\nIt will move to Recycle Bin (Invoices → Deleted) and can be restored later.`,
    );
    if (!ok) return;
    try {
      await serviceRef.current!.deleteInvoice(inv.id, 'deleted from list');
      setReloadTick((t) => t + 1);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function exportCsv({
    search,
    filters,
  }: {
    search: string;
    filters: Record<string, string>;
  }) {
    if (!businessId) return;
    const { streamCsvExport } = await import('../../csv/streamCsvExport');
    const iterate = async function* () {
      const PAGE = 500;
      let offset = 0;
      while (true) {
        const page = await fetchPage({ offset, limit: PAGE, search, filters });
        for (const r of page.rows) yield r;
        offset += PAGE;
        if (offset >= page.total || page.rows.length === 0) break;
      }
    };
    await streamCsvExport({
      filename: 'invoices.csv',
      columns: [
        { header: 'Invoice #', get: (r: Invoice) => r.invoice_number },
        { header: 'Date', get: (r: Invoice) => r.invoice_date },
        { header: 'Due Date', get: (r: Invoice) => r.due_date ?? '' },
        {
          header: 'Customer',
          get: (r: Invoice) => customerById.get(r.customer_id)?.name ?? r.customer_id,
        },
        { header: 'FY', get: (r: Invoice) => r.financial_year },
        { header: 'Subtotal', get: (r: Invoice) => (r.subtotal_paise / 100).toFixed(2) },
        { header: 'Taxable', get: (r: Invoice) => (r.taxable_paise / 100).toFixed(2) },
        { header: 'CGST', get: (r: Invoice) => (r.cgst_paise / 100).toFixed(2) },
        { header: 'SGST', get: (r: Invoice) => (r.sgst_paise / 100).toFixed(2) },
        { header: 'IGST', get: (r: Invoice) => (r.igst_paise / 100).toFixed(2) },
        { header: 'Total', get: (r: Invoice) => (r.total_paise / 100).toFixed(2) },
        { header: 'Paid', get: (r: Invoice) => (r.paid_paise / 100).toFixed(2) },
        { header: 'Balance', get: (r: Invoice) => (r.balance_paise / 100).toFixed(2) },
        { header: 'Status', get: (r: Invoice) => r.status },
      ],
      rows: iterate(),
    });
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
        <h1 className="text-xl font-semibold">Invoices</h1>
        <div className="flex items-center gap-3">
          <Link
            to="/invoices/deleted"
            className="text-sm text-slate-600 hover:underline"
          >
            Recycle Bin
          </Link>
          <Link
            to="/invoices/new"
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 hover:bg-slate-800"
          >
            New Invoice
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as InvoiceStatus | '')}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={fyFilter}
          onChange={(e) => setFyFilter(e.target.value)}
          placeholder="FY (e.g. 2026-27)"
          className="border border-slate-300 rounded px-2 py-1.5 w-40"
        />
        <label className="flex items-center gap-1.5 text-slate-600">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(e) => setShowVoided(e.target.checked)}
          />
          Show voided
        </label>
      </div>

      <DataTable<Invoice>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[statusFilter, customerFilter, fyFilter, showVoided, reloadTick]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search invoice # / customer / notes"
        onExport={exportCsv}
      />
    </div>
  );
}
