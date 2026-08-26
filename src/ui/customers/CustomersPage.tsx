import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../../db';
import type { Customer, Invoice, Payment, Advance } from '../../db/types';
import { createCustomerService } from '../../domain/CustomerService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Drawer from '../components/Drawer';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { INDIAN_STATES } from '../../lib/indianStates';
import {
  applyGstinChange,
  applyStateChange,
  inferManuallySet,
  type GstinStatePair,
} from '../../lib/gstinStateSync';
import GstinStateBadge from '../components/GstinStateBadge';

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
          .toArray(),
        db.advances
          .where('business_id')
          .equals(businessId)
          .filter((a) => a.party_type === 'customer')
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
    return <div className="p-6 text-fg-muted">Loading...</div>;
  }
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
        <h1 className="text-xl font-semibold text-fg">Customers</h1>
        <button
          type="button"
          onClick={openNew}
          className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90"
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
              className="h-8 rounded-md border border-border bg-surface px-3 text-[13px] text-fg-muted hover:text-fg hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || form.name.trim().length === 0}
              onClick={save}
              className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        }
      >
        <CustomerFormFields form={form} setForm={setForm} />
        {saveError && (
          <div className="mt-3 text-sm text-danger whitespace-pre-wrap">{saveError}</div>
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
  // Manual-latch stays local to the form's lifetime — no need to persist
  // it. Initialised from what's already on the record so an already-loaded
  // customer whose state disagrees with their GSTIN doesn't get silently
  // "corrected" on the first keystroke elsewhere in the form.
  const [manuallySet, setManuallySet] = useState<boolean>(() =>
    inferManuallySet(form.gstin, form.stateCode),
  );
  function set<K extends keyof CustomerForm>(k: K, v: CustomerForm[K]) {
    setForm({ ...form, [k]: v });
  }
  function pairFromForm(): GstinStatePair {
    return {
      gstin: form.gstin,
      stateCode: form.stateCode,
      stateName: form.state,
      stateManuallySet: manuallySet,
    };
  }
  function onGstinChange(raw: string) {
    const next = applyGstinChange(pairFromForm(), raw);
    setManuallySet(next.stateManuallySet);
    setForm({
      ...form,
      gstin: next.gstin,
      state: next.stateName,
      stateCode: next.stateCode,
    });
  }
  function onStateChange(code: string) {
    const next = applyStateChange(pairFromForm(), code);
    setManuallySet(next.stateManuallySet);
    setForm({
      ...form,
      state: next.stateName,
      stateCode: next.stateCode,
    });
  }
  const labelCls = 'block text-[12px] text-fg-muted mb-1';
  const inputCls =
    'w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring';
  const inputRightCls = `${inputCls} text-right`;
  const readonlyCls =
    'w-full h-8 rounded-md border border-border bg-app px-2.5 text-[13px] text-fg-muted';
  const textareaCls =
    'w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg h-16 focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <label className="col-span-2">
        <span className={labelCls}>Name *</span>
        <input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          className={inputCls}
        />
      </label>
      <label>
        <span className={labelCls}>Phone</span>
        <input
          value={form.phone}
          onChange={(e) => set('phone', e.target.value)}
          className={inputCls}
        />
      </label>
      <label>
        <span className={labelCls}>Email</span>
        <input
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          className={inputCls}
        />
      </label>
      <label className="col-span-2">
        <span className={labelCls}>GSTIN</span>
        <input
          value={form.gstin}
          onChange={(e) => onGstinChange(e.target.value)}
          placeholder="15-char GSTIN (state auto-fills from first 2 digits)"
          className={`${inputCls} uppercase`}
        />
        <GstinStateBadge gstin={form.gstin} stateCode={form.stateCode} />
      </label>
      <label>
        <span className={labelCls}>State</span>
        <select
          value={form.stateCode}
          onChange={(e) => onStateChange(e.target.value)}
          className={inputCls}
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
        <span className={labelCls}>State Code</span>
        <input
          value={form.stateCode}
          readOnly
          tabIndex={-1}
          className={readonlyCls}
        />
      </label>
      <label className="col-span-2">
        <span className={labelCls}>Billing Address</span>
        <textarea
          value={form.billingAddress}
          onChange={(e) => set('billingAddress', e.target.value)}
          className={textareaCls}
        />
      </label>
      <label className="col-span-2">
        <span className={labelCls}>Shipping Address</span>
        <textarea
          value={form.shippingAddress}
          onChange={(e) => set('shippingAddress', e.target.value)}
          className={textareaCls}
        />
      </label>
      <label>
        <span className={labelCls}>Opening Balance (₹)</span>
        <input
          value={form.openingBalanceRupees}
          onChange={(e) => set('openingBalanceRupees', e.target.value)}
          className={inputRightCls}
        />
      </label>
      <label>
        <span className={labelCls}>Credit Limit (₹)</span>
        <input
          value={form.creditLimitRupees}
          onChange={(e) => set('creditLimitRupees', e.target.value)}
          className={inputRightCls}
        />
      </label>
      <label className="col-span-2">
        <span className={labelCls}>Notes</span>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          className={textareaCls}
        />
      </label>
      <label className="col-span-2 inline-flex items-center gap-2 text-[13px] text-fg">
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
