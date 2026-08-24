import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type {
  Account,
  Business,
  Item,
  Purchase,
  PurchaseStatus,
  Supplier,
  Warehouse,
} from '../../db/types';
import { createPurchaseService } from '../../domain/PurchaseService';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Drawer from '../components/Drawer';
import Money from '../components/Money';
import StatusBadge from '../components/StatusBadge';
import { paginateCollection, matchesText } from '../components/pagination';

const STATUSES: PurchaseStatus[] = ['draft', 'received', 'partial', 'paid', 'cancelled'];

interface EditorLine {
  itemId: string;
  description: string;
  hsn: string;
  qty: string;
  unitCostRupees: string;
  taxRatePct: string;
}

const EMPTY_LINE: EditorLine = {
  itemId: '',
  description: '',
  hsn: '',
  qty: '1',
  unitCostRupees: '0',
  taxRatePct: '18',
};

function rupeesToPaise(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function pctToBps(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function unitsToMicros(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function PurchasesPage() {
  const { businessId, deviceId, loading } = useActiveBusiness();
  const [statusFilter, setStatusFilter] = useState<PurchaseStatus | ''>('');
  const [supplierFilter, setSupplierFilter] = useState<string>('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierById, setSupplierById] = useState<Map<string, Supplier>>(new Map());
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [business, setBusiness] = useState<Business | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Editor state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [supplierBillNumber, setSupplierBillNumber] = useState('');
  const [billDate, setBillDate] = useState<string>(today());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditorLine[]>([{ ...EMPTY_LINE }]);
  const [showVoided, setShowVoided] = useState(false);

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const [supRows, itemRows, whRows, acctRows, bizRows] = await Promise.all([
        db.suppliers.where('business_id').equals(businessId).toArray(),
        db.items.where('business_id').equals(businessId).toArray(),
        db.warehouses.where('business_id').equals(businessId).toArray(),
        db.accounts.where('business_id').equals(businessId).toArray(),
        db.businesses.where('id').equals(businessId).toArray(),
      ]);
      setSuppliers(supRows);
      setSupplierById(new Map(supRows.map((s) => [s.id, s])));
      setItems(itemRows);
      setWarehouses(whRows);
      setAccounts(acctRows);
      setBusiness(bizRows[0] ?? null);
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
        let c;
        if (statusFilter) {
          c = db.purchases
            .where('[business_id+status]')
            .equals([businessId, statusFilter]);
        } else if (supplierFilter) {
          c = db.purchases
            .where('[business_id+supplier_id]')
            .equals([businessId, supplierFilter]);
        } else {
          c = db.purchases.where('business_id').equals(businessId);
        }
        c = c.reverse();
        c = c.filter((p) => {
          if (!showVoided && p.status === 'cancelled') return false;
          if (
            search &&
            !(
              matchesText(p.bill_number, search) ||
              matchesText(p.supplier_bill_number, search) ||
              matchesText(p.notes, search) ||
              matchesText(supplierById.get(p.supplier_id)?.name, search)
            )
          ) {
            return false;
          }
          if (filters.bill_number && !matchesText(p.bill_number, filters.bill_number)) return false;
          if (
            filters.supplier &&
            !matchesText(supplierById.get(p.supplier_id)?.name, filters.supplier)
          ) {
            return false;
          }
          return true;
        });
        return c;
      };
      return paginateCollection<Purchase>(makeCol, offset, limit);
    },
    [businessId, statusFilter, supplierFilter, supplierById, showVoided],
  );

  const columns: ColumnDef<Purchase>[] = [
    {
      key: 'bill_number',
      header: 'Bill #',
      filterable: true,
      render: (r) => (
        <Link to={`/purchases/${r.id}`} className="text-blue-700 hover:underline">
          {r.bill_number}
        </Link>
      ),
    },
    { key: 'bill_date', header: 'Date', render: (r) => r.bill_date },
    {
      key: 'supplier',
      header: 'Supplier',
      filterable: true,
      render: (r) => supplierById.get(r.supplier_id)?.name ?? r.supplier_id,
    },
    { key: 'supplier_bill', header: 'Supplier Bill #', render: (r) => r.supplier_bill_number || '—' },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      render: (r) => <Money paise={r.total_paise} />,
    },
    {
      key: 'balance',
      header: 'Balance',
      className: 'text-right',
      render: (r) => <Money paise={r.balance_paise} />,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.status === 'cancelled' ? (
          <span className="text-xs text-slate-400">cancelled</span>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void openEdit(r);
            }}
            className="text-xs text-blue-700 hover:underline"
          >
            Edit
          </button>
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
      filename: 'purchases.csv',
      columns: [
        { header: 'Bill #', get: (r: Purchase) => r.bill_number },
        { header: 'Supplier Bill #', get: (r: Purchase) => r.supplier_bill_number },
        { header: 'Date', get: (r: Purchase) => r.bill_date },
        {
          header: 'Supplier',
          get: (r: Purchase) => supplierById.get(r.supplier_id)?.name ?? r.supplier_id,
        },
        { header: 'Total', get: (r: Purchase) => (r.total_paise / 100).toFixed(2) },
        { header: 'Paid', get: (r: Purchase) => (r.paid_paise / 100).toFixed(2) },
        { header: 'Balance', get: (r: Purchase) => (r.balance_paise / 100).toFixed(2) },
        { header: 'Status', get: (r: Purchase) => r.status },
      ],
      rows: iterate(),
    });
  }

  async function openEdit(purchase: Purchase) {
    setSaveError(null);
    setEditingId(purchase.id);
    setSupplierId(purchase.supplier_id);
    setBillNumber(purchase.bill_number);
    setSupplierBillNumber(purchase.supplier_bill_number ?? '');
    setBillDate(purchase.bill_date);
    setNotes(purchase.notes ?? '');
    const purchaseLines = await db.purchase_lines
      .where('purchase_id')
      .equals(purchase.id)
      .toArray();
    purchaseLines.sort((a, b) => a.line_no - b.line_no);
    setLines(
      purchaseLines.map((l) => ({
        itemId: l.item_id,
        description: l.description ?? '',
        hsn: l.hsn ?? '',
        qty: String(l.qty_micros / 1_000_000),
        unitCostRupees: (l.unit_cost_paise / 100).toFixed(2),
        taxRatePct: (l.tax_rate_bps / 100).toString(),
      })),
    );
    setDrawerOpen(true);
  }

  function openNew() {
    setSaveError(null);
    setEditingId(null);
    setSupplierId('');
    // Naive but useful: PB-YYYYMMDD-HHMMSS. User can overwrite.
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setBillNumber(
      `PB-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(
        ts.getHours(),
      )}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`,
    );
    setSupplierBillNumber('');
    setBillDate(today());
    setNotes('');
    setLines([{ ...EMPTY_LINE }]);
    setDrawerOpen(true);
  }

  function updateLine(idx: number, patch: Partial<EditorLine>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function pickItem(idx: number, itemId: string) {
    const it = items.find((i) => i.id === itemId);
    if (!it) {
      updateLine(idx, { itemId: '' });
      return;
    }
    updateLine(idx, {
      itemId: it.id,
      description: it.name,
      hsn: it.hsn ?? '',
      unitCostRupees: (it.purchase_price_paise / 100).toFixed(2),
      taxRatePct: (it.tax_rate_bps / 100).toString(),
    });
  }

  function addLine() {
    setLines((ls) => [...ls, { ...EMPTY_LINE }]);
  }

  function removeLine(idx: number) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, i) => i !== idx)));
  }

  const subtotalPaise = lines.reduce((acc, l) => {
    return acc + Math.round(Number(l.qty) * Number(l.unitCostRupees) * 100);
  }, 0);
  const taxPaise = lines.reduce((acc, l) => {
    const base = Math.round(Number(l.qty) * Number(l.unitCostRupees) * 100);
    const bps = pctToBps(l.taxRatePct);
    return acc + Math.round((base * bps) / 10_000);
  }, 0);
  const totalPaise = subtotalPaise + taxPaise;

  async function save() {
    if (!businessId || !deviceId || !business) return;
    setSaving(true);
    setSaveError(null);
    try {
      const supplier = suppliers.find((s) => s.id === supplierId);
      if (!supplier) throw new Error('Please pick a supplier.');
      const wh = warehouses.find((w) => w.is_default === 1) ?? warehouses[0];
      if (!wh) throw new Error('No warehouse configured. Seed defaults from Settings.');
      if (billNumber.trim().length === 0) throw new Error('Bill number is required.');
      if (lines.length === 0 || lines.every((l) => !l.itemId)) {
        throw new Error('Add at least one line with an item.');
      }

      const acctByCode = new Map(accounts.map((a) => [a.code, a.id]));
      const req = (code: string) => {
        const id = acctByCode.get(code);
        if (!id) throw new Error(`Missing chart-of-accounts entry ${code}. Seed CoA from onboarding.`);
        return id;
      };

      const isInterstate =
        (business.state_code ?? '') !== '' &&
        (supplier.state_code ?? '') !== '' &&
        business.state_code !== supplier.state_code;

      const svc = createPurchaseService({ db });
      const payload = {
        businessId,
        deviceId,
        billNumber: billNumber.trim(),
        supplierBillNumber: supplierBillNumber.trim() || undefined,
        billDate,
        supplierId: supplier.id,
        supplierStateCode: supplier.state_code || business.state_code || '',
        isInterstate,
        financialYear: business.current_financial_year,
        notes,
        lines: lines
          .filter((l) => l.itemId)
          .map((l) => ({
            itemId: l.itemId,
            description: l.description,
            hsn: l.hsn,
            warehouseId: wh.id,
            qtyMicros: unitsToMicros(l.qty),
            unitCostPaise: rupeesToPaise(l.unitCostRupees),
            taxRateBps: pctToBps(l.taxRatePct),
          })),
        accounts: {
          purchases: req('5010'),
          inputCgst: req('1310'),
          inputSgst: req('1320'),
          inputIgst: req('1330'),
          inputCess: req('1340'),
          accountsPayable: req('2010'),
        },
      };
      if (editingId) {
        await svc.update(editingId, payload);
      } else {
        await svc.create(payload);
      }
      setDrawerOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
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
        <h1 className="text-xl font-semibold">Purchases</h1>
        <button
          type="button"
          onClick={openNew}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 hover:bg-slate-800"
        >
          New Purchase
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PurchaseStatus | '')}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1.5 text-slate-600">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(e) => setShowVoided(e.target.checked)}
          />
          <span>Show cancelled</span>
        </label>
      </div>

      <DataTable<Purchase>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[statusFilter, supplierFilter, reloadKey, showVoided]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search bill # / supplier"
        onExport={exportCsv}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editingId ? `Edit Purchase — ${billNumber}` : 'New Purchase'}
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
              disabled={saving || !supplierId || lines.every((l) => !l.itemId)}
              onClick={save}
              className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            <span className="block text-slate-700 mb-1">Supplier *</span>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5 bg-white"
            >
              <option value="">— Select supplier —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {suppliers.length === 0 && (
              <div className="mt-1 text-xs text-rose-600">
                No suppliers yet — <Link to="/suppliers" className="underline">add one</Link>.
              </div>
            )}
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Bill date *</span>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Bill # *</span>
            <input
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Supplier bill #</span>
            <input
              value={supplierBillNumber}
              onChange={(e) => setSupplierBillNumber(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5 h-14"
            />
          </label>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-700">Line items</h3>
            <button
              type="button"
              onClick={addLine}
              className="text-xs border border-slate-300 rounded px-2 py-1 hover:bg-slate-100"
            >
              + Add line
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((l, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 text-xs items-end border border-slate-200 rounded p-2"
              >
                <label className="col-span-4">
                  <span className="block text-slate-600 mb-0.5">Item</span>
                  <select
                    value={l.itemId}
                    onChange={(e) => pickItem(idx, e.target.value)}
                    className="w-full border border-slate-300 rounded px-1.5 py-1 bg-white"
                  >
                    <option value="">— pick —</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.sku} — {it.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="col-span-2">
                  <span className="block text-slate-600 mb-0.5">Qty</span>
                  <input
                    value={l.qty}
                    onChange={(e) => updateLine(idx, { qty: e.target.value })}
                    className="w-full border border-slate-300 rounded px-1.5 py-1 text-right"
                  />
                </label>
                <label className="col-span-2">
                  <span className="block text-slate-600 mb-0.5">Unit cost (₹)</span>
                  <input
                    value={l.unitCostRupees}
                    onChange={(e) => updateLine(idx, { unitCostRupees: e.target.value })}
                    className="w-full border border-slate-300 rounded px-1.5 py-1 text-right"
                  />
                </label>
                <label className="col-span-2">
                  <span className="block text-slate-600 mb-0.5">GST %</span>
                  <input
                    value={l.taxRatePct}
                    onChange={(e) => updateLine(idx, { taxRatePct: e.target.value })}
                    className="w-full border border-slate-300 rounded px-1.5 py-1 text-right"
                  />
                </label>
                <div className="col-span-1 text-right text-slate-700">
                  <Money paise={Math.round(Number(l.qty) * Number(l.unitCostRupees) * 100)} />
                </div>
                <div className="col-span-1 text-right">
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    className="text-rose-600 hover:underline disabled:opacity-40"
                    aria-label="Remove line"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-col items-end text-sm gap-1">
          <div>Subtotal: <Money paise={subtotalPaise} /></div>
          <div>GST: <Money paise={taxPaise} /></div>
          <div className="font-semibold">Total: <Money paise={totalPaise} /></div>
        </div>

        {saveError && (
          <div className="mt-3 text-sm text-rose-600 whitespace-pre-wrap">{saveError}</div>
        )}
      </Drawer>
    </div>
  );
}
