import { useCallback, useEffect, useState } from 'react';
import { db } from '../../db';
import type { Item, StockMovement, Warehouse } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';
import DataTable, { type ColumnDef } from '../components/DataTable';
import Money from '../components/Money';
import { paginateCollection, matchesText } from '../components/pagination';
import { DateTimeCell } from '../components/DateTime';

const MOVEMENT_TYPES = [
  'purchase',
  'sale',
  'adjustment',
  'transfer',
  'sale_return',
  'purchase_return',
  'opening',
] as const;

function fmtQty(microQty: number): string {
  return (microQty / 1_000_000).toFixed(3).replace(/\.?0+$/, '');
}

export default function StockMovements() {
  const { businessId, loading } = useActiveBusiness();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [itemById, setItemById] = useState<Map<string, Item>>(new Map());
  const [warehouseById, setWarehouseById] = useState<Map<string, Warehouse>>(new Map());
  const [warehouseFilter, setWarehouseFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const [ws, items] = await Promise.all([
        db.warehouses.where('business_id').equals(businessId).toArray(),
        db.items.where('business_id').equals(businessId).toArray(),
      ]);
      setWarehouses(ws);
      setWarehouseById(new Map(ws.map((w) => [w.id, w])));
      setItemById(new Map(items.map((i) => [i.id, i])));
    })();
  }, [businessId]);

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
        let c = db.stock_movements.where('business_id').equals(businessId).reverse();
        c = c.filter((m) => {
          if (warehouseFilter && m.warehouse_id !== warehouseFilter) return false;
          if (typeFilter && m.movement_type !== typeFilter) return false;
          if (search || filters.item || filters.ref) {
            const itemName = itemById.get(m.item_id)?.name ?? '';
            if (
              search &&
              !(
                matchesText(itemName, search) ||
                matchesText(m.ref_id, search) ||
                matchesText(m.notes, search)
              )
            ) {
              return false;
            }
            if (filters.item && !matchesText(itemName, filters.item)) return false;
            if (filters.ref && !matchesText(m.ref_id, filters.ref)) return false;
          }
          return true;
        });
        return c;
      };
      return paginateCollection<StockMovement>(makeCol, offset, limit);
    },
    [businessId, warehouseFilter, typeFilter, itemById],
  );

  const columns: ColumnDef<StockMovement>[] = [
    // Invoice-driven movements store only a date, so show it as-is.
    { key: 'occurred_at', header: 'Created', sortValue: (r) => r.occurred_at, render: (r) => (r.occurred_at.length > 10 ? <DateTimeCell iso={r.occurred_at} /> : r.occurred_at) },
    {
      key: 'item',
      header: 'Item',
      filterable: true,
      render: (r) => itemById.get(r.item_id)?.name ?? r.item_id,
    },
    {
      key: 'warehouse',
      header: 'Warehouse',
      render: (r) => warehouseById.get(r.warehouse_id)?.name ?? r.warehouse_id,
    },
    { key: 'type', header: 'Type', render: (r) => r.movement_type },
    {
      key: 'qty',
      header: 'Qty',
      className: 'text-right',
      render: (r) => (
        <span className={r.qty_micros < 0 ? 'text-rose-700' : ''}>{fmtQty(r.qty_micros)}</span>
      ),
    },
    {
      key: 'unit_cost',
      header: 'Unit Cost',
      className: 'text-right',
      render: (r) => <Money paise={r.unit_cost_paise} />,
    },
    { key: 'ref_type', header: 'Ref Type', render: (r) => r.ref_type },
    { key: 'ref', header: 'Ref #', filterable: true, render: (r) => r.ref_id.slice(0, 12) },
    { key: 'notes', header: 'Notes', render: (r) => r.notes },
  ];

  if (loading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId) return <div className="p-6 text-slate-600">No active business.</div>;

  return (
    <div className="p-6 flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Stock Movements</h1>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={warehouseFilter}
          onChange={(e) => setWarehouseFilter(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5"
        >
          <option value="">All types</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <DataTable<StockMovement>
        columns={columns}
        fetchPage={fetchPage}
        fetchPageDeps={[warehouseFilter, typeFilter]}
        rowKey={(r) => r.id}
        searchPlaceholder="Search item / ref / notes"
      />
    </div>
  );
}
