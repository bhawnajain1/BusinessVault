import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { db } from '../../db';
import type { Account, Expense, Supplier } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { ExpenseService } from '../../domain/ExpenseService';

export default function ExpensesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isNewRoute = location.pathname === '/expenses/new';
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [categoryAccounts, setCategoryAccounts] = useState<Account[]>([]);
  const [paymentAccounts, setPaymentAccounts] = useState<Account[]>([]);
  const [accountById, setAccountById] = useState<Map<string, Account>>(new Map());
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierById, setSupplierById] = useState<Map<string, Supplier>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);

  // New-expense drawer state
  const [drawerOpen, setDrawerOpen] = useState(isNewRoute);
  const [expenseNumber, setExpenseNumber] = useState('');
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryAccountId, setCategoryAccountId] = useState<string>('');
  const [paymentAccountId, setPaymentAccountId] = useState<string>('');
  const [supplierId, setSupplierId] = useState<string>('');
  const [description, setDescription] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [taxStr, setTaxStr] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const svc = useMemo(() => new ExpenseService({ db }), []);

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const [expenseAccs, allAccs, sups] = await Promise.all([
        db.accounts
          .where('[business_id+type]')
          .equals([businessId, 'expense'])
          .toArray(),
        db.accounts.where('business_id').equals(businessId).toArray(),
        db.suppliers.where('business_id').equals(businessId).toArray(),
      ]);
      setCategoryAccounts(expenseAccs.filter((a) => a.active === 1));
      // Payment accounts: active current-asset (Cash/Bank etc.)
      setPaymentAccounts(
        allAccs.filter(
          (a) =>
            a.type === 'asset' &&
            a.active === 1 &&
            (a.subtype === 'current_asset' || a.code === '1010' || a.code === '1020'),
        ),
      );
      setAccountById(new Map(allAccs.map((a) => [a.id, a])));
      setSuppliers(sups);
      setSupplierById(new Map(sups.map((s) => [s.id, s])));
    })();
  }, [businessId, reloadKey]);

  function openDrawer() {
    navigate('/expenses/new');
    setSaveError(null);
    setExpenseNumber('');
    setExpenseDate(new Date().toISOString().slice(0, 10));
    setDescription('');
    setAmountStr('');
    setTaxStr('');
    setSupplierId('');
    // Sensible defaults: first expense category, first payment account (usually Cash).
    setCategoryAccountId((prev) => prev || categoryAccounts[0]?.id || '');
    const cash = paymentAccounts.find((a) => a.code === '1010');
    setPaymentAccountId((prev) => prev || cash?.id || paymentAccounts[0]?.id || '');
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  async function saveNew() {
    if (!businessId || !deviceId) return;
    setSaveError(null);
    const num = expenseNumber.trim();
    if (!num) {
      setSaveError('Expense number is required.');
      return;
    }
    if (!categoryAccountId) {
      setSaveError('Pick an expense category.');
      return;
    }
    if (!paymentAccountId) {
      setSaveError('Pick a payment account (Cash / Bank).');
      return;
    }
    const amountPaise = Math.round(Number(amountStr) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      setSaveError('Amount must be a positive number.');
      return;
    }
    const taxPaise = taxStr.trim() === '' ? 0 : Math.round(Number(taxStr) * 100);
    if (!Number.isFinite(taxPaise) || taxPaise < 0) {
      setSaveError('Tax must be non-negative.');
      return;
    }
    setSaving(true);
    try {
      await svc.create({
        businessId,
        deviceId,
        expenseNumber: num,
        expenseDate,
        categoryAccountId,
        paymentAccountId,
        supplierId: supplierId || null,
        description: description.trim(),
        amountPaise,
        taxPaise,
      });
      if (isNewRoute) navigate('/expenses');
      else setDrawerOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
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
        if (categoryFilter) {
          c = db.expenses
            .where('[business_id+category_account_id]')
            .equals([businessId, categoryFilter]);
        } else {
          c = db.expenses.where('business_id').equals(businessId);
        }
        c = c.reverse();
        if (search || filters.description || filters.expense_number) {
          c = c.filter((e) => {
            if (
              search &&
              !(
                matchesText(e.description, search) ||
                matchesText(e.expense_number, search) ||
                matchesText(accountById.get(e.category_account_id)?.name, search) ||
                matchesText(e.supplier_id ? supplierById.get(e.supplier_id)?.name : '', search)
              )
            ) {
              return false;
            }
            if (
              filters.expense_number &&
              !matchesText(e.expense_number, filters.expense_number)
            ) {
              return false;
            }
            if (filters.description && !matchesText(e.description, filters.description)) return false;
            return true;
          });
        }
        return c;
      };
      return paginateCollection<Expense>(makeCol, offset, limit);
    },
    [businessId, categoryFilter, accountById, supplierById, reloadKey],
  );

  const columns: ColumnDef<Expense>[] = [
    {
      key: 'expense_number',
      header: 'Expense #',
      filterable: true,
      render: (r) => r.expense_number,
    },
    { key: 'expense_date', header: 'Date', render: (r) => r.expense_date },
    {
      key: 'category',
      header: 'Category',
      render: (r) => accountById.get(r.category_account_id)?.name ?? r.category_account_id,
    },
    {
      key: 'supplier',
      header: 'Supplier',
      render: (r) => (r.supplier_id ? supplierById.get(r.supplier_id)?.name ?? r.supplier_id : '—'),
    },
    { key: 'description', header: 'Description', filterable: true, render: (r) => r.description },
    {
      key: 'amount',
      header: 'Amount',
      className: 'text-right',
      render: (r) => <Money paise={r.amount_paise} />,
    },
    {
      key: 'tax',
      header: 'Tax',
      className: 'text-right',
      render: (r) => <Money paise={r.tax_paise} />,
    },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      render: (r) => <Money paise={r.total_paise} />,
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
      filename: 'expenses.csv',
      columns: [
        { header: 'Expense #', get: (r: Expense) => r.expense_number },
        { header: 'Date', get: (r: Expense) => r.expense_date },
        {
          header: 'Category',
          get: (r: Expense) =>
            accountById.get(r.category_account_id)?.name ?? r.category_account_id,
        },
        {
          header: 'Supplier',
          get: (r: Expense) =>
            r.supplier_id ? supplierById.get(r.supplier_id)?.name ?? r.supplier_id : '',
        },
        { header: 'Description', get: (r: Expense) => r.description },
        { header: 'Amount', get: (r: Expense) => (r.amount_paise / 100).toFixed(2) },
        { header: 'Tax', get: (r: Expense) => (r.tax_paise / 100).toFixed(2) },
        { header: 'Total', get: (r: Expense) => (r.total_paise / 100).toFixed(2) },
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
        <h1 className="text-xl font-semibold text-fg">Expenses</h1>
        <button
          type="button"
          onClick={openDrawer}
          className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          disabled={categoryAccounts.length === 0 || paymentAccounts.length === 0}
          title={
            categoryAccounts.length === 0
              ? 'No expense accounts found. Repair the chart of accounts from Settings first.'
              : ''
          }
        >
          New Expense
        </button>
      </div>

      {categoryAccounts.length === 0 && (
        <div className="border border-amber-300 bg-amber-50 text-amber-900 text-sm rounded px-3 py-2">
          No expense accounts found. Go to <strong>Settings → Repair chart of accounts</strong> to seed
          the standard expense categories (Rent, Salaries, Utilities, etc.), then come back here.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All categories</option>
          {categoryAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <DataTable<Expense>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[categoryFilter, reloadKey]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search expense # / description / category"
        onExport={exportCsv}
      />

      {(drawerOpen || isNewRoute) && (
        <div
          className={isNewRoute ? 'fixed inset-0 z-40 overflow-y-auto bg-slate-50/95 p-5 sm:p-8' : 'fixed inset-0 z-40 flex items-start justify-end bg-black/40'}
          onClick={isNewRoute ? () => navigate('/expenses') : closeDrawer}
          data-full-page={isNewRoute ? 'true' : undefined}
        >
          <div
            className={isNewRoute ? 'mx-auto w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm' : 'h-full w-full max-w-md border-l border-border bg-surface shadow-xl'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7">
              <div>
                {isNewRoute && <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Accounting entry</p>}
                <h2 className={isNewRoute ? 'mt-1 text-3xl font-semibold tracking-tight text-slate-950' : 'text-base font-semibold text-fg'}>New Expense</h2>
              </div>
              {!isNewRoute && (
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="action-cancel text-sm font-semibold"
                >
                  Close
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3 text-sm">
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Expense #</span>
                <input
                  value={expenseNumber}
                  onChange={(e) => setExpenseNumber(e.target.value)}
                  placeholder="e.g. EXP-2026-001"
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Date</span>
                <input
                  type="date"
                  value={expenseDate}
                  onChange={(e) => setExpenseDate(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Category (expense account)</span>
                <select
                  value={categoryAccountId}
                  onChange={(e) => setCategoryAccountId(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— select —</option>
                  {categoryAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Paid from (asset account)</span>
                <select
                  value={paymentAccountId}
                  onChange={(e) => setPaymentAccountId(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— select —</option>
                  {paymentAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Supplier (optional)</span>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— none —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="block text-[12px] text-fg-muted mb-1">Description</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col">
                  <span className="block text-[12px] text-fg-muted mb-1">Amount (₹)</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring text-right"
                  />
                </label>
                <label className="flex flex-col">
                  <span className="block text-[12px] text-fg-muted mb-1">Tax (₹, optional)</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={taxStr}
                    onChange={(e) => setTaxStr(e.target.value)}
                    className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring text-right"
                  />
                </label>
              </div>
              {saveError && <div className="text-sm text-danger">{saveError}</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:px-7">
              <button
                type="button"
                onClick={isNewRoute ? () => navigate('/expenses') : closeDrawer}
                className="action-cancel h-10 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveNew}
                disabled={
                  saving ||
                  !expenseNumber.trim() ||
                  !categoryAccountId ||
                  !paymentAccountId ||
                  !Number.isFinite(Number(amountStr)) ||
                  Number(amountStr) <= 0
                }
                className="h-10 rounded-xl bg-green-600 px-4 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Expense'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
