import { ulid } from 'ulid';
import { db } from '../db';
import type { Category, Unit, Warehouse } from '../db/types';
import { appendSyncEvent } from './syncEventLog';
import { getDeviceId } from '../lib/device';

export const DEFAULT_INVOICE_TERMS = `Thank you for your business.

Payment is due within 15 days of the invoice date. Please include the invoice number with your payment. Any invoice discrepancy should be reported within 7 days. Taxes and TDS will apply as required by law. Returns or cancellations are subject to our agreed policy.`;

const DEFAULT_UNITS: ReadonlyArray<{ code: string; name: string; decimal_places: number }> = [
  { code: 'PCS', name: 'Pieces', decimal_places: 0 },
  { code: 'BOX', name: 'Box', decimal_places: 0 },
  { code: 'KG', name: 'Kilogram', decimal_places: 3 },
  { code: 'GM', name: 'Gram', decimal_places: 0 },
  { code: 'LTR', name: 'Litre', decimal_places: 3 },
  { code: 'ML', name: 'Millilitre', decimal_places: 0 },
  { code: 'MTR', name: 'Metre', decimal_places: 2 },
  { code: 'CM', name: 'Centimetre', decimal_places: 1 },
  { code: 'SQFT', name: 'Square Feet', decimal_places: 2 },
  { code: 'HR', name: 'Hour', decimal_places: 2 },
  { code: 'DAY', name: 'Day', decimal_places: 0 },
  { code: 'PKT', name: 'Packet', decimal_places: 0 },
];

const DEFAULT_CATEGORIES: ReadonlyArray<string> = [
  'General',
  'Electronics',
  'Groceries',
  'Stationery',
  'Clothing',
  'Services',
];

// Seed the three master tables that every business needs on day one. Each
// seed row must be journaled — without it, a restore from an empty local DB
// against the folder-backup journal would rebuild invoices that reference
// unit/category/warehouse rows that never appear in the event stream.
export async function seedDefaultMasters(
  businessId: string,
  opts: { deviceId?: string } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const deviceId = opts.deviceId ?? (await getDeviceId());

  await db.transaction(
    'rw',
    [db.units, db.categories, db.warehouses, db.sync_events],
    async () => {
      const existingUnitCount = await db.units
        .where('business_id')
        .equals(businessId)
        .count();
      if (existingUnitCount === 0) {
        const unitRows: Unit[] = DEFAULT_UNITS.map((u) => ({
          id: ulid(),
          business_id: businessId,
          code: u.code,
          name: u.name,
          decimal_places: u.decimal_places,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        }));
        await db.units.bulkAdd(unitRows);
        for (const row of unitRows) {
          await appendSyncEvent(db, {
            businessId,
            deviceId,
            entityType: 'unit',
            entityId: row.id,
            operation: 'created',
            payload: row,
            timestamp: now,
          });
        }
      }

      const existingCatCount = await db.categories
        .where('business_id')
        .equals(businessId)
        .count();
      if (existingCatCount === 0) {
        const catRows: Category[] = DEFAULT_CATEGORIES.map((name) => ({
          id: ulid(),
          business_id: businessId,
          name,
          parent_id: null,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        }));
        await db.categories.bulkAdd(catRows);
        for (const row of catRows) {
          await appendSyncEvent(db, {
            businessId,
            deviceId,
            entityType: 'category',
            entityId: row.id,
            operation: 'created',
            payload: row,
            timestamp: now,
          });
        }
      }

      const existingWhCount = await db.warehouses
        .where('business_id')
        .equals(businessId)
        .count();
      if (existingWhCount === 0) {
        const wh: Warehouse = {
          id: ulid(),
          business_id: businessId,
          name: 'Main Store',
          address: '',
          is_default: 1,
          active: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        await db.warehouses.add(wh);
        await appendSyncEvent(db, {
          businessId,
          deviceId,
          entityType: 'warehouse',
          entityId: wh.id,
          operation: 'created',
          payload: wh,
          timestamp: now,
        });
      }
    },
  );
}
