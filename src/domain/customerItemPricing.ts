import type { BusinessVaultDB } from '../db/database';

export async function resolveCustomerItemPrice(
  database: BusinessVaultDB,
  businessId: string,
  customerId: string | null,
  itemId: string,
  itemSalePricePaise: number,
): Promise<number> {
  if (!customerId) return itemSalePricePaise;

  const saved = await database.customer_item_prices
    .where('[business_id+customer_id+item_id]')
    .equals([businessId, customerId, itemId])
    .first();

  return saved?.unit_price_paise ?? itemSalePricePaise;
}
