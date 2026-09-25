import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Invoice } from '../../db/types';
import { InvoiceService } from '../../domain/InvoiceService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import Money from '../components/Money';
import StatusBadge from '../components/StatusBadge';
import DataTable, { type ColumnDef } from '../components/DataTable';

export default function DeletedInvoicesPage() {
  const { businessId, loading } = useActiveBusiness();
  const [rows, setRows] = useState<Invoice[]>([]);
  const [customerById, setCustomerById] = useState<Map<string, Customer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!businessId) return;
    setError(null);
    try {
      const [invoices, customers] = await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.customers.where('business_id').equals(businessId).toArray(),
      ]);
      const deleted = invoices
        .filter((i) => !!i.deleted_at)
        .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''));
      setRows(deleted);
      setCustomerById(new Map(customers.map((c) => [c.id, c])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [businessId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function restore(inv: Invoice) {
    setBusyId(inv.id);
    try {
      const svc = new InvoiceService();
      await svc.restoreInvoice(inv.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function permanentlyDelete(inv: Invoice) {
    const confirmed = window.confirm(
      `Permanently delete invoice ${inv.invoice_number}?\n\nThis also deletes payments and advances linked only to this invoice. This cannot be undone. Accounting and audit history will be preserved.`,
    );
    if (!confirmed) return;

    setBusyId(inv.id);
    setError(null);
    try {
      const svc = new InvoiceService();
      await svc.permanentlyDeleteInvoice(inv.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const fetchPage = useCallback(async ({ search }: { offset: number; limit: number; search: string; filters: Record<string, string> }) => {
    const needle = search.toLowerCase();
    const filtered = needle
      ? rows.filter((invoice) => {
          const customer = customerById.get(invoice.customer_id)?.name ?? invoice.customer_id;
          return [invoice.invoice_number, invoice.invoice_date, customer, invoice.status, invoice.deleted_at, invoice.deleted_reason]
            .some((value) => String(value ?? '').toLowerCase().includes(needle));
        })
      : rows;
    return { rows: filtered, total: filtered.length };
  }, [customerById, rows]);

  const columns: ColumnDef<Invoice>[] = [
    {
      key: 'invoice_number',
      header: 'Invoice #',
      sortValue: (r) => r.invoice_number,
      render: (r) => <Link to={`/invoices/${r.id}`} className="text-blue-700 hover:underline">{r.invoice_number}</Link>,
    },
    { key: 'invoice_date', header: 'Date', sortValue: (r) => r.invoice_date, render: (r) => r.invoice_date },
    {
      key: 'customer',
      header: 'Customer',
      sortValue: (r) => customerById.get(r.customer_id)?.name ?? r.customer_id,
      render: (r) => customerById.get(r.customer_id)?.name ?? r.customer_id,
    },
    { key: 'total', header: 'Total', className: 'text-right', sortValue: (r) => r.total_paise, render: (r) => <Money paise={r.total_paise} /> },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'deleted', header: 'Deleted', sortValue: (r) => r.deleted_at ?? '', render: (r) => r.deleted_at?.slice(0, 10) ?? '' },
    { key: 'reason', header: 'Reason', sortValue: (r) => r.deleted_reason ?? '', render: (r) => r.deleted_reason ?? '' },
    {
      key: 'actions',
      header: 'Actions',
      className: 'text-right',
      sortable: false,
      render: (r) => (
        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={() => restore(r)} disabled={busyId === r.id} className="action-restore text-xs disabled:opacity-50">
            {busyId === r.id ? 'Working...' : 'Restore'}
          </button>
          <button type="button" onClick={() => permanentlyDelete(r)} disabled={busyId === r.id} className="action-delete text-xs disabled:opacity-50">
            Delete permanently
          </button>
        </div>
      ),
    },
  ];

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
        <div className="flex items-center gap-3">
          <Link to="/invoices" className="text-sm text-blue-700 hover:underline">
            ← Invoices
          </Link>
          <h1 className="text-xl font-semibold">Recycle Bin</h1>
        </div>
        <span className="text-sm text-slate-500">
          {rows.length} deleted invoice{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && (
        <div role="alert" className="text-sm text-rose-600">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[rows, customerById, busyId]}
        rowKey={(row) => row.id}
        searchPlaceholder="Search deleted invoices..."
        emptyMessage="No deleted invoices. Items deleted from the Invoices list appear here and can be restored."
      />
    </div>
  );
}
