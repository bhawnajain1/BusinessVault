import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { db } from '../../db';
import type {
  Account,
  Business,
  Item,
  Purchase,
  PurchaseStatus,
  Supplier,
  Warehouse,
  GstLineSnapshot,
} from '../../db/types';
import { createPurchaseService } from '../../domain/PurchaseService';
import { bankersRound } from '../../domain/gst';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Drawer from '../components/Drawer';
import Money from '../components/Money';
import StatusBadge from '../components/StatusBadge';
import { paginateCollection, matchesText } from '../components/pagination';
import { addDaysYmd } from '../../lib/date';
import { log } from '../../lib/log';

const STATUSES: PurchaseStatus[] = ['draft', 'received', 'partial', 'paid', 'cancelled'];

interface EditorLine extends GstLineSnapshot {
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
  const navigate = useNavigate();
  const location = useLocation();
  const isNewRoute = location.pathname === '/purchases/new';
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
  const [drawerOpen, setDrawerOpen] = useState(isNewRoute);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [supplierBillNumber, setSupplierBillNumber] = useState('');
  const [billDate, setBillDate] = useState<string>(today());
  const [dueDate, setDueDate] = useState<string>(() => addDaysYmd(today(), 15));
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
          <span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openEdit(r);
              }}
              className="action-edit text-xs"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void cancelPurchase(r);
              }}
              className="action-cancel ml-2 text-xs"
            >
              Cancel
            </button>
          </span>
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
    setDueDate(purchase.due_date ?? addDaysYmd(purchase.bill_date, 15));
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
        uqc_code: l.uqc_code,
        goods_or_service: l.goods_or_service,
        taxability: l.taxability,
        cess_rate_bps: l.cess_rate_bps,
        qty: String(l.qty_micros / 1_000_000),
        unitCostRupees: (l.unit_cost_paise / 100).toFixed(2),
        taxRatePct: (l.tax_rate_bps / 100).toString(),
      })),
    );
    navigate('/purchases/new');
  }

  async function cancelPurchase(purchase: Purchase) {
    if (!deviceId) return;
    if (!window.confirm(`Cancel bill ${purchase.bill_number}? Its accounting and stock entries will be reversed.`)) return;
    setSaveError(null);
    try {
      await createPurchaseService({ db }).cancel(purchase.id, deviceId);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
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
    const newBillDate = today();
    setBillDate(newBillDate);
    setDueDate(addDaysYmd(newBillDate, 15));
    setNotes('');
    setLines([{ ...EMPTY_LINE }]);
    navigate('/purchases/new');
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
      uqc_code: undefined,
      goods_or_service: it.is_service ? 'SERVICE' : 'GOODS',
      taxability: null,
      cess_rate_bps: it.cess_rate_bps ?? 0,
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
    return acc + bankersRound(unitsToMicros(l.qty) * rupeesToPaise(l.unitCostRupees) / 1_000_000);
  }, 0);
  const taxPaise = lines.reduce((acc, l) => {
    const base = bankersRound(unitsToMicros(l.qty) * rupeesToPaise(l.unitCostRupees) / 1_000_000);
    const bps = pctToBps(l.taxRatePct);
    return acc + bankersRound((base * bps) / 10_000);
  }, 0);
  const cessPaise = lines.reduce((sum, l) => {
    const base = bankersRound(unitsToMicros(l.qty) * rupeesToPaise(l.unitCostRupees) / 1_000_000);
    return sum + bankersRound(base * (l.cess_rate_bps ?? 0) / 10_000);
  }, 0);
  const totalPaise = subtotalPaise + taxPaise + cessPaise;

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
        dueDate: dueDate || null,
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
            uqcCode: l.uqc_code,
            goodsOrService: l.goods_or_service,
            taxability: l.taxability,
            cessRateBps: l.cess_rate_bps ?? undefined,
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
      log.info('purchases', 'saving purchase with due date', {
        businessId,
        editingId,
        billDate,
        dueDate: dueDate || null,
        defaulted: !editingId && dueDate === addDaysYmd(billDate, 15),
      });
      if (editingId) {
        await svc.update(editingId, payload);
      } else {
        await svc.create(payload);
      }
      if (isNewRoute) navigate('/purchases');
      else setDrawerOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
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
        <h1 className="text-xl font-semibold text-fg">Purchases</h1>
        <button
          type="button"
          onClick={openNew}
          className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90"
        >
          New Purchase
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PurchaseStatus | '')}
          className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
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
          className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
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
        open={drawerOpen || isNewRoute}
        onClose={() => (isNewRoute ? navigate('/purchases') : setDrawerOpen(false))}
        fullPage={isNewRoute}
        showFullPageBack={false}
        title={editingId ? `Edit Purchase — ${billNumber}` : 'New Purchase'}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => (isNewRoute ? navigate('/purchases') : setDrawerOpen(false))}
              className="action-cancel h-8 text-[13px]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !supplierId || lines.every((l) => !l.itemId)}
              onClick={save}
              className="h-8 rounded-md bg-green-600 px-3 text-[13px] font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Purchase'}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Supplier *</span>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— Select supplier —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {suppliers.length === 0 && (
              <div className="mt-1 text-xs text-danger">
                No suppliers yet — <Link to="/suppliers" className="underline">add one</Link>.
              </div>
            )}
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Bill date *</span>
            <input
              type="date"
              value={billDate}
              onChange={(e) => {
                const next = e.target.value;
                setBillDate(next);
                if (!editingId) setDueDate(addDaysYmd(next, 15));
              }}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Bill # *</span>
            <input
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label>
            <span className="block text-[12px] text-fg-muted mb-1">Supplier bill #</span>
            <input
              value={supplierBillNumber}
              onChange={(e) => setSupplierBillNumber(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-[12px] text-fg-muted mb-1">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg h-14 focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-fg">Line items</h3>
            <button
              type="button"
              onClick={addLine}
              className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg-muted hover:text-fg hover:bg-surface-hover"
            >
              + Add line
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((l, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 text-xs items-end border border-border rounded-md p-2 bg-surface"
              >
                <label className="col-span-4">
                  <span className="block text-[12px] text-fg-muted mb-0.5">Item</span>
                  <select
                    value={l.itemId}
                    onChange={(e) => pickItem(idx, e.target.value)}
                    className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
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
                  <span className="block text-[12px] text-fg-muted mb-0.5">Qty</span>
                  <input
                    value={l.qty}
                    onChange={(e) => updateLine(idx, { qty: e.target.value })}
                    className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
                <label className="col-span-2">
                  <span className="block text-[12px] text-fg-muted mb-0.5">Unit cost (₹)</span>
                  <input
                    value={l.unitCostRupees}
                    onChange={(e) => updateLine(idx, { unitCostRupees: e.target.value })}
                    className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
                <label className="col-span-2">
                  <span className="block text-[12px] text-fg-muted mb-0.5">GST %</span>
                  <input
                    value={l.taxRatePct}
                    onChange={(e) => updateLine(idx, { taxRatePct: e.target.value })}
                    className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg text-right focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
                <div className="col-span-1 text-right text-fg">
                  <Money paise={Math.round(Number(l.qty) * Number(l.unitCostRupees) * 100)} />
                </div>
                <label className="col-span-12 sm:col-span-4">
                  <span className="block text-[12px] text-fg-muted mb-0.5">GST taxability (explicit classification)</span>
                  <select value={l.taxability ?? ''} onChange={(e) => updateLine(idx, { taxability: e.target.value as GstLineSnapshot['taxability'] || null })} className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg">
                    <option value="">Unspecified (zero rate needs review)</option>
                    {['TAXABLE', 'ZERO_RATED', 'NIL_RATED', 'EXEMPT', 'NON_GST'].map((value) => <option key={value}>{value}</option>)}
                  </select>
                </label>
                <label className="col-span-12 sm:col-span-2">
                  <span className="block text-[12px] text-fg-muted mb-0.5">Cess %</span>
                  <input type="number" min="0" step="0.01" value={(l.cess_rate_bps ?? 0) / 100} onChange={e => updateLine(idx, { cess_rate_bps: Math.max(0, Math.round(Number(e.target.value) * 100)) })} className="w-full h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-fg" />
                </label>
                <div className="col-span-1 text-right">
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    className="text-danger hover:underline disabled:opacity-40"
                    aria-label="Remove line"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-col items-end text-sm gap-1 text-fg">
          <div>Subtotal: <Money paise={subtotalPaise} /></div>
          <div>GST: <Money paise={taxPaise} /></div>
          <div>Cess: <Money paise={cessPaise} /></div>
          <div className="font-semibold">Total: <Money paise={totalPaise} /></div>
        </div>

        {saveError && (
          <div className="mt-3 text-sm text-danger whitespace-pre-wrap">{saveError}</div>
        )}
      </Drawer>
    </div>
  );
}
