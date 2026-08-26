// §8 Low-Stock Alerts — the crossing detector + dispatch primitive.
//
// One tiny helper called by the Dexie `item_stock` write hook (see
// src/db/database.ts). No I/O beyond: (a) look up the item, (b) fire a
// window `CustomEvent` describing the crossing. Everything else — toast,
// notification list, sound — lives on the UI side listening for that
// event. Keeps stock-writing services untouched: they don't need to know
// alerts exist. LoB win.
//
// Threshold-crossing behaviour per spec §8:
//   * ALERT on `prev > reorder && new <= reorder`
//   * CLEAR on `prev <= reorder && new > reorder`
//   * No re-alert while still under reorder (55 → 50 alerts, 50 → 49 doesn't)
//
// Services / non-tracking items are skipped: item.is_service=1 or
// item.track_inventory=0. reorder_level_micros=0 also skips — treating
// "no threshold set" as "no alerts" (a 0 threshold would otherwise fire
// on every OOS event, which is desirable spec-wise but only if the user
// deliberately set it to 0; opt-in via non-zero).

import type { BusinessVaultDB } from '../db/database';
import type { Item } from '../db/types';
import { log } from '../lib/log';

export const LOW_STOCK_EVENT_NAME = 'bv:low-stock';

export type LowStockKind = 'crossed_below' | 'cleared';

export interface LowStockPayload {
  kind: LowStockKind;
  businessId: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  unitLabel: string;
  currentQtyMicros: number;
  reorderLevelMicros: number;
  isOutOfStock: boolean; // currentQty <= 0
  occurredAt: string; // ISO
}

interface DetectArgs {
  businessId: string;
  itemId: string;
  warehouseId: string;
  prevWarehouseQtyMicros: number;
  newWarehouseQtyMicros: number;
}

/**
 * Called AFTER an item_stock row is committed. Computes the cross-warehouse
 * total delta and, if the aggregate crossed the reorder threshold in either
 * direction, dispatches a low-stock event. Any thrown error is logged and
 * swallowed — an alert failure must never break the transaction whose
 * commit we hooked into.
 */
export async function detectAndDispatchLowStock(
  db: BusinessVaultDB,
  args: DetectArgs,
): Promise<void> {
  try {
    const item = await db.items.get(args.itemId);
    if (!item) return;
    // Skip services / non-tracked items outright.
    if (item.is_service === 1 || item.track_inventory !== 1) return;
    // A zero reorder threshold means "unset" — opt-in only.
    if (!item.reorder_level_micros || item.reorder_level_micros <= 0) return;

    // The hook only knows this ONE warehouse's before/after. To decide
    // crossing we need the cross-warehouse total. Read the rest of the
    // per-warehouse rows for this item and add THIS warehouse's before and
    // after. This runs post-commit so it sees the new row for the current
    // warehouse — hence we subtract new + add prev to synthesise the old
    // total, and use the current sum as the new total.
    // No compound [business_id+item_id] index exists (only
    // [business_id+item_id+warehouse_id]), so scan business rows and filter
    // by item_id — item_stock is bounded by item_count × warehouse_count,
    // which is small for a POS-scale business.
    const rows = await db.item_stock
      .where('business_id')
      .equals(args.businessId)
      .and((r) => r.item_id === args.itemId)
      .toArray();
    let newTotal = 0;
    for (const r of rows) newTotal += r.qty_micros;
    const prevTotal = newTotal - args.newWarehouseQtyMicros + args.prevWarehouseQtyMicros;

    const reorder = item.reorder_level_micros;
    const crossedBelow = prevTotal > reorder && newTotal <= reorder;
    const cleared = prevTotal <= reorder && newTotal > reorder;
    if (!crossedBelow && !cleared) return;

    const unit = item.unit_id ? await db.units.get(item.unit_id) : undefined;
    const payload: LowStockPayload = {
      kind: crossedBelow ? 'crossed_below' : 'cleared',
      businessId: args.businessId,
      itemId: args.itemId,
      itemName: item.name,
      itemSku: item.sku,
      unitLabel: unit?.code ?? unit?.name ?? '',
      currentQtyMicros: newTotal,
      reorderLevelMicros: reorder,
      isOutOfStock: newTotal <= 0,
      occurredAt: new Date().toISOString(),
    };
    log.info('lowStock', 'threshold crossing detected', {
      kind: payload.kind,
      itemId: payload.itemId,
      itemName: payload.itemName,
      prevTotalMicros: prevTotal,
      newTotalMicros: newTotal,
      reorderLevelMicros: reorder,
    });
    dispatchLowStock(payload);
  } catch (e) {
    log.error('lowStock', 'detection failed', {
      itemId: args.itemId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function dispatchLowStock(payload: LowStockPayload): void {
  // window is undefined on the initial SSR-style module load path in
  // certain Vitest configurations; guard so tests don't blow up.
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<LowStockPayload>(LOW_STOCK_EVENT_NAME, { detail: payload }),
  );
}

/**
 * Test hook: exported so the Settings > Test Sound button and unit tests
 * can synthesise a fake crossing event without touching Dexie. Fires the
 * SAME event the production path fires, so listeners exercise the whole
 * downstream shape.
 */
export function _testDispatch(payload: LowStockPayload): void {
  dispatchLowStock(payload);
}

// Look up an Item by id and synthesise a low-stock payload from its
// current state. Used by "Test Sound" and by the NotificationProvider
// backfill when the user re-enables alerts and wants to see currently-low
// items. Returns null if the item doesn't exist / isn't tracked / has no
// reorder threshold — same skip rules as the detector.
export async function loadCurrentLowStockSnapshot(
  db: BusinessVaultDB,
  businessId: string,
  itemId: string,
): Promise<LowStockPayload | null> {
  const item: Item | undefined = await db.items.get(itemId);
  if (!item) return null;
  if (item.is_service === 1 || item.track_inventory !== 1) return null;
  if (!item.reorder_level_micros || item.reorder_level_micros <= 0) return null;
  const rows = await db.item_stock
    .where('business_id')
    .equals(businessId)
    .and((r) => r.item_id === itemId)
    .toArray();
  let total = 0;
  for (const r of rows) total += r.qty_micros;
  if (total > item.reorder_level_micros) return null;
  const unit = item.unit_id ? await db.units.get(item.unit_id) : undefined;
  return {
    kind: 'crossed_below',
    businessId,
    itemId,
    itemName: item.name,
    itemSku: item.sku,
    unitLabel: unit?.code ?? unit?.name ?? '',
    currentQtyMicros: total,
    reorderLevelMicros: item.reorder_level_micros,
    isOutOfStock: total <= 0,
    occurredAt: new Date().toISOString(),
  };
}
