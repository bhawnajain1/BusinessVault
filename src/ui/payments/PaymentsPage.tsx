import { useCallback, useEffect, useMemo, useState } from 'react';
import { ulid } from 'ulid';
import { db } from '../../db';
import type {
  Account,
  Customer,
  PartyType,
  Payment,
  PaymentDirection,
  PaymentMethod,
  Purchase,
  Supplier,
  Invoice,
} from '../../db/types';
import { PaymentService } from '../../domain/PaymentService';
import { isActivePurchase } from '../../domain/partyLedger';
import { SYSTEM_ACCOUNT_CODES } from '../../domain/coa';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { INDIAN_BANKS } from './indianBanks';

const METHODS: PaymentMethod[] = ['cash', 'bank', 'upi', 'card', 'cheque'];

type OpenDocument = {
  id: string;
  number: string;
  balancePaise: number;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function PaymentsPage() {
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [directionFilter, setDirectionFilter] = useState<PaymentDirection | ''>('');
  const [partyById, setPartyById] = useState<Map<string, { name: string; type: PartyType }>>(
    new Map(),
  );
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [entryDirection, setEntryDirection] = useState<PaymentDirection | null>(null);
  const [entryPartyId, setEntryPartyId] = useState('');
  const [entryDocumentId, setEntryDocumentId] = useState('');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryDate, setEntryDate] = useState(today);
  const [entryMethod, setEntryMethod] = useState<PaymentMethod>('cash');
  const [entryBank, setEntryBank] = useState('');
  const [entryOtherBankName, setEntryOtherBankName] = useState('');
  const [entryAccountId, setEntryAccountId] = useState('');
  const [entryReference, setEntryReference] = useState('');
  const [entryNotes, setEntryNotes] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

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
      const [as, invs, bills] = await Promise.all([
        db.accounts.where('business_id').equals(businessId).toArray(),
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.purchases.where('business_id').equals(businessId).toArray(),
      ]);
      setPartyById(map);
      setCustomers(cs);
      setSuppliers(ss);
      setAccounts(as);
      setInvoices(invs);
      setPurchases(bills);
    })();
  }, [businessId]);

  const entryParties = entryDirection === 'in' ? customers : suppliers;
  const openDocuments = useMemo<OpenDocument[]>(() => {
    if (!entryDirection) return [];
    if (entryDirection === 'in') {
      return invoices
        .filter((i) => i.customer_id === entryPartyId && i.balance_paise > 0 && i.status !== 'cancelled')
        .map((i) => ({ id: i.id, number: i.invoice_number, balancePaise: i.balance_paise }));
    }
    return purchases
      .filter((p) => p.supplier_id === entryPartyId && p.balance_paise > 0 && isActivePurchase(p))
      .map((p) => ({ id: p.id, number: p.bill_number, balancePaise: p.balance_paise }));
  }, [entryDirection, entryPartyId, invoices, purchases]);

  const entryAccountOptions = accounts.filter(
    (a) => a.active === 1 && (a.code === SYSTEM_ACCOUNT_CODES.CASH || a.code === SYSTEM_ACCOUNT_CODES.BANK),
  );

  function openEntry(direction: PaymentDirection): void {
    setEntryDirection(direction);
    setEntryPartyId('');
    setEntryDocumentId('');
    setEntryAmount('');
    setEntryDate(today());
    setEntryMethod('cash');
    setEntryBank('');
    setEntryOtherBankName('');
    setEntryAccountId(entryAccountOptions.find((a) => a.code === SYSTEM_ACCOUNT_CODES.CASH)?.id ?? '');
    setEntryReference('');
    setEntryNotes('');
    setEntryError(null);
  }

  async function saveEntry(): Promise<void> {
    if (!businessId || !deviceId || !entryDirection) return;
    const amountPaise = Math.round(Number(entryAmount) * 100);
    const document = openDocuments.find((d) => d.id === entryDocumentId);
    const account = accounts.find((a) => a.id === entryAccountId);
    const arOrApAccount = accounts.find(
      (a) => a.code === (entryDirection === 'in' ? SYSTEM_ACCOUNT_CODES.RECEIVABLE : SYSTEM_ACCOUNT_CODES.PAYABLE),
    );
    if (!entryPartyId) return setEntryError('Select a party.');
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) return setEntryError('Amount must be positive.');
    if (document && amountPaise > document.balancePaise) {
      return setEntryError(
        `Amount cannot exceed the selected document balance of ₹${(document.balancePaise / 100).toFixed(2)}.`,
      );
    }
    if (!account) return setEntryError('Select a cash or bank account.');
    const bankName = entryBank === 'Other' ? entryOtherBankName.trim() : entryBank;
    if (entryMethod === 'bank' && !bankName) {
      return setEntryError('Select a bank or enter the bank name.');
    }
    if (!arOrApAccount) {
      return setEntryError(
        `${entryDirection === 'in' ? 'Accounts Receivable' : 'Accounts Payable'} account is missing. Repair the chart of accounts in Settings.`,
      );
    }

    setEntrySaving(true);
    setEntryError(null);
    try {
      let remainingPaise = amountPaise;
      const allocations = document
        ? [
            entryDirection === 'in'
              ? { invoice_id: document.id, amount_paise: amountPaise }
              : { bill_id: document.id, amount_paise: amountPaise },
          ]
        : [{ as_advance: true, amount_paise: remainingPaise }];

      await new PaymentService(db).createPayment({
        business_id: businessId,
        device_id: deviceId,
        payment_number: `${entryDirection === 'in' ? 'PAY-IN' : 'PAY-OUT'}-${ulid().slice(-10)}`,
        payment_date: entryDate,
        direction: entryDirection,
        party_type: entryDirection === 'in' ? 'customer' : 'supplier',
        party_id: entryPartyId,
        method: entryMethod,
        bank_name: entryMethod === 'bank' ? bankName : undefined,
        cash_or_bank_account_id: account.id,
        ar_or_ap_account_id: arOrApAccount.id,
        amount_paise: amountPaise,
        reference: entryReference.trim() || undefined,
        notes: entryNotes.trim() || undefined,
        allocations,
        advance_number: document ? undefined : `ADV-${ulid().slice(-10)}`,
      });
      setEntryDirection(null);
      setReloadKey((value) => value + 1);
      const [invs, bills] = await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.purchases.where('business_id').equals(businessId).toArray(),
      ]);
      setInvoices(invs);
      setPurchases(bills);
    } catch (error) {
      setEntryError(error instanceof Error ? error.message : String(error));
    } finally {
      setEntrySaving(false);
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
        let c;
        if (directionFilter) {
          c = db.payments
            .where('[business_id+direction]')
            .equals([businessId, directionFilter]);
        } else {
          c = db.payments.where('business_id').equals(businessId);
        }
        c = c.reverse();
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
    { key: 'method', header: 'Method', filterable: true, render: (r) => r.bank_name ? `bank — ${r.bank_name}` : r.method },
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
        { header: 'Method', get: (r: Payment) => r.bank_name ? `bank — ${r.bank_name}` : r.method },
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
          <button type="button" onClick={() => openEntry('in')} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">
            Payment In
          </button>
          <button type="button" onClick={() => openEntry('out')} className="payment-out-button rounded px-3 py-2 text-sm font-medium text-white shadow-sm">
            Payment Out
          </button>
        </div>
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
        fetchPageDeps={[directionFilter, reloadKey]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search payment # / party / reference / notes"
        onExport={exportCsv}
      />

      {entryDirection && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
          <div className="w-full max-w-xl rounded bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-semibold">{entryDirection === 'in' ? 'Payment In' : 'Payment Out'}</h2>
              <button type="button" onClick={() => setEntryDirection(null)} aria-label="Close" className="text-slate-500 hover:text-slate-900">✕</button>
            </div>
            <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>Party</span>
                <select value={entryPartyId} onChange={(e) => { setEntryPartyId(e.target.value); setEntryDocumentId(''); }} className="rounded border px-2 py-1.5">
                  <option value="">Select {entryDirection === 'in' ? 'customer' : 'supplier'}</option>
                  {entryParties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span>{entryDirection === 'in' ? 'Invoice' : 'Bill'}</span>
                <select value={entryDocumentId} onChange={(e) => setEntryDocumentId(e.target.value)} className="rounded border px-2 py-1.5" disabled={!entryPartyId}>
                  <option value="">Select open {entryDirection === 'in' ? 'invoice' : 'bill'}</option>
                  {openDocuments.map((document) => <option key={document.id} value={document.id}>{document.number} — ₹{(document.balancePaise / 100).toFixed(2)} due</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1"><span>Amount ₹</span><input type="number" min="0.01" step="0.01" value={entryAmount} onChange={(e) => setEntryAmount(e.target.value)} className="rounded border px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1"><span>Date</span><input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="rounded border px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1"><span>Payment method</span><select value={entryMethod} onChange={(e) => { setEntryMethod(e.target.value as PaymentMethod); setEntryBank(''); setEntryOtherBankName(''); }} className="rounded border px-2 py-1.5">{METHODS.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
              {entryMethod === 'bank' && <label className="flex flex-col gap-1"><span>Bank</span><select value={entryBank} onChange={(e) => { setEntryBank(e.target.value); setEntryOtherBankName(''); }} className="rounded border px-2 py-1.5"><option value="">Select bank</option>{INDIAN_BANKS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}</select></label>}
              {entryMethod === 'bank' && entryBank === 'Other' && <label className="flex flex-col gap-1"><span>Other bank name</span><input value={entryOtherBankName} onChange={(e) => setEntryOtherBankName(e.target.value)} placeholder="Enter bank name" className="rounded border px-2 py-1.5" /></label>}
              <label className="flex flex-col gap-1"><span>Cash / bank account</span><select value={entryAccountId} onChange={(e) => setEntryAccountId(e.target.value)} className="rounded border px-2 py-1.5"><option value="">Select account</option>{entryAccountOptions.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span>Reference</span><input value={entryReference} onChange={(e) => setEntryReference(e.target.value)} className="rounded border px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span>Notes</span><textarea value={entryNotes} onChange={(e) => setEntryNotes(e.target.value)} className="rounded border px-2 py-1.5" rows={2} /></label>
              {entryError && <p className="sm:col-span-2 text-rose-600">{entryError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-3">
              <button type="button" onClick={() => setEntryDirection(null)} className="action-cancel text-sm">Cancel</button>
              <button type="button" onClick={() => void saveEntry()} disabled={entrySaving} className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{entrySaving ? 'Saving...' : 'Save payment'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
