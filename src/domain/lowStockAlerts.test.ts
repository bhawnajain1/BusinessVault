import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { BusinessVaultDB } from '../db/database';
import type { Item, ItemStock, Unit } from '../db/types';
import {
  LOW_STOCK_EVENT_NAME,
  detectAndDispatchLowStock,
  loadCurrentLowStockSnapshot,
  type LowStockPayload,
} from './lowStockAlerts';

let db: BusinessVaultDB;

const businessId = '01BUSINESSLS';
const itemId = '01ITEMLS';
const warehouseId = '01WHLS';
const unitId = '01UNITLS';

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
    name: 'Jumbo Box',
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
    reorder_level_micros: 50_000_000, // 50 units
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

async function seedStock(qtyMicros: number, warehouseSuffix = ''): Promise<void> {
  const wid = warehouseId + warehouseSuffix;
  const row: ItemStock = {
    id: `${businessId}:${itemId}:${wid}`,
    business_id: businessId,
    item_id: itemId,
    warehouse_id: wid,
    qty_micros: qtyMicros,
    avg_cost_paise: 5000,
    updated_at: new Date().toISOString(),
  };
  await db.item_stock.put(row);
}

function captureEvent(): Promise<LowStockPayload | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener(LOW_STOCK_EVENT_NAME, handler as EventListener);
      resolve(null);
    }, 50);
    const handler = (evt: Event) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener(LOW_STOCK_EVENT_NAME, handler as EventListener);
      resolve((evt as CustomEvent<LowStockPayload>).detail);
    };
    window.addEventListener(LOW_STOCK_EVENT_NAME, handler as EventListener);
  });
}

describe('§8 detectAndDispatchLowStock', () => {
  beforeEach(async () => {
    db = new BusinessVaultDB(`bv-lowstock-${Math.random().toString(36).slice(2)}`);
    await db.open();
    await seedItem();
  });

  afterEach(async () => {
    // Let any queued microtasks flush before closing so we don't see a
    // spurious "Database closed" from a still-in-flight detector call
    // that raced past the test's captureEvent window.
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.close();
  });

  it('fires crossed_below when total crosses from above to below reorder', async () => {
    // Post-state 45; the hook synthesises prev-per-wh 55, next-per-wh 45.
    await seedStock(45_000_000);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 55_000_000,
      newWarehouseQtyMicros: 45_000_000,
    });
    const evt = await eventPromise;
    expect(evt).not.toBeNull();
    expect(evt?.kind).toBe('crossed_below');
    expect(evt?.currentQtyMicros).toBe(45_000_000);
    expect(evt?.reorderLevelMicros).toBe(50_000_000);
    expect(evt?.isOutOfStock).toBe(false);
    expect(evt?.itemName).toBe('Jumbo Box');
    expect(evt?.unitLabel).toBe('PCS');
  });

  it('does not re-fire while stock stays below reorder (50→49 silent)', async () => {
    await seedStock(49_000_000);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 50_000_000,
      newWarehouseQtyMicros: 49_000_000,
    });
    expect(await eventPromise).toBeNull();
  });

  it('fires cleared when total crosses back above reorder', async () => {
    await seedStock(60_000_000);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 40_000_000,
      newWarehouseQtyMicros: 60_000_000,
    });
    const evt = await eventPromise;
    expect(evt?.kind).toBe('cleared');
  });

  it('marks isOutOfStock when total lands at or below zero', async () => {
    await seedStock(0);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 55_000_000,
      newWarehouseQtyMicros: 0,
    });
    const evt = await eventPromise;
    expect(evt?.kind).toBe('crossed_below');
    expect(evt?.isOutOfStock).toBe(true);
  });

  it('skips services (is_service=1)', async () => {
    await seedItem({ is_service: 1 });
    await seedStock(45_000_000);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 55_000_000,
      newWarehouseQtyMicros: 45_000_000,
    });
    expect(await eventPromise).toBeNull();
  });

  it('skips items with track_inventory=0', async () => {
    await seedItem({ track_inventory: 0 });
    await seedStock(45_000_000);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 55_000_000,
      newWarehouseQtyMicros: 45_000_000,
    });
    expect(await eventPromise).toBeNull();
  });

  it('skips items with reorder_level_micros=0 (unset threshold)', async () => {
    await seedItem({ reorder_level_micros: 0 });
    await seedStock(45_000_000);
    const eventPromise = captureEvent();
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId,
      prevWarehouseQtyMicros: 55_000_000,
      newWarehouseQtyMicros: 45_000_000,
    });
    expect(await eventPromise).toBeNull();
  });

  it('sums across warehouses (WH1=30 + WH2=15 = 45 → crossed_below)', async () => {
    await seedStock(30_000_000, '-A');
    await seedStock(15_000_000, '-B');
    const eventPromise = captureEvent();
    // Prev WH-A qty was 40, new is 30 — cross-WH before = 40+15=55, after = 45.
    await detectAndDispatchLowStock(db, {
      businessId,
      itemId,
      warehouseId: warehouseId + '-A',
      prevWarehouseQtyMicros: 40_000_000,
      newWarehouseQtyMicros: 30_000_000,
    });
    const evt = await eventPromise;
    expect(evt?.kind).toBe('crossed_below');
    expect(evt?.currentQtyMicros).toBe(45_000_000);
  });

  it('swallows errors from a missing item without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      detectAndDispatchLowStock(db, {
        businessId,
        itemId: 'DOES_NOT_EXIST',
        warehouseId,
        prevWarehouseQtyMicros: 55_000_000,
        newWarehouseQtyMicros: 45_000_000,
      }),
    ).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe('§8 loadCurrentLowStockSnapshot', () => {
  beforeEach(async () => {
    db = new BusinessVaultDB(`bv-lowstock-snap-${Math.random().toString(36).slice(2)}`);
    await db.open();
    await seedItem();
  });

  afterEach(async () => {
    // Let any queued microtasks flush before closing so we don't see a
    // spurious "Database closed" from a still-in-flight detector call
    // that raced past the test's captureEvent window.
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.close();
  });

  it('returns a payload when the item is currently low', async () => {
    await seedStock(30_000_000);
    const snap = await loadCurrentLowStockSnapshot(db, businessId, itemId);
    expect(snap).not.toBeNull();
    expect(snap?.currentQtyMicros).toBe(30_000_000);
    expect(snap?.kind).toBe('crossed_below');
  });

  it('returns null when the item is above reorder', async () => {
    await seedStock(60_000_000);
    const snap = await loadCurrentLowStockSnapshot(db, businessId, itemId);
    expect(snap).toBeNull();
  });

  it('returns null for services', async () => {
    await seedItem({ is_service: 1 });
    await seedStock(30_000_000);
    const snap = await loadCurrentLowStockSnapshot(db, businessId, itemId);
    expect(snap).toBeNull();
  });
});
