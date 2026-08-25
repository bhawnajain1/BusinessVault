import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Invoice, Payment, Advance } from '../../db/types';
import { createCustomerService } from '../../domain/CustomerService';
import { isPaymentActive, isAdvanceActive } from '../../domain/paymentState';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Drawer from '../components/Drawer';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { INDIAN_STATES, findStateByCode, stateFromGstin } from '../../lib/indianStates';

interface CustomerRollup {
  total_sales_paise: number;
  receivable_paise: number;
  overdue_paise: number;
  advance_paise: number;
  last_payment_ymd: string | null;
}
const EMPTY_ROLLUP: CustomerRollup = {
  total_sales_paise: 0,
  receivable_paise: 0,
  overdue_paise: 0,
  advance_paise: 0,
  last_payment_ymd: null,
};

interface CustomerForm {
  name: string;
  phone: string;
  email: string;
  gstin: string;
  billingAddress: string;
  shippingAddress: string;
  state: string;
  stateCode: string;
  openingBalanceRupees: string;
  creditLimitRupees: string;
  notes: string;
  active: boolean;
}

const EMPTY_FORM: CustomerForm = {
  name: '',
  phone: '',
  email: '',
  gstin: '',
  billingAddress: '',
  shippingAddress: '',
  state: '',
  stateCode: '',
  openingBalanceRupees: '0',
  creditLimitRupees: '0',
  notes: '',
  active: true,
};

function rupeesToPaise(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function paiseToRupees(p: number): string {
  return (p / 100).toFixed(2);
}

export default function CustomersPage() {
  const navigate = useNavigate();
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [rollups, setRollups] = useState<Map<string, CustomerRollup>>(new Map());
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!editId || !businessId) return;
    let cancelled = false;
    (async () => {
      const row = await db.customers.get(editId);
      if (cancelled || !row) return;
      openEdit(row);
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      setSearchParams(next, { replace: true });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, searchParams]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const [invs, pays, advs] = await Promise.all([
        db.invoices.where('business_id').equals(businessId).toArray(),
        db.payments
          .where('[business_id+direction]')
          .equals([businessId, 'in'])
          .filter(isPaymentActive)
          .toArray(),
        db.advances
          .where('business_id')
          .equals(businessId)
          .filter((a) => a.party_type === 'customer' && isAdvanceActive(a))
          .toArray(),
      ]);
      if (cancelled) return;

      // Split originals vs credit notes; index credit notes by original.
      const creditsByOriginal = new Map<string, Invoice[]>();
      for (const inv of invs) {
        if (inv.reverses_invoice_id) {
          const arr = creditsByOriginal.get(inv.reverses_invoice_id) ?? [];
          arr.push(inv);
          creditsByOriginal.set(inv.reverses_invoice_id, arr);
        }
      }

      // Payments indexed by (party_id, invoice_id).
      const paidByInvoice = new Map<string, number>();
      const lastPaymentByCustomer = new Map<string, string>();
      for (const p of pays) {
        if (p.party_type !== 'customer') continue;
        const prev = lastPaymentByCustomer.get(p.party_id);
        if (!prev || p.payment_date > prev) {
          lastPaymentByCustomer.set(p.party_id, p.payment_date);
        }
        for (const a of p.allocations) {
          if (!a.invoice_id) continue;
          paidByInvoice.set(a.invoice_id, (paidByInvoice.get(a.invoice_id) ?? 0) + a.amount_paise);
        }
      }
      for (const adv of advs) {
        for (const app of adv.applications) {
          if (!app.invoice_id) continue;
          paidByInvoice.set(
            app.invoice_id,
            (paidByInvoice.get(app.invoice_id) ?? 0) + app.amount_paise,
          );
        }
      }

      const rollupByCust = new Map<string, CustomerRollup>();
      const bump = (cid: string): CustomerRollup => {
        let r = rollupByCust.get(cid);
        if (!r) {
          r = { ...EMPTY_ROLLUP };
          rollupByCust.set(cid, r);
        }
        return r;
      };

      for (const inv of invs) {
        if (inv.reverses_invoice_id) continue;
        if (inv.status === 'cancelled' || inv.status === 'draft') continue;
        const r = bump(inv.customer_id);
        r.total_sales_paise += inv.total_paise;
        const paid = paidByInvoice.get(inv.id) ?? 0;
        const credit = (creditsByOriginal.get(inv.id) ?? []).reduce(
          (s, cn) => s + Math.abs(cn.total_paise),
          0,
        );
        const gross = inv.total_paise - paid - credit;
        const outstanding = Math.max(0, gross);
        r.receivable_paise += outstanding;
        if (outstanding > 0 && inv.due_date && today > inv.due_date) {
          r.overdue_paise += outstanding;
        }
      }
      for (const adv of advs) {
        if (adv.remaining_paise <= 0) continue;
        bump(adv.party_id).advance_paise += adv.remaining_paise;
      }
      for (const [cid, ymd] of lastPaymentByCustomer.entries()) {
        bump(cid).last_payment_ymd = ymd;
      }

      setRollups(rollupByCust);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, reloadKey]);

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
        let c = db.customers.where('business_id').equals(businessId);
        if (search || filters.name || filters.phone || filters.gstin) {
          c = c.filter((r) => {
            if (
              search &&
              !(
                matchesText(r.name, search) ||
                matchesText(r.phone, search) ||
                matchesText(r.email, search) ||
                matchesText(r.gstin, search)
              )
            ) {
              return false;
            }
            if (filters.name && !matchesText(r.name, filters.name)) return false;
            if (filters.phone && !matchesText(r.phone, filters.phone)) return false;
            if (filters.gstin && !matchesText(r.gstin, filters.gstin)) return false;
            return true;
          });
        }
        return c;
      };
      return paginateCollection<Customer>(makeCol, offset, limit);
    },
    [businessId],
  );

  const columns: ColumnDef<Customer>[] = useMemo(
    () => [
      { key: 'name', header: 'Customer', filterable: true, render: (r) => r.name },
      { key: 'phone', header: 'Phone', filterable: true, render: (r) => r.phone || '—' },
      {
        key: 'total_sales',
        header: 'Total Sales',
        className: 'text-right',
        render: (r) => <Money paise={rollups.get(r.id)?.total_sales_paise ?? 0} />,
      },
      {
        key: 'receivable',
        header: 'Receivable',
        className: 'text-right',
        render: (r) => <Money paise={rollups.get(r.id)?.receivable_paise ?? 0} />,
      },
      {
        key: 'overdue',
        header: 'Overdue',
        className: 'text-right',
        render: (r) => {
          const p = rollups.get(r.id)?.overdue_paise ?? 0;
          return p > 0 ? (
            <span className="text-rose-700 font-medium">
              <Money paise={p} />
            </span>
          ) : (
            <Money paise={0} />
          );
        },
      },
      {
        key: 'advance',
        header: 'Advance',
        className: 'text-right',
        render: (r) => {
          const p = rollups.get(r.id)?.advance_paise ?? 0;
          return p > 0 ? (
            <span className="text-blue-700 font-medium">
              <Money paise={p} />
            </span>
          ) : (
            <Money paise={0} />
          );
        },
      },
      {
        key: 'last_payment',
        header: 'Last Payment',
        render: (r) => rollups.get(r.id)?.last_payment_ymd ?? '—',
      },
    ],
    [rollups],
  );

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: Customer) {
    setEditing(row);
    setForm({
      name: row.name,
      phone: row.phone,
      email: row.email,
      gstin: row.gstin ?? '',
      billingAddress: row.billing_address,
      shippingAddress: row.shipping_address,
      state: row.state,
      stateCode: row.state_code,
      openingBalanceRupees: paiseToRupees(row.opening_balance_paise),
      creditLimitRupees: paiseToRupees(row.credit_limit_paise),
      notes: row.notes,
      active: row.active === 1,
    });
    setSaveError(null);
    setDrawerOpen(true);
  }

  async function save() {
    if (!businessId || !deviceId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const svc = createCustomerService({ db });
      if (editing) {
        await svc.update({
          id: editing.id,
          businessId,
          deviceId,
          patch: {
            name: form.name,
            phone: form.phone,
            email: form.email,
            gstin: form.gstin || null,
            billing_address: form.billingAddress,
            shipping_address: form.shippingAddress,
            state: form.state,
            state_code: form.stateCode,
            opening_balance_paise: rupeesToPaise(form.openingBalanceRupees),
            credit_limit_paise: rupeesToPaise(form.creditLimitRupees),
            notes: form.notes,
            active: form.active ? 1 : 0,
          },
        });
      } else {
        await svc.create({
          businessId,
          deviceId,
          name: form.name,
          phone: form.phone,
          email: form.email,
          gstin: form.gstin || null,
          billingAddress: form.billingAddress,
          shippingAddress: form.shippingAddress,
          state: form.state,
          stateCode: form.stateCode,
          openingBalancePaise: rupeesToPaise(form.openingBalanceRupees),
          creditLimitPaise: rupeesToPaise(form.creditLimitRupees),
          notes: form.notes,
        });
      }
      setDrawerOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
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
      filename: 'customers.csv',
      columns: [
        { header: 'Name', get: (r: Customer) => r.name },
        { header: 'Phone', get: (r: Customer) => r.phone },
        { header: 'Email', get: (r: Customer) => r.email },
        { header: 'GSTIN', get: (r: Customer) => r.gstin ?? '' },
        { header: 'Billing Address', get: (r: Customer) => r.billing_address },
        { header: 'Shipping Address', get: (r: Customer) => r.shipping_address },
        { header: 'State', get: (r: Customer) => r.state },
        { header: 'State Code', get: (r: Customer) => r.state_code },
        { header: 'Opening Balance', get: (r: Customer) => paiseToRupees(r.opening_balance_paise) },
        { header: 'Credit Limit', get: (r: Customer) => paiseToRupees(r.credit_limit_paise) },
        { header: 'Notes', get: (r: Customer) => r.notes },
        { header: 'Active', get: (r: Customer) => (r.active ? '1' : '0') },
      ],
      rows: iterate(),
    });
  }

  if (loading) {
    return <div className="p-6 text-slate-500">Loading...</div>;
  }
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
        <h1 className="text-xl font-semibold">Customers</h1>
        <button
          type="button"
          onClick={openNew}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 hover:bg-slate-800"
        >
          New Customer
        </button>
      </div>

      <DataTable<Customer>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[reloadKey, rollups]}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/customers/${r.id}`)}
        searchPlaceholder="Search name / phone / email / GSTIN"
        onExport={exportCsv}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? 'Edit Customer' : 'New Customer'}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || form.name.trim().length === 0}
              onClick={save}
              className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        }
      >
        <CustomerFormFields form={form} setForm={setForm} />
        {saveError && (
          <div className="mt-3 text-sm text-rose-600 whitespace-pre-wrap">{saveError}</div>
        )}
      </Drawer>
    </div>
  );
}

function CustomerFormFields({
  form,
  setForm,
}: {
  form: CustomerForm;
  setForm: (f: CustomerForm) => void;
}) {
  function set<K extends keyof CustomerForm>(k: K, v: CustomerForm[K]) {
    setForm({ ...form, [k]: v });
  }
  function onGstinChange(raw: string) {
    const g = raw.toUpperCase();
    const derived = stateFromGstin(g);
    if (derived) {
      setForm({ ...form, gstin: g, state: derived.name, stateCode: derived.code });
    } else {
      setForm({ ...form, gstin: g });
    }
  }
  function onStateChange(code: string) {
    const s = findStateByCode(code);
    setForm({ ...form, state: s?.name ?? '', stateCode: code });
  }
  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <label className="col-span-2">
        <span className="block text-slate-700 mb-1">Name *</span>
        <input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5"
        />
      </label>
      <label>
        <span className="block text-slate-700 mb-1">Phone</span>
        <input
          value={form.phone}
          onChange={(e) => set('phone', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5"
        />
      </label>
      <label>
        <span className="block text-slate-700 mb-1">Email</span>
        <input
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5"
        />
      </label>
      <label className="col-span-2">
        <span className="block text-slate-700 mb-1">GSTIN</span>
        <input
          value={form.gstin}
          onChange={(e) => onGstinChange(e.target.value)}
          placeholder="15-char GSTIN (state auto-fills from first 2 digits)"
          className="w-full border border-slate-300 rounded px-2 py-1.5 uppercase"
        />
      </label>
      <label>
        <span className="block text-slate-700 mb-1">State</span>
        <select
          value={form.stateCode}
          onChange={(e) => onStateChange(e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5 bg-white"
        >
          <option value="">— Select state —</option>
          {INDIAN_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="block text-slate-700 mb-1">State Code</span>
        <input
          value={form.stateCode}
          readOnly
          tabIndex={-1}
          className="w-full border border-slate-200 rounded px-2 py-1.5 bg-slate-50 text-slate-600"
        />
      </label>
      <label className="col-span-2">
        <span className="block text-slate-700 mb-1">Billing Address</span>
        <textarea
          value={form.billingAddress}
          onChange={(e) => set('billingAddress', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5 h-16"
        />
      </label>
      <label className="col-span-2">
        <span className="block text-slate-700 mb-1">Shipping Address</span>
        <textarea
          value={form.shippingAddress}
          onChange={(e) => set('shippingAddress', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5 h-16"
        />
      </label>
      <label>
        <span className="block text-slate-700 mb-1">Opening Balance (₹)</span>
        <input
          value={form.openingBalanceRupees}
          onChange={(e) => set('openingBalanceRupees', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-right"
        />
      </label>
      <label>
        <span className="block text-slate-700 mb-1">Credit Limit (₹)</span>
        <input
          value={form.creditLimitRupees}
          onChange={(e) => set('creditLimitRupees', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-right"
        />
      </label>
      <label className="col-span-2">
        <span className="block text-slate-700 mb-1">Notes</span>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1.5 h-16"
        />
      </label>
      <label className="col-span-2 inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => set('active', e.target.checked)}
        />
        <span>Active</span>
      </label>
    </div>
  );
}
