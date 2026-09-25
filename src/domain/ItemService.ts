import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type { Item } from '../db/types';
import { appendSyncEvent } from './syncEventLog';
import { validateHsnSac } from './compliance';

export interface ItemServiceDeps {
  db: BusinessVaultDB;
  now?: () => string;
}

export interface CreateItemInput {
  businessId: string;
  deviceId: string;
  sku: string;
  name: string;
  description?: string;
  hsn?: string;
  categoryId?: string | null;
  unitId: string;
  salePricePaise: number;
  purchasePricePaise: number;
  taxRateBps: number;
  cessRateBps?: number;
  isService?: boolean;
  trackInventory?: boolean;
  openingQtyMicros?: number;
  openingValuePaise?: number;
  reorderLevelMicros?: number;
  barcode?: string | null;
  imageRef?: string | null;
  idempotencyKey?: string;
}

export interface UpdateItemInput {
  id: string;
  businessId: string;
  deviceId: string;
  patch: Partial<
    Pick<
      Item,
      | 'sku'
      | 'name'
      | 'description'
      | 'hsn'
      | 'category_id'
      | 'unit_id'
      | 'sale_price_paise'
      | 'purchase_price_paise'
      | 'tax_rate_bps'
      | 'cess_rate_bps'
      | 'is_service'
      | 'track_inventory'
      | 'reorder_level_micros'
      | 'barcode'
      | 'image_ref'
      | 'active'
    >
  >;
  idempotencyKey?: string;
}

function assertBps(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isInteger(v) || v < 0 || v > 100_000) {
    throw new Error(`${name} must be integer 0..100000 bps`);
  }
}
function assertPaise(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isInteger(v)) {
    throw new Error(`${name} must be integer paise`);
  }
}
function assertMicros(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isInteger(v)) {
    throw new Error(`${name} must be integer micros`);
  }
}

export class ItemService {
  private readonly db: BusinessVaultDB;
  private readonly now: () => string;

  constructor(deps: ItemServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateItemInput): Promise<Item> {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Item name is required');
    }
    if (!input.sku || input.sku.trim().length === 0) {
      throw new Error('Item sku is required');
    }
    if (!input.unitId) {
      throw new Error('Item unitId is required');
    }
    assertPaise('salePricePaise', input.salePricePaise);
    assertPaise('purchasePricePaise', input.purchasePricePaise);
    assertPaise('openingValuePaise', input.openingValuePaise);
    assertBps('taxRateBps', input.taxRateBps);
    assertBps('cessRateBps', input.cessRateBps);
    assertMicros('openingQtyMicros', input.openingQtyMicros);
    assertMicros('reorderLevelMicros', input.reorderLevelMicros);
    validateHsnSac(input.hsn, input.isService === true, 'Item');

    const db = this.db;
    const now = this.now();
    const sku = input.sku.trim();

    return db.transaction(
      'rw',
      [db.items, db.sync_events],
      async () => {
        const existing = await db.items
          .where('[business_id+sku]')
          .equals([input.businessId, sku])
          .first();
        if (existing) {
          throw new Error(`SKU already exists in business: ${sku}`);
        }
        const item: Item = {
          id: ulid(),
          business_id: input.businessId,
          sku,
          name: input.name.trim(),
          description: input.description ?? '',
          hsn: input.hsn ?? '',
          category_id: input.categoryId ?? null,
          unit_id: input.unitId,
          sale_price_paise: input.salePricePaise,
          purchase_price_paise: input.purchasePricePaise,
          tax_rate_bps: input.taxRateBps,
          cess_rate_bps: input.cessRateBps ?? 0,
          is_service: input.isService ? 1 : 0,
          track_inventory: input.trackInventory === false ? 0 : 1,
          opening_qty_micros: input.openingQtyMicros ?? 0,
          opening_value_paise: input.openingValuePaise ?? 0,
          reorder_level_micros: input.reorderLevelMicros ?? 0,
          barcode: input.barcode ?? null,
          image_ref: input.imageRef ?? null,
          active: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        await db.items.add(item);
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'item',
          entityId: item.id,
          operation: 'created',
          payload: item,
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        return item;
      },
    );
  }

  async update(input: UpdateItemInput): Promise<Item> {
    assertPaise('sale_price_paise', input.patch.sale_price_paise);
    assertPaise('purchase_price_paise', input.patch.purchase_price_paise);
    assertBps('tax_rate_bps', input.patch.tax_rate_bps);
    assertBps('cess_rate_bps', input.patch.cess_rate_bps);
    assertMicros('reorder_level_micros', input.patch.reorder_level_micros);

    const db = this.db;
    const now = this.now();
    return db.transaction(
      'rw',
      [db.items, db.sync_events],
      async () => {
        const existing = await db.items.get(input.id);
        if (!existing) throw new Error(`Item not found: ${input.id}`);
        if (existing.business_id !== input.businessId) {
          throw new Error(
            `Item ${input.id} does not belong to business ${input.businessId}`,
          );
        }
        if (input.patch.hsn !== undefined || input.patch.is_service !== undefined) {
          validateHsnSac(
            input.patch.hsn ?? existing.hsn,
            (input.patch.is_service ?? existing.is_service) === 1,
            'Item',
          );
        }
        if (input.patch.sku && input.patch.sku !== existing.sku) {
          const dup = await db.items
            .where('[business_id+sku]')
            .equals([input.businessId, input.patch.sku])
            .first();
          if (dup) throw new Error(`SKU already exists: ${input.patch.sku}`);
        }
        const next: Item = {
          ...existing,
          ...input.patch,
          id: existing.id,
          business_id: existing.business_id,
          updated_at: now,
          entity_version: existing.entity_version + 1,
        };
        await db.items.put(next);
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'item',
          entityId: next.id,
          operation: 'updated',
          payload: {
            id: next.id,
            ...input.patch,
            entity_version: next.entity_version,
          },
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        return next;
      },
    );
  }

  async get(id: string): Promise<Item | undefined> {
    return this.db.items.get(id);
  }

  async list(businessId: string): Promise<Item[]> {
    return this.db.items.where('business_id').equals(businessId).toArray();
  }
}

export function createItemService(deps: ItemServiceDeps): ItemService {
  return new ItemService(deps);
}
