// §8 integration test — exercises the item_stock Dexie hook path in
// database.ts. Where lowStockAlerts.test.ts calls the detector directly,
// this file writes actual item_stock rows and asserts the crossing event
// fires on transaction commit. This is the path every production writer
// (InventoryService, InvoiceService, PurchaseService, SalesReturnService)
// goes through.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { BusinessVaultDB } from './database';
import type { Item, ItemStock, Unit } from './types';
import {
  LOW_STOCK_EVENT_NAME,
  type LowStockPayload,
} from '../domain/lowStockAlerts';

let db: BusinessVaultDB;

const businessId = '01BIZ';
const itemId = '01ITEM';
const unitId = '01UNIT';
const whA = '01WHA';
const whB = '01WHB';

async function seedItem(overrides: Partial<Item> = {}): Promise<void> {
  const now = new Date().toISOString();
  const unit: Unit = {
    id: unitId,
    business_id: businessId,
    code: 'PCS',
    name: 'Pieces',
    decimal_places: 0,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.units.put(unit);
  const item: Item = {
    id: itemId,
    business_id: businessId,
    sku: 'SKU1',
    name: 'Widget',
    description: '',
    hsn: '',
    category_id: null,
    unit_id: unitId,
    sale_price_paise: 10000,
    purchase_price_paise: 5000,
    tax_rate_bps: 1800,
    cess_rate_bps: 0,
    is_service: 0,
    track_inventory: 1,
    opening_qty_micros: 0,
    opening_value_paise: 0,
    reorder_level_micros: 50_000_000,
    barcode: null,
    image_ref: null,
    active: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
    ...overrides,
  };
  await db.items.put(item);
}

function stockRow(warehouseId: string, qty: number): ItemStock {
  return {
    id: `${businessId}:${itemId}:${warehouseId}`,
    business_id: businessId,
    item_id: itemId,
    warehouse_id: warehouseId,
    qty_micros: qty,
    avg_cost_paise: 5000,
    updated_at: new Date().toISOString(),
  };
}

function waitForEvents(count: number, timeoutMs = 200): Promise<LowStockPayload[]> {
  return new Promise((resolve) => {
    const seen: LowStockPayload[] = [];
    const handler = (evt: Event) => {
      seen.push((evt as CustomEvent<LowStockPayload>).detail);
      if (seen.length >= count) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      window.removeEventListener(LOW_STOCK_EVENT_NAME, handler as EventListener);
      resolve(seen);
    }
    window.addEventListener(LOW_STOCK_EVENT_NAME, handler as EventListener);
  });
}

describe('§8 item_stock Dexie hook — hook-driven crossing detection', () => {
  beforeEach(async () => {
    db = new BusinessVaultDB(`bv-hook-${Math.random().toString(36).slice(2)}`);
    await db.open();
    await seedItem();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 15));
    db.close();
  });

  it('fires crossed_below when a single-WH update pulls stock below reorder', async () => {
    await db.item_stock.put(stockRow(whA, 55_000_000));
    // Above-threshold seed shouldn't fire (0 → 55 is a "cleared", but starts
    // below and goes above → cleared IS the expected fire on the seed).
    // Drain any pending events before the assertion by waiting a tick.
    await new Promise((r) => setTimeout(r, 10));

    const events = waitForEvents(1, 150);
    await db.item_stock.update(stockRow(whA, 55_000_000).id, {
      qty_micros: 45_000_000,
    });
    const got = await events;
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe('crossed_below');
    expect(got[0].currentQtyMicros).toBe(45_000_000);
    expect(got[0].itemId).toBe(itemId);
  });

  it('dedupes multi-WH writes in a single tx (one alert, not two)', async () => {
    // Seed both warehouses ABOVE threshold in isolation (won't cross).
    await db.item_stock.put(stockRow(whA, 40_000_000));
    await db.item_stock.put(stockRow(whB, 20_000_000));
    // Total is 60 → above 50 threshold; last fire was "cleared" past
    // threshold. Drain.
    await new Promise((r) => setTimeout(r, 10));

    // One tx that touches both warehouses. Pre: 40+20=60. Post: 20+10=30 →
    // crossed_below. Historically two hook fires; new aggregate keys by
    // itemId so only ONE event.
    const events = waitForEvents(2, 150);
    await db.transaction('rw', db.item_stock, async () => {
      await db.item_stock.update(stockRow(whA, 0).id, { qty_micros: 20_000_000 });
      await db.item_stock.update(stockRow(whB, 0).id, { qty_micros: 10_000_000 });
    });
    const got = await events;
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe('crossed_below');
    expect(got[0].currentQtyMicros).toBe(30_000_000);
  });

  it('does not fire during a restore (__bvSuppressLowStock=true)', async () => {
    // Simulate the flag rebuildFromDrive sets around bulk restore.
    (db as unknown as { __bvSuppressLowStock: boolean }).__bvSuppressLowStock = true;
    try {
      const events = waitForEvents(1, 80);
      await db.item_stock.put(stockRow(whA, 30_000_000));
      const got = await events;
      expect(got.length).toBe(0);
    } finally {
      (db as unknown as { __bvSuppressLowStock: boolean }).__bvSuppressLowStock = false;
    }
  });

  it('fires cleared when a WH update pushes stock back above reorder', async () => {
    await db.item_stock.put(stockRow(whA, 30_000_000));
    // Draining: the seed put itself is a 0→30 write that stays below
    // threshold, so no cross-threshold event fires. Skip drain wait.

    const events = waitForEvents(1, 150);
    await db.item_stock.update(stockRow(whA, 30_000_000).id, {
      qty_micros: 70_000_000,
    });
    const got = await events;
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe('cleared');
    expect(got[0].currentQtyMicros).toBe(70_000_000);
  });
});
