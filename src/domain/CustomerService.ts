import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type { Customer } from '../db/types';
import { assertValidGstin, isValidStateCode } from '../lib/gst';
import { appendSyncEvent } from './syncEventLog';

export interface CustomerServiceDeps {
  db: BusinessVaultDB;
  now?: () => string;
}

export interface CreateCustomerInput {
  businessId: string;
  deviceId: string;
  name: string;
  phone?: string;
  email?: string;
  gstin?: string | null;
  billingAddress?: string;
  shippingAddress?: string;
  state?: string;
  stateCode?: string;
  openingBalancePaise?: number;
  creditLimitPaise?: number;
  notes?: string;
  idempotencyKey?: string;
}

export interface UpdateCustomerInput {
  id: string;
  businessId: string;
  deviceId: string;
  patch: Partial<
    Pick<
      Customer,
      | 'name'
      | 'phone'
      | 'email'
      | 'gstin'
      | 'billing_address'
      | 'shipping_address'
      | 'state'
      | 'state_code'
      | 'opening_balance_paise'
      | 'credit_limit_paise'
      | 'notes'
      | 'active'
    >
  >;
  idempotencyKey?: string;
}

export interface DuplicateCustomerGroup {
  gstin: string;
  customers: Customer[];
}

export interface CustomerMergeResult {
  survivor: Customer;
  mergedCustomerIds: string[];
  reassigned: {
    invoices: number;
    salesReturns: number;
    payments: number;
    advances: number;
    journalLines: number;
    customerItemPrices: number;
  };
}

function validate(input: {
  gstin?: string | null;
  stateCode?: string;
  openingBalancePaise?: number;
  creditLimitPaise?: number;
}): void {
  assertValidGstin(input.gstin ?? null);
  if (input.stateCode && input.stateCode.length > 0) {
    if (!isValidStateCode(input.stateCode)) {
      throw new Error(`Invalid state code: ${input.stateCode}`);
    }
  }
  if (
    input.openingBalancePaise !== undefined &&
    !Number.isInteger(input.openingBalancePaise)
  ) {
    throw new Error('openingBalancePaise must be integer paise');
  }
  if (
    input.creditLimitPaise !== undefined &&
    !Number.isInteger(input.creditLimitPaise)
  ) {
    throw new Error('creditLimitPaise must be integer paise');
  }
}

function normalizeGstin(gstin: string | null | undefined): string | null {
  const value = gstin?.trim().toUpperCase() ?? '';
  return value.length > 0 ? value : null;
}

function mergeText(primary: string, secondary: string): string {
  return primary.trim() || secondary.trim();
}

function mergeNotes(primary: string, secondary: string): string {
  if (!primary.trim()) return secondary;
  if (!secondary.trim() || primary.trim() === secondary.trim()) return primary;
  return `${primary}\n\nMerged customer note:\n${secondary}`;
}

async function assertGstinAvailable(
  db: BusinessVaultDB,
  businessId: string,
  gstin: string | null,
  excludeCustomerId?: string,
): Promise<void> {
  if (!gstin) return;
  const duplicate = await db.customers
    .where('business_id')
    .equals(businessId)
    .filter((customer) => customer.gstin?.trim().toUpperCase() === gstin && customer.id !== excludeCustomerId)
    .first();
  if (duplicate) {
    throw new Error(`A customer with GSTIN "${gstin}" already exists for this business`);
  }
}

export class CustomerService {
  private readonly db: BusinessVaultDB;
  private readonly now: () => string;

  constructor(deps: CustomerServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateCustomerInput): Promise<Customer> {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Customer name is required');
    }
    const gstinNormalized = normalizeGstin(input.gstin);
    validate({
      gstin: gstinNormalized,
      stateCode: input.stateCode,
      openingBalancePaise: input.openingBalancePaise,
      creditLimitPaise: input.creditLimitPaise,
    });

    const now = this.now();
    const customer: Customer = {
      id: ulid(),
      business_id: input.businessId,
      name: input.name.trim(),
      phone: input.phone ?? '',
      email: input.email ?? '',
      gstin: gstinNormalized,
      billing_address: input.billingAddress ?? '',
      shipping_address: input.shippingAddress ?? '',
      state: input.state ?? '',
      state_code: input.stateCode ?? '',
      opening_balance_paise: input.openingBalancePaise ?? 0,
      credit_limit_paise: input.creditLimitPaise ?? 0,
      notes: input.notes ?? '',
      active: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const db = this.db;
    return db.transaction(
      'rw',
      [db.customers, db.sync_events],
      async () => {
        await assertGstinAvailable(db, input.businessId, gstinNormalized);
        await db.customers.add(customer);
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'customer',
          entityId: customer.id,
          operation: 'created',
          payload: customer,
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        return customer;
      },
    );
  }

  async update(input: UpdateCustomerInput): Promise<Customer> {
    const normalizedPatchGstin = input.patch.gstin === undefined
      ? undefined
      : normalizeGstin(input.patch.gstin);
    validate({
      gstin: normalizedPatchGstin,
      stateCode: input.patch.state_code,
      openingBalancePaise: input.patch.opening_balance_paise,
      creditLimitPaise: input.patch.credit_limit_paise,
    });

    const db = this.db;
    const now = this.now();
    return db.transaction(
      'rw',
      [db.customers, db.sync_events],
      async () => {
        const existing = await db.customers.get(input.id);
        if (!existing) {
          throw new Error(`Customer not found: ${input.id}`);
        }
        if (existing.business_id !== input.businessId) {
          throw new Error(
            `Customer ${input.id} does not belong to business ${input.businessId}`,
          );
        }
        const patch = { ...input.patch };
        if (patch.gstin !== undefined) patch.gstin = normalizedPatchGstin;
        const next: Customer = {
          ...existing,
          ...patch,
          id: existing.id,
          business_id: existing.business_id,
          updated_at: now,
          entity_version: existing.entity_version + 1,
        };
        await assertGstinAvailable(db, input.businessId, next.gstin, existing.id);
        await db.customers.put(next);
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'customer',
          entityId: next.id,
          operation: 'updated',
          payload: { id: next.id, ...patch, entity_version: next.entity_version },
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        return next;
      },
    );
  }

  async get(id: string): Promise<Customer | undefined> {
    return this.db.customers.get(id);
  }

  async list(businessId: string): Promise<Customer[]> {
    return this.db.customers
      .where('business_id')
      .equals(businessId)
      .toArray();
  }

  async findDuplicateGstinGroups(businessId: string): Promise<DuplicateCustomerGroup[]> {
    const customers = await this.list(businessId);
    const byGstin = new Map<string, Customer[]>();
    for (const customer of customers) {
      const gstin = normalizeGstin(customer.gstin);
      if (!gstin) continue;
      const group = byGstin.get(gstin) ?? [];
      group.push(customer);
      byGstin.set(gstin, group);
    }
    return [...byGstin.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([gstin, group]) => ({
        gstin,
        customers: group.sort((a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
        ),
      }))
      .sort((a, b) => a.gstin.localeCompare(b.gstin));
  }

  async mergeCustomers(input: {
    businessId: string;
    deviceId: string;
    survivorId: string;
    duplicateIds: string[];
  }): Promise<CustomerMergeResult> {
    const duplicateIds = [...new Set(input.duplicateIds)].filter(
      (id) => id !== input.survivorId,
    );
    if (duplicateIds.length === 0) {
      throw new Error('Select at least one duplicate customer to merge');
    }

    const db = this.db;
    const now = this.now();
    return db.transaction(
      'rw',
      [
        db.customers,
        db.invoices,
        db.sales_returns,
        db.payments,
        db.advances,
        db.journal_lines,
        db.customer_item_prices,
        db.sync_events,
        db.audit_log,
      ],
      async () => {
        const survivor = await db.customers.get(input.survivorId);
        const duplicates = await Promise.all(duplicateIds.map((id) => db.customers.get(id)));
        if (!survivor || duplicates.some((customer) => !customer)) {
          throw new Error('One or more selected customers no longer exist');
        }
        const rows = duplicates as Customer[];
        if (
          survivor.business_id !== input.businessId ||
          rows.some((customer) => customer.business_id !== input.businessId)
        ) {
          throw new Error('All customers must belong to the active business');
        }
        const survivorGstin = normalizeGstin(survivor.gstin);
        if (!survivorGstin || rows.some((customer) => normalizeGstin(customer.gstin) !== survivorGstin)) {
          throw new Error('Customers can only be merged when their GSTINs match');
        }

        const merged: Customer = {
          ...survivor,
          phone: mergeText(survivor.phone, rows.map((r) => r.phone).find(Boolean) ?? ''),
          email: mergeText(survivor.email, rows.map((r) => r.email).find(Boolean) ?? ''),
          billing_address: mergeText(
            survivor.billing_address,
            rows.map((r) => r.billing_address).find(Boolean) ?? '',
          ),
          shipping_address: mergeText(
            survivor.shipping_address,
            rows.map((r) => r.shipping_address).find(Boolean) ?? '',
          ),
          state: mergeText(survivor.state, rows.map((r) => r.state).find(Boolean) ?? ''),
          state_code: mergeText(
            survivor.state_code,
            rows.map((r) => r.state_code).find(Boolean) ?? '',
          ),
          notes: rows.reduce((notes, row) => mergeNotes(notes, row.notes), survivor.notes),
          opening_balance_paise:
            survivor.opening_balance_paise + rows.reduce((sum, row) => sum + row.opening_balance_paise, 0),
          credit_limit_paise: Math.max(
            survivor.credit_limit_paise,
            ...rows.map((row) => row.credit_limit_paise),
          ),
          active: Math.max(survivor.active, ...rows.map((row) => row.active)),
          updated_at: now,
          entity_version: survivor.entity_version + 1,
        };

        let invoices = 0;
        let salesReturns = 0;
        let payments = 0;
        let advances = 0;
        let journalLines = 0;
        let customerItemPrices = 0;
        const duplicateSet = new Set(duplicateIds);

        const invoiceRows = await db.invoices.where('business_id').equals(input.businessId).toArray();
        for (const row of invoiceRows) {
          if (!duplicateSet.has(row.customer_id)) continue;
          const next = { ...row, customer_id: survivor.id, updated_at: now, entity_version: (row.entity_version ?? 0) + 1 };
          await db.invoices.put(next);
          await appendSyncEvent(db, {
            businessId: input.businessId, deviceId: input.deviceId, entityType: 'invoice',
            entityId: row.id, operation: 'updated', payload: next, timestamp: now,
          });
          invoices++;
        }
        const returnRows = await db.sales_returns.where('business_id').equals(input.businessId).toArray();
        for (const row of returnRows) {
          if (!duplicateSet.has(row.customer_id)) continue;
          const next = { ...row, customer_id: survivor.id, updated_at: now, entity_version: (row.entity_version ?? 0) + 1 };
          await db.sales_returns.put(next);
          await appendSyncEvent(db, {
            businessId: input.businessId, deviceId: input.deviceId, entityType: 'sales_return',
            entityId: row.id, operation: 'updated', payload: next, timestamp: now,
          });
          salesReturns++;
        }
        const paymentRows = await db.payments.where('business_id').equals(input.businessId).toArray();
        for (const row of paymentRows) {
          if (row.party_type !== 'customer' || !duplicateSet.has(row.party_id)) continue;
          const next = { ...row, party_id: survivor.id, updated_at: now, entity_version: (row.entity_version ?? 0) + 1 };
          await db.payments.put(next);
          await appendSyncEvent(db, {
            businessId: input.businessId, deviceId: input.deviceId, entityType: 'payment',
            entityId: row.id, operation: 'updated', payload: next, timestamp: now,
          });
          payments++;
        }
        const advanceRows = await db.advances.where('business_id').equals(input.businessId).toArray();
        for (const row of advanceRows) {
          if (row.party_type !== 'customer' || !duplicateSet.has(row.party_id)) continue;
          const next = { ...row, party_id: survivor.id, updated_at: now, entity_version: (row.entity_version ?? 0) + 1 };
          await db.advances.put(next);
          await appendSyncEvent(db, {
            businessId: input.businessId, deviceId: input.deviceId, entityType: 'advance',
            entityId: row.id, operation: 'updated', payload: next, timestamp: now,
          });
          advances++;
        }
        const journalRows = await db.journal_lines.where('business_id').equals(input.businessId).toArray();
        for (const row of journalRows) {
          if (row.party_type !== 'customer' || !row.party_id || !duplicateSet.has(row.party_id)) continue;
          const next = { ...row, party_id: survivor.id };
          await db.journal_lines.put(next);
          await appendSyncEvent(db, {
            businessId: input.businessId, deviceId: input.deviceId, entityType: 'journal_line',
            entityId: row.id, operation: 'updated', payload: next, timestamp: now,
          });
          journalLines++;
        }
        const priceRows = await db.customer_item_prices.where('business_id').equals(input.businessId).toArray();
        const survivorPrices = new Set(
          priceRows.filter((row) => row.customer_id === survivor.id).map((row) => row.item_id),
        );
        for (const row of priceRows) {
          if (!duplicateSet.has(row.customer_id)) continue;
          if (!survivorPrices.has(row.item_id)) {
            await db.customer_item_prices.put({
              ...row,
              id: `${row.business_id}:${survivor.id}:${row.item_id}`,
              customer_id: survivor.id,
              updated_at: now,
            });
            await appendSyncEvent(db, {
              businessId: input.businessId, deviceId: input.deviceId, entityType: 'customer_item_price',
              entityId: `${row.business_id}:${survivor.id}:${row.item_id}`, operation: 'created',
              payload: { ...row, id: `${row.business_id}:${survivor.id}:${row.item_id}`, customer_id: survivor.id, updated_at: now }, timestamp: now,
            });
            survivorPrices.add(row.item_id);
          }
          await db.customer_item_prices.delete(row.id);
          await appendSyncEvent(db, {
            businessId: input.businessId, deviceId: input.deviceId, entityType: 'customer_item_price',
            entityId: row.id, operation: 'deleted', payload: { id: row.id, merged_into_customer_id: survivor.id }, timestamp: now,
          });
          customerItemPrices++;
        }

        await db.customers.put(merged);
        for (const row of rows) await db.customers.delete(row.id);
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'customer',
          entityId: survivor.id,
          operation: 'updated',
          payload: { ...merged, merged_customer_ids: duplicateIds },
          timestamp: now,
        });
        for (const row of rows) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'customer',
            entityId: row.id,
            operation: 'deleted',
            payload: { id: row.id, merged_into_customer_id: survivor.id },
            timestamp: now,
          });
        }
        await db.audit_log.add({
          id: ulid(),
          business_id: input.businessId,
          device_id: input.deviceId,
          actor: 'customer-merge',
          action: 'customer.merged',
          entity_type: 'customer',
          entity_id: survivor.id,
          before: { survivor, duplicates: rows },
          after: { survivor: merged, merged_customer_ids: duplicateIds },
          at: now,
        });
        return {
          survivor: merged,
          mergedCustomerIds: duplicateIds,
          reassigned: { invoices, salesReturns, payments, advances, journalLines, customerItemPrices },
        };
      },
    );
  }
}

export function createCustomerService(
  deps: CustomerServiceDeps,
): CustomerService {
  return new CustomerService(deps);
}
