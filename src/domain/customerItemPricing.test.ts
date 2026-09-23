import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessVaultDB } from '../db/database';
import type { CustomerItemPrice, Item } from '../db/types';
import { resolveCustomerItemPrice } from './customerItemPricing';

const businessId = 'business-1';
const customerA = 'customer-a';
const customerB = 'customer-b';
const itemId = 'item-1';
const itemSalePricePaise = 10000;

let db: BusinessVaultDB;

function savedPrice(customerId: string, unitPricePaise: number): CustomerItemPrice {
  const now = new Date().toISOString();
  return {
    id: `${businessId}:${customerId}:${itemId}`,
    business_id: businessId,
    customer_id: customerId,
    item_id: itemId,
    unit_price_paise: unitPricePaise,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
}

beforeEach(async () => {
  db = new BusinessVaultDB(`pricing-tests-${Date.now()}-${Math.random()}`);
  await db.open();
});

describe('resolveCustomerItemPrice', () => {
  it('uses the item master price when the item is selected before a customer', async () => {
    await expect(
      resolveCustomerItemPrice(db, businessId, null, itemId, itemSalePricePaise),
    ).resolves.toBe(itemSalePricePaise);
  });

  it('uses the remembered price when the customer is selected before the item', async () => {
    await db.customer_item_prices.add(savedPrice(customerA, 8500));

    await expect(
      resolveCustomerItemPrice(db, businessId, customerA, itemId, itemSalePricePaise),
    ).resolves.toBe(8500);
  });

  it('uses the newly selected customer price instead of the previous customer price', async () => {
    await db.customer_item_prices.bulkAdd([
      savedPrice(customerA, 8500),
      savedPrice(customerB, 9200),
    ]);

    await expect(
      resolveCustomerItemPrice(db, businessId, customerB, itemId, itemSalePricePaise),
    ).resolves.toBe(9200);
  });

  it('falls back to the item master price when the new customer has no override', async () => {
    await db.customer_item_prices.add(savedPrice(customerA, 8500));

    await expect(
      resolveCustomerItemPrice(db, businessId, customerB, itemId, itemSalePricePaise),
    ).resolves.toBe(itemSalePricePaise);
  });

  it('does not mutate the item master price', async () => {
    const item: Pick<Item, 'sale_price_paise'> = { sale_price_paise: itemSalePricePaise };
    await db.customer_item_prices.add(savedPrice(customerA, 8500));

    await resolveCustomerItemPrice(db, businessId, customerA, itemId, item.sale_price_paise);

    expect(item.sale_price_paise).toBe(itemSalePricePaise);
  });
});
