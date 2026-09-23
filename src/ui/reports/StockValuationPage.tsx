import { useEffect, useMemo, useState } from 'react';
import { db } from '../../db';
import type { Item, ItemStock, Warehouse } from '../../db/types';
import { downloadCsv } from '../../csv/streamCsvExport';
import { money } from './reportUtils';
import { useBusinessId } from './useBusinessId';
import { ReportTableToolbar, useReportTableControls } from './reportTableControls';

interface Row {
  item_id: string;
  sku: string;
  name: string;
  warehouse_name: string;
  qty: number;
  avg_cost_paise: number;
  value_paise: number;
}

export default function StockValuationPage() {
  const { businessId, error: bizError } = useBusinessId();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const items: Item[] = await db.items.where('business_id').equals(businessId).toArray();
        const stocks: ItemStock[] = await db.item_stock.where('business_id').equals(businessId).toArray();
        const warehouses: Warehouse[] = await db.warehouses.where('business_id').equals(businessId).toArray();
        const itemById = new Map(items.map((i) => [i.id, i]));
        const whById = new Map(warehouses.map((w) => [w.id, w]));

        const out: Row[] = [];
        for (const s of stocks) {
          const it = itemById.get(s.item_id);
          if (!it || !it.track_inventory) continue;
          const qty = s.qty_micros / 1_000_000;
          // value_paise = qty_micros * avg_cost_paise / 1_000_000, rounded to nearest paise
          const valueRaw = (s.qty_micros * s.avg_cost_paise) / 1_000_000;
          const value_paise = Math.round(valueRaw);
          out.push({
            item_id: s.item_id,
            sku: it.sku,
            name: it.name,
            warehouse_name: whById.get(s.warehouse_id)?.name ?? s.warehouse_id,
            qty,
            avg_cost_paise: s.avg_cost_paise,
            value_paise,
          });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        if (alive) setRows(out);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [businessId]);

  const controls = useReportTableControls(
    rows,
    (r) => `${r.name} ${r.sku} ${r.warehouse_name}`,
    (r, key) => key === 'value' ? r.value_paise : key === 'quantity' ? r.qty : key === 'cost' ? r.avg_cost_paise : key === 'warehouse' ? r.warehouse_name : r.name,
    { key: 'name', direction: 'asc' },
  );
  const filtered = controls.filteredRows;

  const totalValue = useMemo(() => filtered.reduce((s, r) => s + r.value_paise, 0), [filtered]);
  const totalQty = useMemo(() => filtered.reduce((s, r) => s + r.qty, 0), [filtered]);

  async function exportCsv(): Promise<void> {
    await downloadCsv({
      columns: ['sku', 'name', 'warehouse', 'quantity', 'avg_cost', 'value'],
      rows: filtered,
      toRow: (r) => ({
        sku: r.sku,
        name: r.name,
        warehouse: r.warehouse_name,
        quantity: r.qty.toFixed(6).replace(/\.?0+$/, '') || '0',
        avg_cost: (r.avg_cost_paise / 100).toFixed(2),
        value: (r.value_paise / 100).toFixed(2),
      }),
      filename: `stock-valuation-${new Date().toISOString().slice(0, 10)}.csv`,
    });
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Stock Valuation</h1>
          <p className="text-sm text-slate-500">Per-item quantities and value at weighted-average cost.</p>
        </div>
        <div className="flex items-end gap-2">
          <ReportTableToolbar query={controls.query} onQueryChange={controls.setQuery} sort={controls.sort} onSortChange={controls.setSort} options={[{ key: 'name', label: 'Item' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'quantity', label: 'Quantity' }, { key: 'cost', label: 'Avg cost' }, { key: 'value', label: 'Value' }]} />
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="border border-slate-300 rounded px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {bizError && <div className="text-red-600 text-sm">{bizError}</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading...</div>}

      <div className="overflow-auto border border-slate-200 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">SKU</th>
              <th className="text-left px-3 py-2">Item</th>
              <th className="text-left px-3 py-2">Warehouse</th>
              <th className="text-right px-3 py-2">Quantity</th>
              <th className="text-right px-3 py-2">Avg Cost</th>
              <th className="text-right px-3 py-2">Value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={`${r.item_id}:${r.warehouse_name}`} className="border-t border-slate-100">
                <td className="px-3 py-1.5 font-mono text-xs">{r.sku}</td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5">{r.warehouse_name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.qty.toLocaleString('en-IN', { maximumFractionDigits: 6 })}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.avg_cost_paise)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(r.value_paise)}</td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                  No stock records.
                </td>
              </tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="bg-slate-50 font-semibold">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right">Totals</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {totalQty.toLocaleString('en-IN', { maximumFractionDigits: 6 })}
                </td>
                <td />
                <td className="px-3 py-2 text-right tabular-nums">{money(totalValue)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
