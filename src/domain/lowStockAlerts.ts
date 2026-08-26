// §8 Low-Stock Alerts — the crossing detector + dispatch primitive.
//
// The Dexie hook in src/db/database.ts computes cross-warehouse
// prevTotal / currentTotal for each affected item INSIDE the transaction
// (so the values are immune to follow-up-tx races) and then calls
// `dispatchLowStockForTotals` here on tx commit. This module only does:
//   (a) skip-rules gate (services / non-tracked / unset threshold),
//   (b) item + unit metadata lookup for the payload,
//   (c) window CustomEvent dispatch.
//
// Everything else — toast, notification list, sound — lives on the UI
// side listening for the event. Keeps stock-writing services untouched.
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

export interface LowStockTotals {
  businessId: string;
  itemId: string;
  prevTotal: number; // cross-warehouse sum BEFORE the tx started
  currentTotal: number; // cross-warehouse sum AFTER the tx committed
}

/**
 * Called from the item_stock Dexie hook on tx commit. Totals are already
 * cross-warehouse-summed at hook time — this function only does the item
 * lookup + skip rules + dispatch. Any thrown error is logged and swallowed
 * — an alert failure must never break the transaction whose commit we
 * hooked into.
 */
export async function dispatchLowStockForTotals(
  db: BusinessVaultDB,
  totals: LowStockTotals,
): Promise<void> {
  try {
    const item = await db.items.get(totals.itemId);
    if (!item) return;
    if (item.is_service === 1 || item.track_inventory !== 1) return;
    if (!item.reorder_level_micros || item.reorder_level_micros <= 0) return;

    const reorder = item.reorder_level_micros;
    const crossedBelow = totals.prevTotal > reorder && totals.currentTotal <= reorder;
    const cleared = totals.prevTotal <= reorder && totals.currentTotal > reorder;
    if (!crossedBelow && !cleared) return;

    const unit = item.unit_id ? await db.units.get(item.unit_id) : undefined;
    const payload: LowStockPayload = {
      kind: crossedBelow ? 'crossed_below' : 'cleared',
      businessId: totals.businessId,
      itemId: totals.itemId,
      itemName: item.name,
      itemSku: item.sku,
      unitLabel: unit?.code ?? unit?.name ?? '',
      currentQtyMicros: totals.currentTotal,
      reorderLevelMicros: reorder,
      isOutOfStock: totals.currentTotal <= 0,
      occurredAt: new Date().toISOString(),
    };
    log.info('lowStock', 'threshold crossing detected', {
      kind: payload.kind,
      itemId: payload.itemId,
      itemName: payload.itemName,
      prevTotalMicros: totals.prevTotal,
      newTotalMicros: totals.currentTotal,
      reorderLevelMicros: reorder,
    });
    dispatchLowStock(payload);
  } catch (e) {
    log.error('lowStock', 'detection failed', {
      itemId: totals.itemId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function dispatchLowStock(payload: LowStockPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<LowStockPayload>(LOW_STOCK_EVENT_NAME, { detail: payload }),
  );
}

/**
 * Test hook: exported so unit tests can synthesise a fake crossing event
 * without touching Dexie. Fires the SAME event the production path fires,
 * so listeners exercise the whole downstream shape.
 */
export function _testDispatch(payload: LowStockPayload): void {
  dispatchLowStock(payload);
}

export interface LowStockDetectArgs {
  businessId: string;
  itemId: string;
  warehouseId: string;
  prevWarehouseQtyMicros: number;
  newWarehouseQtyMicros: number;
}

/**
 * Compatibility entry point for tests and any caller that already knows the
 * pre-tx and post-tx qty for one specific warehouse row. Reads the CURRENT
 * per-warehouse rows for the item (which reflect the post-write state)
 * except the touched warehouse, adds this row's prev/new qty to synthesise
 * cross-warehouse totals, then delegates to `dispatchLowStockForTotals`.
 *
 * NOTE: production `item_stock` writes go through the Dexie hook path in
 * database.ts, which computes totals inside the tx — this function is a
 * best-effort synthesiser used only outside a tx (e.g. test drivers).
 */
export async function detectAndDispatchLowStock(
  db: BusinessVaultDB,
  args: LowStockDetectArgs,
): Promise<void> {
  try {
    const otherRows = await db.item_stock
      .where('business_id')
      .equals(args.businessId)
      .and((r) => r.item_id === args.itemId && r.warehouse_id !== args.warehouseId)
      .toArray();
    let others = 0;
    for (const r of otherRows) others += r.qty_micros;
    await dispatchLowStockForTotals(db, {
      businessId: args.businessId,
      itemId: args.itemId,
      prevTotal: others + args.prevWarehouseQtyMicros,
      currentTotal: others + args.newWarehouseQtyMicros,
    });
  } catch (e) {
    log.error('lowStock', 'detection failed', {
      itemId: args.itemId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Look up an Item by id and synthesise a low-stock payload from its
 * CURRENT state (cross-warehouse sum vs reorder threshold). Used by
 * point-in-time checks; returns null when the item doesn't exist, isn't
 * tracked, has no threshold, or currently sits above threshold.
 */
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
