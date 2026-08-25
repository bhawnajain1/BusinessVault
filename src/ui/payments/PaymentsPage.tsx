import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, PartyType, Payment, PaymentDirection, Supplier } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { isPaymentActive } from '../../domain/paymentState';
import { PaymentService } from '../../domain/PaymentService';
import ReceivePaymentModal from './ReceivePaymentModal';
import MakePaymentModal from './MakePaymentModal';
import EditPaymentModal from './EditPaymentModal';
import ViewPaymentModal from './ViewPaymentModal';

type Tab = 'all' | 'in' | 'out';

export default function PaymentsPage() {
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [tab, setTab] = useState<Tab>('all');
  const [partyById, setPartyById] = useState<Map<string, { name: string; type: PartyType }>>(
    new Map(),
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  // Modal state — only one open at a time.
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [makeOpen, setMakeOpen] = useState(false);
  const [editPayment, setEditPayment] = useState<Payment | null>(null);
  const [viewPayment, setViewPayment] = useState<Payment | null>(null);

  const svc = useMemo(() => new PaymentService(), []);

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
  }, [businessId, reloadKey]);

  const directionFilter: PaymentDirection | '' =
    tab === 'in' ? 'in' : tab === 'out' ? 'out' : '';

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

  async function onRecycle(p: Payment) {
    if (!businessId || !deviceId) return;
    const reason = window.prompt(
      `Move Payment ${p.payment_number} to Recycle Bin? It can be restored later. Enter an optional reason:`,
      '',
    );
    if (reason === null) return; // cancelled
    try {
      await svc.softDeletePayment({
        business_id: businessId,
        device_id: deviceId,
        payment_id: p.id,
        reason: reason.trim() || 'user recycle',
      });
      setFlash(`Payment ${p.payment_number} moved to Recycle Bin.`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`Could not move to Recycle Bin:\n${msg}`);
    }
  }

  const columns: ColumnDef<Payment>[] = [
    {
      key: 'payment_number',
      header: 'Payment #',
      filterable: true,
      render: (r) => (
        <span className="font-mono text-xs">{r.payment_number}</span>
      ),
    },
    { key: 'payment_date', header: 'Date', render: (r) => r.payment_date },
    {
      key: 'direction',
      header: 'Type',
      render: (r) => (
        <span
          className={
            r.direction === 'in'
              ? 'inline-block text-xs bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5'
              : 'inline-block text-xs bg-rose-100 text-rose-800 rounded px-1.5 py-0.5'
          }
        >
          {r.direction === 'in' ? 'In' : 'Out'}
        </span>
      ),
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
      render: (r) => {
        const allocated = r.allocations.reduce((s, a) => s + a.amount_paise, 0);
        const unalloc = Math.max(0, r.amount_paise - allocated);
        if (unalloc === 0) return 'Fully applied';
        if (allocated === 0) return 'Advance';
        return (
          <span>
            <Money paise={allocated} /> + <Money paise={unalloc} /> adv
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            className="text-slate-700 hover:underline"
            onClick={() => setViewPayment(r)}
          >
            View
          </button>
          <button
            type="button"
            className="text-blue-700 hover:underline"
            onClick={() => setEditPayment(r)}
          >
            Edit
          </button>
          <button
            type="button"
            className="text-rose-700 hover:underline"
            onClick={() => onRecycle(r)}
          >
            Recycle
          </button>
        </div>
      ),
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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setReceiveOpen(true)}
            className="text-sm bg-emerald-700 text-white rounded px-3 py-1.5 hover:bg-emerald-800"
          >
            + Payment In
          </button>
          <button
            type="button"
            onClick={() => setMakeOpen(true)}
            className="text-sm bg-rose-700 text-white rounded px-3 py-1.5 hover:bg-rose-800"
          >
            + Payment Out
          </button>
          <Link
            to="/payments/recycle-bin"
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Recycle Bin
          </Link>
        </div>
      </div>

      {flash && (
        <div className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded px-3 py-2 flex justify-between items-center">
          <span>{flash}</span>
          <button
            type="button"
            className="text-emerald-700 hover:underline text-xs"
            onClick={() => setFlash(null)}
          >
            dismiss
          </button>
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200 text-sm">
        {(
          [
            ['all', 'All Payments'],
            ['in', 'Payment In'],
            ['out', 'Payment Out'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              tab === t
                ? 'px-4 py-2 border-b-2 border-slate-900 font-medium'
                : 'px-4 py-2 text-slate-600 hover:text-slate-900'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <DataTable<Payment>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[tab, reloadKey]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search payment # / party / reference / notes"
        onExport={exportCsv}
      />

      {receiveOpen && (
        <ReceivePaymentModal
          businessId={businessId}
          deviceId={deviceId ?? ''}
          customerPickerAllowed
          onClose={() => setReceiveOpen(false)}
          onSaved={(p) => {
            setReceiveOpen(false);
            setFlash(
              `Payment In of ₹${(p.amount_paise / 100).toFixed(2)} recorded successfully.`,
            );
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {makeOpen && (
        <MakePaymentModal
          businessId={businessId}
          deviceId={deviceId ?? ''}
          supplierPickerAllowed
          onClose={() => setMakeOpen(false)}
          onSaved={() => {
            setMakeOpen(false);
            setFlash('Payment Out recorded successfully.');
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {viewPayment && (
        <ViewPaymentModal
          payment={viewPayment}
          partyName={partyById.get(viewPayment.party_id)?.name ?? viewPayment.party_id}
          onClose={() => setViewPayment(null)}
        />
      )}

      {editPayment && (
        <EditPaymentModal
          businessId={businessId}
          deviceId={deviceId ?? ''}
          payment={editPayment}
          onClose={() => setEditPayment(null)}
          onSaved={() => {
            setEditPayment(null);
            setFlash('Payment updated. A new revision was created and the previous one was superseded.');
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
