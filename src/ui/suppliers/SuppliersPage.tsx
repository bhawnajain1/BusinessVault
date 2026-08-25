import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../../db';
import type { Supplier } from '../../db/types';
import { createSupplierService } from '../../domain/SupplierService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Drawer from '../components/Drawer';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { INDIAN_STATES, findStateByCode, stateFromGstin } from '../../lib/indianStates';

interface SupplierForm {
  name: string;
  phone: string;
  email: string;
  gstin: string;
  address: string;
  state: string;
  stateCode: string;
  openingBalanceRupees: string;
  notes: string;
  active: boolean;
}

const EMPTY_FORM: SupplierForm = {
  name: '',
  phone: '',
  email: '',
  gstin: '',
  address: '',
  state: '',
  stateCode: '',
  openingBalanceRupees: '0',
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

export default function SuppliersPage() {
  const { businessId, deviceId, loading } = useActiveBusiness();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState<SupplierForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Open edit drawer if navigated with ?edit=<id>. Consumed once, then stripped.
  useEffect(() => {
    if (!businessId) return;
    const editId = searchParams.get('edit');
    if (!editId) return;
    let cancelled = false;
    (async () => {
      const row = await db.suppliers.get(editId);
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
        let c = db.suppliers.where('business_id').equals(businessId);
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
      return paginateCollection<Supplier>(makeCol, offset, limit);
    },
    [businessId],
  );

  const columns: ColumnDef<Supplier>[] = [
    { key: 'name', header: 'Name', filterable: true, render: (r) => r.name },
    { key: 'phone', header: 'Phone', filterable: true, render: (r) => r.phone || '—' },
    { key: 'email', header: 'Email', render: (r) => r.email || '—' },
    { key: 'gstin', header: 'GSTIN', filterable: true, render: (r) => r.gstin || '—' },
    { key: 'state', header: 'State', render: (r) => r.state || '—' },
    {
      key: 'opening_balance',
      header: 'Opening Balance',
      className: 'text-right',
      render: (r) => <Money paise={r.opening_balance_paise} />,
    },
    { key: 'active', header: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
    {
      key: 'ledger',
      header: '',
      render: (r) => (
        <Link
          to={`/parties/supplier/${r.id}/ledger`}
          onClick={(e) => e.stopPropagation()}
          className="text-xs text-blue-700 hover:underline"
        >
          Ledger
        </Link>
      ),
    },
  ];

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: Supplier) {
    setEditing(row);
    setForm({
      name: row.name,
      phone: row.phone,
      email: row.email,
      gstin: row.gstin ?? '',
      address: row.address,
      state: row.state,
      stateCode: row.state_code,
      openingBalanceRupees: paiseToRupees(row.opening_balance_paise),
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
      const svc = createSupplierService({ db });
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
            address: form.address,
            state: form.state,
            state_code: form.stateCode,
            opening_balance_paise: rupeesToPaise(form.openingBalanceRupees),
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
          address: form.address,
          state: form.state,
          stateCode: form.stateCode,
          openingBalancePaise: rupeesToPaise(form.openingBalanceRupees),
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
      filename: 'suppliers.csv',
      columns: [
        { header: 'Name', get: (r: Supplier) => r.name },
        { header: 'Phone', get: (r: Supplier) => r.phone },
        { header: 'Email', get: (r: Supplier) => r.email },
        { header: 'GSTIN', get: (r: Supplier) => r.gstin ?? '' },
        { header: 'Address', get: (r: Supplier) => r.address },
        { header: 'State', get: (r: Supplier) => r.state },
        { header: 'State Code', get: (r: Supplier) => r.state_code },
        { header: 'Opening Balance', get: (r: Supplier) => paiseToRupees(r.opening_balance_paise) },
        { header: 'Notes', get: (r: Supplier) => r.notes },
        { header: 'Active', get: (r: Supplier) => (r.active ? '1' : '0') },
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
        <h1 className="text-xl font-semibold">Suppliers</h1>
        <button
          type="button"
          onClick={openNew}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 hover:bg-slate-800"
        >
          New Supplier
        </button>
      </div>

      <DataTable<Supplier>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[reloadKey]}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
        searchPlaceholder="Search name / phone / email / GSTIN"
        onExport={exportCsv}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? 'Edit Supplier' : 'New Supplier'}
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
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Name *</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Phone</span>
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Email</span>
            <input
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">GSTIN</span>
            <input
              value={form.gstin}
              onChange={(e) => {
                const g = e.target.value.toUpperCase();
                const derived = stateFromGstin(g);
                if (derived) {
                  setForm({ ...form, gstin: g, state: derived.name, stateCode: derived.code });
                } else {
                  setForm({ ...form, gstin: g });
                }
              }}
              placeholder="15-char GSTIN (state auto-fills from first 2 digits)"
              className="w-full border border-slate-300 rounded px-2 py-1.5 uppercase"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">State</span>
            <select
              value={form.stateCode}
              onChange={(e) => {
                const s = findStateByCode(e.target.value);
                setForm({ ...form, state: s?.name ?? '', stateCode: e.target.value });
              }}
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
            <span className="block text-slate-700 mb-1">Address</span>
            <textarea
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5 h-16"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Opening Balance (₹)</span>
            <input
              value={form.openingBalanceRupees}
              onChange={(e) => setForm({ ...form, openingBalanceRupees: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-right"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Notes</span>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5 h-16"
            />
          </label>
          <label className="col-span-2 inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            <span>Active</span>
          </label>
        </div>
        {saveError && (
          <div className="mt-3 text-sm text-rose-600 whitespace-pre-wrap">{saveError}</div>
        )}
      </Drawer>
    </div>
  );
}
