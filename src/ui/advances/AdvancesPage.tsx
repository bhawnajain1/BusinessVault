import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { db } from '../../db';
import type {
  Account,
  Advance,
  Customer,
  Invoice,
  PartyType,
  PaymentMethod,
  Purchase,
  Supplier,
} from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { AdvanceService } from '../../domain/AdvanceService';
import { isActivePurchase } from '../../domain/partyLedger';

const METHODS: PaymentMethod[] = ['cash', 'card', 'upi', 'bank', 'cheque'];

export default function AdvancesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isNewRoute = location.pathname === '/advances/new';
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [directionFilter, setDirectionFilter] = useState<PartyType | ''>('');
  const [reloadKey, setReloadKey] = useState(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [partyById, setPartyById] = useState<Map<string, { name: string; type: PartyType }>>(
    new Map(),
  );
  const [cashBankAccounts, setCashBankAccounts] = useState<Account[]>([]);

  // Record-drawer state
  const [recordOpen, setRecordOpen] = useState(isNewRoute);
  const [advNumber, setAdvNumber] = useState('');
  const [advDate, setAdvDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [partyType, setPartyType] = useState<PartyType>('customer');
  const [partyId, setPartyId] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [cashOrBankAccountId, setCashOrBankAccountId] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [reference, setReference] = useState('');
  const [advNotes, setAdvNotes] = useState('');
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordSaving, setRecordSaving] = useState(false);

  // Apply-modal state
  const [applyTarget, setApplyTarget] = useState<Advance | null>(null);
  const [applyRows, setApplyRows] = useState<
    Array<{ id: string; number: string; balance_paise: number; amountStr: string }>
  >([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySaving, setApplySaving] = useState(false);

  const svc = useMemo(() => new AdvanceService(db), []);

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const [cs, ss, accs] = await Promise.all([
        db.customers.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.accounts.where('business_id').equals(businessId).toArray(),
      ]);
      setCustomers(cs);
      setSuppliers(ss);
      const map = new Map<string, { name: string; type: PartyType }>();
      cs.forEach((c) => map.set(c.id, { name: c.name, type: 'customer' }));
      ss.forEach((s) => map.set(s.id, { name: s.name, type: 'supplier' }));
      setPartyById(map);
      setCashBankAccounts(
        accs.filter(
          (a) => a.active === 1 && (a.code === '1010' || a.code === '1020'),
        ),
      );
    })();
  }, [businessId]);

  const partyOptions: Array<{ id: string; name: string }> = useMemo(() => {
    if (partyType === 'customer') return customers.map((c) => ({ id: c.id, name: c.name }));
    return suppliers.map((s) => ({ id: s.id, name: s.name }));
  }, [partyType, customers, suppliers]);

  function openRecordDrawer() {
    navigate('/advances/new');
    setRecordError(null);
    setAdvNumber('');
    setAdvDate(new Date().toISOString().slice(0, 10));
    setPartyType('customer');
    setPartyId('');
    setMethod('cash');
    const cash = cashBankAccounts.find((a) => a.code === '1010');
    setCashOrBankAccountId(cash?.id ?? cashBankAccounts[0]?.id ?? '');
    setAmountStr('');
    setReference('');
    setAdvNotes('');
  }

  async function saveNewAdvance() {
    if (!businessId || !deviceId) return;
    setRecordError(null);
    const num = advNumber.trim();
    if (!num) return setRecordError('Advance # is required.');
    if (!partyId) return setRecordError('Pick a party.');
    if (!cashOrBankAccountId) return setRecordError('Pick a cash/bank account.');
    const amountPaise = Math.round(Number(amountStr) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0)
      return setRecordError('Amount must be positive.');
    setRecordSaving(true);
    try {
      await svc.recordAdvance({
        business_id: businessId,
        device_id: deviceId,
        advance_number: num,
        advance_date: advDate,
        party_type: partyType,
        party_id: partyId,
        method,
        cash_or_bank_account_id: cashOrBankAccountId,
        amount_paise: amountPaise,
        reference: reference.trim() || undefined,
        notes: advNotes.trim() || undefined,
      });
      if (isNewRoute) navigate('/advances');
      else setRecordOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setRecordError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecordSaving(false);
    }
  }

  async function openApply(adv: Advance) {
    if (!businessId) return;
    setApplyTarget(adv);
    setApplyError(null);
    if (adv.party_type === 'customer') {
      const invs = await db.invoices
        .where('[business_id+customer_id]')
        .equals([businessId, adv.party_id])
        .toArray();
      setApplyRows(
        invs
          .filter((i) => i.balance_paise > 0 && i.status !== 'cancelled')
          .sort((a, b) => (a.invoice_date < b.invoice_date ? -1 : 1))
          .map((i: Invoice) => ({
            id: i.id,
            number: i.invoice_number,
            balance_paise: i.balance_paise,
            amountStr: '',
          })),
      );
    } else {
      const bills = await db.purchases
        .where('[business_id+supplier_id]')
        .equals([businessId, adv.party_id])
        .toArray();
      setApplyRows(
        bills
          .filter((b) => b.balance_paise > 0 && isActivePurchase(b))
          .sort((a, b) => (a.bill_date < b.bill_date ? -1 : 1))
          .map((b: Purchase) => ({
            id: b.id,
            number: b.bill_number,
            balance_paise: b.balance_paise,
            amountStr: '',
          })),
      );
    }
  }

  async function saveApplies() {
    if (!applyTarget || !businessId || !deviceId) return;
    setApplyError(null);
    const entries = applyRows
      .map((r) => ({ ...r, paise: Math.round(Number(r.amountStr) * 100) }))
      .filter((r) => Number.isFinite(r.paise) && r.paise > 0);
    if (entries.length === 0) return setApplyError('Enter at least one apply amount.');
    const total = entries.reduce((a, r) => a + r.paise, 0);
    if (total > applyTarget.remaining_paise) {
      return setApplyError(
        `Total apply ${(total / 100).toFixed(2)} exceeds remaining ${(applyTarget.remaining_paise / 100).toFixed(2)}.`,
      );
    }
    for (const r of entries) {
      if (r.paise > r.balance_paise) {
        return setApplyError(`Apply for ${r.number} exceeds its balance.`);
      }
    }
    setApplySaving(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      for (const r of entries) {
        await svc.applyAdvance({
          business_id: businessId,
          device_id: deviceId,
          advance_id: applyTarget.id,
          invoice_id: applyTarget.party_type === 'customer' ? r.id : undefined,
          bill_id: applyTarget.party_type === 'supplier' ? r.id : undefined,
          amount_paise: r.paise,
          applied_on: today,
        });
      }
      setApplyTarget(null);
      setApplyRows([]);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplySaving(false);
    }
  }

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
        let c = db.advances.where('business_id').equals(businessId).reverse();
        c = c.filter((a) => {
          if (directionFilter && a.party_type !== directionFilter) return false;
          const partyName = partyById.get(a.party_id)?.name;
          if (
            search &&
            !(
              matchesText(a.advance_number, search) ||
              matchesText(a.reference, search) ||
              matchesText(a.notes, search) ||
              matchesText(partyName, search)
            )
          )
            return false;
          if (
            filters.advance_number &&
            !matchesText(a.advance_number, filters.advance_number)
          )
            return false;
          if (filters.party && !matchesText(partyName, filters.party)) return false;
          if (filters.method && !matchesText(a.method, filters.method)) return false;
          return true;
        });
        return c;
      };
      return paginateCollection<Advance>(makeCol, offset, limit);
    },
    [businessId, directionFilter, partyById],
  );

  const columns: ColumnDef<Advance>[] = [
    {
      key: 'advance_number',
      header: 'Advance #',
      filterable: true,
      render: (r) => r.advance_number,
    },
    { key: 'advance_date', header: 'Date', render: (r) => r.advance_date },
    {
      key: 'direction',
      header: 'Type',
      render: (r) => (r.party_type === 'customer' ? 'Customer' : 'Supplier'),
    },
    {
      key: 'party',
      header: 'Party',
      filterable: true,
      render: (r) => partyById.get(r.party_id)?.name ?? r.party_id,
    },
    { key: 'method', header: 'Method', filterable: true, render: (r) => r.method },
    {
      key: 'amount',
      header: 'Amount',
      className: 'text-right',
      render: (r) => <Money paise={r.amount_paise} />,
    },
    {
      key: 'remaining',
      header: 'Remaining',
      className: 'text-right',
      render: (r) => <Money paise={r.remaining_paise} />,
    },
    {
      key: 'apps',
      header: 'Applied',
      render: (r) => `${r.applications.length} time(s)`,
    },
    {
      key: 'action',
      header: '',
      render: (r) =>
        r.remaining_paise > 0 ? (
          <button
            type="button"
            onClick={() => openApply(r)}
            className="h-7 rounded-md bg-accent px-2 text-[12px] font-medium text-accent-fg hover:opacity-90"
          >
            Apply
          </button>
        ) : (
          <span className="text-xs text-fg-subtle">exhausted</span>
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
      filename: 'advances.csv',
      columns: [
        { header: 'Advance #', get: (r: Advance) => r.advance_number },
        { header: 'Date', get: (r: Advance) => r.advance_date },
        { header: 'Type', get: (r: Advance) => r.party_type },
        {
          header: 'Party',
          get: (r: Advance) => partyById.get(r.party_id)?.name ?? r.party_id,
        },
        { header: 'Method', get: (r: Advance) => r.method },
        { header: 'Reference', get: (r: Advance) => r.reference },
        { header: 'Amount', get: (r: Advance) => (r.amount_paise / 100).toFixed(2) },
        { header: 'Remaining', get: (r: Advance) => (r.remaining_paise / 100).toFixed(2) },
        {
          header: 'Applied to',
          get: (r: Advance) =>
            r.applications
              .map(
                (a) =>
                  `${a.invoice_id ?? a.bill_id}:${(a.amount_paise / 100).toFixed(2)}`,
              )
              .join(';'),
        },
      ],
      rows: iterate(),
    });
  }

  if (loading) return <div className="p-6 text-fg-muted">Loading...</div>;
  if (!businessId) {
    return (
      <div className="p-6 text-fg-muted">
        No active business — complete onboarding first.
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg">Advances</h1>
        <button
          type="button"
          onClick={openRecordDrawer}
          className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          disabled={cashBankAccounts.length === 0}
          title={
            cashBankAccounts.length === 0
              ? 'No Cash/Bank accounts found. Repair chart of accounts in Settings.'
              : ''
          }
        >
          Record advance
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value as PartyType | '')}
          className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All types</option>
          <option value="customer">Customer advances</option>
          <option value="supplier">Supplier advances</option>
        </select>
      </div>

      <DataTable<Advance>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[directionFilter, reloadKey]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search advance # / party / reference / notes"
        onExport={exportCsv}
      />

      {(recordOpen || isNewRoute) && (
        <div
          className={isNewRoute ? 'fixed inset-0 z-40 overflow-y-auto bg-slate-50/95 p-5 sm:p-8' : 'fixed inset-0 z-40 flex items-start justify-end bg-black/40'}
          onClick={() => (isNewRoute ? navigate('/advances') : setRecordOpen(false))}
        >
          <div
            className={isNewRoute ? 'mx-auto w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm' : 'h-full w-full max-w-md border-l border-border bg-surface shadow-xl'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7">
              <div>
                {isNewRoute && <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Accounting entry</p>}
                <h2 className={isNewRoute ? 'mt-1 text-3xl font-semibold tracking-tight text-slate-950' : 'text-base font-semibold text-fg'}>Record advance</h2>
              </div>
              {!isNewRoute && (
                <button
                  type="button"
                  onClick={() => setRecordOpen(false)}
                  className="action-cancel text-sm font-semibold"
                >
                  Close
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3 text-sm">
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Advance #</span>
                <input
                  value={advNumber}
                  onChange={(e) => setAdvNumber(e.target.value)}
                  placeholder="e.g. ADV-2026-001"
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Date</span>
                <input
                  type="date"
                  value={advDate}
                  onChange={(e) => setAdvDate(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Type</span>
                <select
                  value={partyType}
                  onChange={(e) => {
                    setPartyType(e.target.value as PartyType);
                    setPartyId('');
                  }}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="customer">Customer advance (money received)</option>
                  <option value="supplier">Supplier advance (money paid)</option>
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">
                  {partyType === 'customer' ? 'Customer' : 'Supplier'}
                </span>
                <select
                  value={partyId}
                  onChange={(e) => setPartyId(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— select —</option>
                  {partyOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Method</span>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Cash / Bank account</span>
                <select
                  value={cashOrBankAccountId}
                  onChange={(e) => setCashOrBankAccountId(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— select —</option>
                  {cashBankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Amount (₹)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Reference (optional)</span>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Notes (optional)</span>
                <textarea
                  value={advNotes}
                  onChange={(e) => setAdvNotes(e.target.value)}
                  rows={2}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              {recordError && <div className="text-sm text-danger">{recordError}</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:px-7">
              <button
                type="button"
                onClick={() => (isNewRoute ? navigate('/advances') : setRecordOpen(false))}
                className="action-cancel h-10 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveNewAdvance}
                disabled={
                  recordSaving ||
                  !advNumber.trim() ||
                  !partyId ||
                  !cashOrBankAccountId ||
                  !Number.isFinite(Number(amountStr)) ||
                  Number(amountStr) <= 0
                }
                className="h-10 rounded-xl bg-green-600 px-4 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {recordSaving ? 'Saving…' : 'Save Advance'}
              </button>
            </div>
          </div>
        </div>
      )}

      {applyTarget && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-start justify-end"
          onClick={() => setApplyTarget(null)}
        >
          <div
            className="h-full w-full max-w-lg bg-surface shadow-xl border-l border-border flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-base font-semibold text-fg">
                Apply advance {applyTarget.advance_number}
              </h2>
              <button
                type="button"
                onClick={() => setApplyTarget(null)}
                className="text-sm text-fg-muted hover:text-fg"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3 text-sm">
              <div className="text-fg-muted">
                Party: <strong>{partyById.get(applyTarget.party_id)?.name}</strong> · Remaining:{' '}
                <strong>
                  <Money paise={applyTarget.remaining_paise} />
                </strong>
              </div>
              {applyRows.length === 0 ? (
                <div className="text-fg-muted">
                  No open {applyTarget.party_type === 'customer' ? 'invoices' : 'bills'} to apply
                  against.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-app text-xs uppercase text-fg-muted">
                    <tr>
                      <th className="text-left px-2 py-1.5">
                        {applyTarget.party_type === 'customer' ? 'Invoice' : 'Bill'} #
                      </th>
                      <th className="text-right px-2 py-1.5">Balance</th>
                      <th className="text-right px-2 py-1.5">Apply (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applyRows.map((r, i) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-2 py-1.5">{r.number}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Money paise={r.balance_paise} />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={r.amountStr}
                            onChange={(e) =>
                              setApplyRows((rows) =>
                                rows.map((rr, j) =>
                                  j === i ? { ...rr, amountStr: e.target.value } : rr,
                                ),
                              )
                            }
                            className="w-28 h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {applyError && <div className="text-sm text-danger">{applyError}</div>}
            </div>
            <div className="border-t border-border px-4 py-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setApplyTarget(null)}
                className="h-8 rounded-md border border-border bg-surface px-3 text-[13px] text-fg-muted hover:text-fg hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveApplies}
                disabled={applySaving || applyRows.length === 0}
                className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
              >
                {applySaving ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
