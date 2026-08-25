import { useCallback, useEffect, useState } from 'react';
import { db } from '../../db';
import type { Customer, PartyType, Payment, PaymentDirection, Supplier } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { isPaymentActive } from '../../domain/paymentState';

export default function PaymentsPage() {
  const { businessId, loading } = useActiveBusiness();
  const [directionFilter, setDirectionFilter] = useState<PaymentDirection | ''>('');
  const [partyById, setPartyById] = useState<Map<string, { name: string; type: PartyType }>>(
    new Map(),
  );

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const [cs, ss] = await Promise.all([
        db.customers.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
      ]);
      const map = new Map<string, { name: string; type: PartyType }>();
      cs.forEach((c: Customer) => map.set(c.id, { name: c.name, type: 'customer' }));
      ss.forEach((s: Supplier) => map.set(s.id, { name: s.name, type: 'supplier' }));
      setPartyById(map);
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
        if (directionFilter) {
          c = db.payments
            .where('[business_id+direction]')
            .equals([businessId, directionFilter]);
        } else {
          c = db.payments.where('business_id').equals(businessId);
        }
        c = c.reverse();
        // Hide RECYCLED + SUPERSEDED from the main list — Recycle Bin has its
        // own view; SUPERSEDED (Edit prior revision) only appears in a payment's
        // per-row revision history.
        c = c.filter((p) => isPaymentActive(p));
        if (search || filters.payment_number || filters.party || filters.method) {
          c = c.filter((p) => {
            if (
              search &&
              !(
                matchesText(p.payment_number, search) ||
                matchesText(p.reference, search) ||
                matchesText(p.notes, search) ||
                matchesText(partyById.get(p.party_id)?.name, search)
              )
            ) {
              return false;
            }
            if (
              filters.payment_number &&
              !matchesText(p.payment_number, filters.payment_number)
            ) {
              return false;
            }
            if (
              filters.party &&
              !matchesText(partyById.get(p.party_id)?.name, filters.party)
            ) {
              return false;
            }
            if (filters.method && !matchesText(p.method, filters.method)) return false;
            return true;
          });
        }
        return c;
      };
      return paginateCollection<Payment>(makeCol, offset, limit);
    },
    [businessId, directionFilter, partyById],
  );

  const columns: ColumnDef<Payment>[] = [
    {
      key: 'payment_number',
      header: 'Payment #',
      filterable: true,
      render: (r) => r.payment_number,
    },
    { key: 'payment_date', header: 'Date', render: (r) => r.payment_date },
    {
      key: 'direction',
      header: 'Direction',
      render: (r) => (r.direction === 'in' ? 'Received' : 'Paid'),
    },
    {
      key: 'party',
      header: 'Party',
      filterable: true,
      render: (r) => partyById.get(r.party_id)?.name ?? r.party_id,
    },
    { key: 'method', header: 'Method', filterable: true, render: (r) => r.method },
    { key: 'reference', header: 'Reference', render: (r) => r.reference || '—' },
    {
      key: 'amount',
      header: 'Amount',
      className: 'text-right',
      render: (r) => <Money paise={r.amount_paise} />,
    },
    {
      key: 'allocated',
      header: 'Allocated',
      render: (r) => `${r.allocations.length} line(s)`,
    },
  ];

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
      filename: 'payments.csv',
      columns: [
        { header: 'Payment #', get: (r: Payment) => r.payment_number },
        { header: 'Date', get: (r: Payment) => r.payment_date },
        { header: 'Direction', get: (r: Payment) => r.direction },
        { header: 'Party Type', get: (r: Payment) => r.party_type },
        {
          header: 'Party',
          get: (r: Payment) => partyById.get(r.party_id)?.name ?? r.party_id,
        },
        { header: 'Method', get: (r: Payment) => r.method },
        { header: 'Reference', get: (r: Payment) => r.reference },
        { header: 'Amount', get: (r: Payment) => (r.amount_paise / 100).toFixed(2) },
        {
          header: 'Allocations',
          get: (r: Payment) =>
            r.allocations
              .map((a) => `${a.invoice_id ?? a.bill_id}:${(a.amount_paise / 100).toFixed(2)}`)
              .join(';'),
        },
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
        <h1 className="text-xl font-semibold">Payments</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value as PaymentDirection | '')}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All directions</option>
          <option value="in">Received</option>
          <option value="out">Paid</option>
        </select>
      </div>

      <DataTable<Payment>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[directionFilter]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search payment # / party / reference / notes"
        onExport={exportCsv}
      />
    </div>
  );
}
