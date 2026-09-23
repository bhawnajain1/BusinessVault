import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { db } from '../../db';
import type { Category, Item, Unit } from '../../db/types';
import { createItemService } from '../../domain/ItemService';
import { seedDefaultMasters } from '../../domain/defaults';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Drawer from '../components/Drawer';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';

interface ItemForm {
  sku: string;
  name: string;
  description: string;
  hsn: string;
  categoryId: string;
  unitId: string;
  salePriceRupees: string;
  purchasePriceRupees: string;
  taxRatePct: string;
  cessRatePct: string;
  isService: boolean;
  trackInventory: boolean;
  openingQty: string;
  openingValueRupees: string;
  reorderLevel: string;
  barcode: string;
  active: boolean;
}

const EMPTY_FORM: ItemForm = {
  sku: '',
  name: '',
  description: '',
  hsn: '',
  categoryId: '',
  unitId: '',
  salePriceRupees: '0',
  purchasePriceRupees: '0',
  taxRatePct: '18',
  cessRatePct: '0',
  isService: false,
  trackInventory: true,
  openingQty: '0',
  openingValueRupees: '0',
  reorderLevel: '0',
  barcode: '',
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
function pctToBps(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function bpsToPct(b: number): string {
  return (b / 100).toString();
}
function unitsToMicros(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000);
}
function microsToUnits(m: number): string {
  return (m / 1_000_000).toString();
}

function ItemFormFields({
  form,
  setForm,
  units,
  categories,
  editing,
}: {
  form: ItemForm;
  setForm: (form: ItemForm) => void;
  units: Unit[];
  categories: Category[];
  editing: Item | null;
}) {
  const input = 'w-full h-10 rounded-xl border border-slate-200 bg-white px-3 text-[13px] text-slate-800 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-4 focus:ring-blue-500/10';
  const label = 'mb-1 block text-xs font-semibold text-slate-600';
  const set = <K extends keyof ItemForm>(key: K, value: ItemForm[K]) => setForm({ ...form, [key]: value });
  return (
    <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
      <label><span className={label}>SKU *</span><input value={form.sku} onChange={(e) => set('sku', e.target.value)} className={input} disabled={!!editing} /></label>
      <label><span className={label}>Name *</span><input value={form.name} onChange={(e) => set('name', e.target.value)} className={input} /></label>
      <label><span className={label}>HSN</span><input value={form.hsn} onChange={(e) => set('hsn', e.target.value)} className={input} /></label>
      <label><span className={label}>Barcode</span><input value={form.barcode} onChange={(e) => set('barcode', e.target.value)} className={input} /></label>
      <label><span className={label}>Unit</span><select value={form.unitId} onChange={(e) => set('unitId', e.target.value)} className={input}>{units.length === 0 && <option value="">— none available —</option>}{units.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</select></label>
      <label><span className={label}>Category</span><select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} className={input}><option value="">— none —</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label><span className={label}>Sale Price (₹)</span><input value={form.salePriceRupees} onChange={(e) => set('salePriceRupees', e.target.value)} className={`${input} text-right`} /></label>
      <label><span className={label}>Purchase Price (₹)</span><input value={form.purchasePriceRupees} onChange={(e) => set('purchasePriceRupees', e.target.value)} className={`${input} text-right`} /></label>
      <label><span className={label}>GST %</span><input value={form.taxRatePct} onChange={(e) => set('taxRatePct', e.target.value)} className={`${input} text-right`} /></label>
      <label><span className={label}>Cess %</span><input value={form.cessRatePct} onChange={(e) => set('cessRatePct', e.target.value)} className={`${input} text-right`} /></label>
      <label><span className={label}>Opening Qty</span><input value={form.openingQty} onChange={(e) => set('openingQty', e.target.value)} className={`${input} text-right`} disabled={!!editing} /></label>
      <label><span className={label}>Opening Value (₹)</span><input value={form.openingValueRupees} onChange={(e) => set('openingValueRupees', e.target.value)} className={`${input} text-right`} disabled={!!editing} /></label>
      <label><span className={label}>Reorder Level</span><input value={form.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} className={`${input} text-right`} /></label>
      <label className="sm:col-span-2"><span className={label}>Description</span><textarea value={form.description} onChange={(e) => set('description', e.target.value)} className={`${input} h-24 py-2`} /></label>
      <label className="inline-flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 px-3"><input type="checkbox" checked={form.isService} onChange={(e) => set('isService', e.target.checked)} /><span>Service</span></label>
      <label className="inline-flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 px-3"><input type="checkbox" checked={form.trackInventory} onChange={(e) => set('trackInventory', e.target.checked)} /><span>Track inventory</span></label>
      <label className="inline-flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 px-3 sm:col-span-2"><input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /><span>Active</span></label>
    </div>
  );
}

export default function ItemsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isNewRoute = location.pathname === '/items/new';
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<ItemForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [units, setUnits] = useState<Unit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      let [u, c] = await Promise.all([
        db.units.where('business_id').equals(businessId).toArray(),
        db.categories.where('business_id').equals(businessId).toArray(),
      ]);
      if (u.length === 0 && c.length === 0) {
        await seedDefaultMasters(businessId);
        [u, c] = await Promise.all([
          db.units.where('business_id').equals(businessId).toArray(),
          db.categories.where('business_id').equals(businessId).toArray(),
        ]);
      }
      setUnits(u);
      setCategories(c);
    })();
  }, [businessId, drawerOpen]);

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
        let c = db.items.where('business_id').equals(businessId);
        if (search || filters.sku || filters.name || filters.hsn) {
          c = c.filter((r) => {
            if (
              search &&
              !(
                matchesText(r.sku, search) ||
                matchesText(r.name, search) ||
                matchesText(r.hsn, search) ||
                matchesText(r.barcode ?? '', search)
              )
            ) {
              return false;
            }
            if (filters.sku && !matchesText(r.sku, filters.sku)) return false;
            if (filters.name && !matchesText(r.name, filters.name)) return false;
            if (filters.hsn && !matchesText(r.hsn, filters.hsn)) return false;
            return true;
          });
        }
        return c;
      };
      return paginateCollection<Item>(makeCol, offset, limit);
    },
    [businessId],
  );

  const columns: ColumnDef<Item>[] = [
    { key: 'sku', header: 'SKU', filterable: true, render: (r) => r.sku },
    { key: 'name', header: 'Name', filterable: true, render: (r) => r.name },
    { key: 'hsn', header: 'HSN', filterable: true, render: (r) => r.hsn || '—' },
    {
      key: 'sale',
      header: 'Sale Price',
      className: 'text-right',
      render: (r) => <Money paise={r.sale_price_paise} />,
    },
    {
      key: 'purchase',
      header: 'Purchase Price',
      className: 'text-right',
      render: (r) => <Money paise={r.purchase_price_paise} />,
    },
    { key: 'tax', header: 'GST %', className: 'text-right', render: (r) => `${bpsToPct(r.tax_rate_bps)}%` },
    { key: 'service', header: 'Type', render: (r) => (r.is_service ? 'Service' : 'Goods') },
    { key: 'active', header: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
  ];

  function openNew() {
    setEditing(null);
    const pcsUnit = units.find((u) => u.code === 'PCS')?.id ?? units[0]?.id ?? '';
    setForm({ ...EMPTY_FORM, unitId: pcsUnit });
    setSaveError(null);
    navigate('/items/new');
  }
  function openEdit(row: Item) {
    setEditing(row);
    setForm({
      sku: row.sku,
      name: row.name,
      description: row.description,
      hsn: row.hsn,
      categoryId: row.category_id ?? '',
      unitId: row.unit_id,
      salePriceRupees: paiseToRupees(row.sale_price_paise),
      purchasePriceRupees: paiseToRupees(row.purchase_price_paise),
      taxRatePct: bpsToPct(row.tax_rate_bps),
      cessRatePct: bpsToPct(row.cess_rate_bps),
      isService: row.is_service === 1,
      trackInventory: row.track_inventory === 1,
      openingQty: microsToUnits(row.opening_qty_micros),
      openingValueRupees: paiseToRupees(row.opening_value_paise),
      reorderLevel: microsToUnits(row.reorder_level_micros),
      barcode: row.barcode ?? '',
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
      const svc = createItemService({ db });
      const effectiveUnitId =
        form.unitId ||
        units.find((u) => u.code === 'PCS')?.id ||
        units[0]?.id ||
        '';
      if (!effectiveUnitId) {
        throw new Error('No units available. Please create a unit first from Settings.');
      }
      if (editing) {
        await svc.update({
          id: editing.id,
          businessId,
          deviceId,
          patch: {
            sku: form.sku,
            name: form.name,
            description: form.description,
            hsn: form.hsn,
            category_id: form.categoryId || null,
            unit_id: effectiveUnitId,
            sale_price_paise: rupeesToPaise(form.salePriceRupees),
            purchase_price_paise: rupeesToPaise(form.purchasePriceRupees),
            tax_rate_bps: pctToBps(form.taxRatePct),
            cess_rate_bps: pctToBps(form.cessRatePct),
            is_service: form.isService ? 1 : 0,
            track_inventory: form.trackInventory ? 1 : 0,
            reorder_level_micros: unitsToMicros(form.reorderLevel),
            barcode: form.barcode || null,
            active: form.active ? 1 : 0,
          },
        });
      } else {
        await svc.create({
          businessId,
          deviceId,
          sku: form.sku,
          name: form.name,
          description: form.description,
          hsn: form.hsn,
          categoryId: form.categoryId || null,
          unitId: effectiveUnitId,
          salePricePaise: rupeesToPaise(form.salePriceRupees),
          purchasePricePaise: rupeesToPaise(form.purchasePriceRupees),
          taxRateBps: pctToBps(form.taxRatePct),
          cessRateBps: pctToBps(form.cessRatePct),
          isService: form.isService,
          trackInventory: form.trackInventory,
          openingQtyMicros: unitsToMicros(form.openingQty),
          openingValuePaise: rupeesToPaise(form.openingValueRupees),
          reorderLevelMicros: unitsToMicros(form.reorderLevel),
          barcode: form.barcode || null,
        });
      }
      if (isNewRoute) {
        navigate('/items');
      } else {
        setDrawerOpen(false);
      }
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
      filename: 'items.csv',
      columns: [
        { header: 'SKU', get: (r: Item) => r.sku },
        { header: 'Name', get: (r: Item) => r.name },
        { header: 'HSN', get: (r: Item) => r.hsn },
        { header: 'Sale Price', get: (r: Item) => paiseToRupees(r.sale_price_paise) },
        { header: 'Purchase Price', get: (r: Item) => paiseToRupees(r.purchase_price_paise) },
        { header: 'Tax %', get: (r: Item) => bpsToPct(r.tax_rate_bps) },
        { header: 'Is Service', get: (r: Item) => (r.is_service ? '1' : '0') },
        { header: 'Track Inventory', get: (r: Item) => (r.track_inventory ? '1' : '0') },
        { header: 'Barcode', get: (r: Item) => r.barcode ?? '' },
        { header: 'Active', get: (r: Item) => (r.active ? '1' : '0') },
      ],
      rows: iterate(),
    });
  }

  if (loading) return <div className="p-6 text-fg-subtle">Loading...</div>;
  if (!businessId) {
    return (
      <div className="p-6 text-fg-muted">
        No active business — complete onboarding first.
      </div>
    );
  }

  if (isNewRoute) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <button type="button" onClick={() => navigate('/items')} className="mb-3 text-sm font-semibold text-blue-700 hover:text-blue-800">
              ← Items
            </button>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Catalog setup</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">New item</h1>
            <p className="mt-2 text-sm text-slate-500">Define pricing, GST, inventory, and item identification details.</p>
          </div>
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800">Catalog item</div>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7">
          <ItemFormFields form={form} setForm={setForm} units={units} categories={categories} editing={null} />
          {saveError && <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 whitespace-pre-wrap">{saveError}</div>}
          <div className="mt-7 flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-5">
            <button type="button" onClick={() => navigate('/items')} className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-blue-700 hover:bg-blue-50">Cancel</button>
            <button type="button" disabled={saving || form.name.trim().length === 0 || form.sku.trim().length === 0} onClick={save} className="h-10 rounded-xl bg-green-600 px-5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save Item'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg">Items</h1>
        <button
          type="button"
          onClick={openNew}
          className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90"
        >
          New Item
        </button>
      </div>

      <DataTable<Item>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[reloadKey]}
        rowKey={(r) => r.id}
        onRowClick={openEdit}
        searchPlaceholder="Search SKU / name / HSN / barcode"
        onExport={exportCsv}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? 'Edit Item' : 'New Item'}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="action-cancel h-8 text-[13px]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                saving ||
                form.name.trim().length === 0 ||
                form.sku.trim().length === 0
              }
              onClick={save}
              className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">SKU *</span>
            <input
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={!!editing}
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Name *</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">HSN</span>
            <input
              value={form.hsn}
              onChange={(e) => setForm({ ...form, hsn: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Barcode</span>
            <input
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Unit</span>
            <select
              value={form.unitId}
              onChange={(e) => setForm({ ...form, unitId: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {units.length === 0 && <option value="">— none available —</option>}
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} — {u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Category</span>
            <select
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— none —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Sale Price (₹)</span>
            <input
              value={form.salePriceRupees}
              onChange={(e) => setForm({ ...form, salePriceRupees: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Purchase Price (₹)</span>
            <input
              value={form.purchasePriceRupees}
              onChange={(e) => setForm({ ...form, purchasePriceRupees: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">GST %</span>
            <input
              value={form.taxRatePct}
              onChange={(e) => setForm({ ...form, taxRatePct: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Cess %</span>
            <input
              value={form.cessRatePct}
              onChange={(e) => setForm({ ...form, cessRatePct: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Opening Qty</span>
            <input
              value={form.openingQty}
              onChange={(e) => setForm({ ...form, openingQty: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={!!editing}
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Opening Value (₹)</span>
            <input
              value={form.openingValueRupees}
              onChange={(e) => setForm({ ...form, openingValueRupees: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={!!editing}
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Reorder Level</span>
            <input
              value={form.reorderLevel}
              onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-[12px] text-fg-muted mb-1">Description</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg h-16 focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isService}
              onChange={(e) => setForm({ ...form, isService: e.target.checked })}
            />
            <span>Service</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.trackInventory}
              onChange={(e) => setForm({ ...form, trackInventory: e.target.checked })}
            />
            <span>Track inventory</span>
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
          <div className="mt-3 text-sm text-danger whitespace-pre-wrap">{saveError}</div>
        )}
      </Drawer>
    </div>
  );
}
