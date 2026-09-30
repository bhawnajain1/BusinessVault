/**
 * Journal event handlers — applied idempotently during restore replay.
 *
 * Each handler receives the parsed SyncEvent + the Dexie database (already
 * inside a transaction) and applies the effect. Rules:
 *   - MUST be idempotent. `put` (upsert) over `add` for row writes.
 *   - MUST NOT emit new sync events. Restore is silent — no rehydration echo.
 *   - MUST NOT throw on already-applied state. Missing preconditions are logged
 *     as diagnostics; they do not abort the whole replay.
 *
 * The handler map is keyed by `${entity_type}:${operation}`. Unhandled events
 * are counted and surfaced in RestoreReport.diagnostics but do not fail.
 *
 * The SyncEvent shape lives on the provider side (snake_case) — see
 * CustomerStorageProvider.SyncEvent. Journal payloads are whatever the emitter
 * wrote; we treat them as `Record<string, unknown>` and coerce.
 */
import Dexie from 'dexie';
import type { BusinessVaultDB } from '../db/database';
import type { SyncEvent } from '../storage/CustomerStorageProvider';
import type {
  Customer,
  Supplier,
  Item,
  Category,
  Unit,
  Warehouse,
  Invoice,
  InvoiceLine,
  Purchase,
  PurchaseLine,
  Payment,
  Expense,
  Account,
  Advance,
  JournalEntry,
  JournalLine,
  StockMovement,
  SalesReturn,
  SalesReturnItem,
  CustomerItemPrice,
} from '../db/types';
import { log } from '../lib/log';

export interface HandlerContext {
  db: BusinessVaultDB;
  businessId: string;
  diagnostics: string[];
}

export type EventHandler = (
  evt: SyncEvent,
  ctx: HandlerContext,
) => Promise<void>;

function asRecord(v: unknown, evtId: string): Record<string, unknown> {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`event ${evtId}: payload is not an object`);
  }
  return v as Record<string, unknown>;
}

const put =
  <T extends { id: string; business_id?: string; entity_version?: number }>(
    table: (db: BusinessVaultDB) => {
      get(id: string): Promise<T | undefined>;
      put(v: T): Promise<unknown>;
    },
  ) =>
  async (evt: SyncEvent, ctx: HandlerContext): Promise<void> => {
    const row = asRecord(evt.payload, evt.event_id) as unknown as T;
    const businessId = (row as { business_id?: string }).business_id;
    if (businessId && businessId !== ctx.businessId) {
      throw new Error(`event ${evt.event_id}: row belongs to another business`);
    }
    const existing = await table(ctx.db).get(row.id);
    const eventVersion = evt.entity_version ?? row.entity_version ?? 0;
    if (existing && eventVersion > 0 && (existing.entity_version ?? 0) >= eventVersion) {
      ctx.diagnostics.push(`${evt.entity_type}:create ${row.id}: stale event ignored`);
      return;
    }
    await table(ctx.db).put(row);
  };

const merge =
  <T extends { id: string; business_id?: string }>(
    entityType: string,
    table: (db: BusinessVaultDB) => {
      get(id: string): Promise<T | undefined>;
      put(v: T): Promise<unknown>;
    },
    options: { recordMissing?: boolean } = {},
  ) =>
  async (evt: SyncEvent, ctx: HandlerContext): Promise<void> => {
    const patch = asRecord(evt.payload, evt.event_id);
    const id = String(patch.id ?? evt.entity_id ?? '');
    if (!id) throw new Error(`event ${evt.event_id}: ${entityType} update has no id`);
    const existing = await table(ctx.db).get(id);
    if (!existing) {
      const message = `${entityType}:update ${id}: existing row not found`;
      if (options.recordMissing !== false) ctx.diagnostics.push(message);
      log.warn('restore.event.merge-missing', 'restore: update target not found', {
        businessId: ctx.businessId,
        eventId: evt.event_id,
        entityType,
        entityId: id,
        patchFields: Object.keys(patch),
      });
      return;
    }
    if (existing.business_id && existing.business_id !== ctx.businessId) {
      throw new Error(
        `event ${evt.event_id}: ${entityType} ${id} belongs to another business`,
      );
    }
    const currentVersion = (existing as { entity_version?: number }).entity_version ?? 0;
    const eventVersion = evt.entity_version ?? Number(patch.entity_version ?? 0);
    if (eventVersion > 0 && currentVersion >= eventVersion) {
      ctx.diagnostics.push(`${entityType}:update ${id}: stale event ignored`);
      return;
    }
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      ...(existing.business_id ? { business_id: existing.business_id } : {}),
    } as T;
    await table(ctx.db).put(next);
    Dexie.currentTransaction?.on('complete', () => log.debug(
      'restore.event.merged',
      'restore: partial update merged',
      {
        businessId: ctx.businessId,
        eventId: evt.event_id,
        entityType,
        entityId: id,
        fromVersion: (existing as { entity_version?: number }).entity_version ?? null,
        toVersion: (next as { entity_version?: number }).entity_version ?? null,
        patchFields: Object.keys(patch),
      },
    ));
  };

const HANDLERS: Record<string, EventHandler> = {
  'business:create': put((db) => db.businesses),
  'business:created': put((db) => db.businesses),
  'business:update': merge('business', (db) => db.businesses),
  'business:updated': merge('business', (db) => db.businesses),

  'customer:create': put<Customer>((db) => db.customers),
  'customer:update': merge<Customer>('customer', (db) => db.customers),
  'customer:created': put<Customer>((db) => db.customers),
  'customer:updated': merge<Customer>('customer', (db) => db.customers),

  'customer_item_price:create': put<CustomerItemPrice>((db) => db.customer_item_prices),
  'customer_item_price:created': put<CustomerItemPrice>((db) => db.customer_item_prices),
  'customer_item_price:update': merge<CustomerItemPrice>('customer_item_price', (db) => db.customer_item_prices),
  'customer_item_price:updated': merge<CustomerItemPrice>('customer_item_price', (db) => db.customer_item_prices),

  'supplier:create': put<Supplier>((db) => db.suppliers),
  'supplier:created': put<Supplier>((db) => db.suppliers),
  'supplier:update': merge<Supplier>('supplier', (db) => db.suppliers),
  'supplier:updated': merge<Supplier>('supplier', (db) => db.suppliers),

  'category:create': put<Category>((db) => db.categories),
  'category:created': put<Category>((db) => db.categories),
  'category:update': merge<Category>('category', (db) => db.categories),
  'category:updated': merge<Category>('category', (db) => db.categories),

  'unit:create': put<Unit>((db) => db.units),
  'unit:created': put<Unit>((db) => db.units),
  'unit:update': merge<Unit>('unit', (db) => db.units),
  'unit:updated': merge<Unit>('unit', (db) => db.units),

  'warehouse:create': put<Warehouse>((db) => db.warehouses),
  'warehouse:created': put<Warehouse>((db) => db.warehouses),
  'warehouse:update': merge<Warehouse>('warehouse', (db) => db.warehouses),
  'warehouse:updated': merge<Warehouse>('warehouse', (db) => db.warehouses),

  'item:create': put<Item>((db) => db.items),
  'item:created': put<Item>((db) => db.items),
  'item:update': merge<Item>('item', (db) => db.items),
  'item:updated': merge<Item>('item', (db) => db.items),

  'invoice:create': put<Invoice>((db) => db.invoices),
  'invoice:created': put<Invoice>((db) => db.invoices),
  // invoice:update carries either a full Invoice row, or a partial payload
  // from restoreInvoice ({invoice_id, restored_at, restored_payment_ids,
  // restored_advance_ids}) which clears deleted_at on the invoice + cascaded
  // payments/advances. Detect the merge shape and dispatch.
  'invoice:update': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const isRestore =
      p.invoice_id !== undefined &&
      p.id === undefined &&
      p.restored_at !== undefined;
    if (isRestore) {
      const invoiceId = String(p.invoice_id ?? '');
      const inv = await ctx.db.invoices.get(invoiceId);
      if (!inv) {
        ctx.diagnostics.push(
          `invoice:update ${invoiceId} (restore): invoice not found`,
        );
        return;
      }
      if (inv.business_id !== ctx.businessId) {
        throw new Error(`invoice:update ${invoiceId}: invoice belongs to another business`);
      }
      inv.deleted_at = null;
      inv.deleted_reason = null;
      inv.updated_at = String(p.restored_at ?? new Date().toISOString());
      await ctx.db.invoices.put(inv);
      const restoredPaymentIds = Array.isArray(p.restored_payment_ids)
        ? (p.restored_payment_ids as string[])
        : [];
      for (const pid of restoredPaymentIds) {
        const pay = await ctx.db.payments.get(pid);
        if (pay) {
          if (pay.business_id !== ctx.businessId) throw new Error(`invoice:update ${pid}: payment belongs to another business`);
          pay.deleted_at = null;
          pay.deleted_reason = null;
          await ctx.db.payments.put(pay);
        }
      }
      const restoredAdvanceIds = Array.isArray(p.restored_advance_ids)
        ? (p.restored_advance_ids as string[])
        : [];
      for (const aid of restoredAdvanceIds) {
        const adv = await ctx.db.advances.get(aid);
        if (adv) {
          if (adv.business_id !== ctx.businessId) throw new Error(`invoice:update ${aid}: advance belongs to another business`);
          adv.deleted_at = null;
          adv.deleted_reason = null;
          await ctx.db.advances.put(adv);
        }
      }
      return;
    }
    await merge<Invoice>('invoice', (db) => db.invoices)(evt, ctx);
  },
  'invoice:updated': merge<Invoice>('invoice', (db) => db.invoices),

  'invoice_line:create': put<InvoiceLine>((db) => db.invoice_lines),
  'invoice_line:created': put<InvoiceLine>((db) => db.invoice_lines),
  // syncWorker collapses non-CRUD verbs to 'update' at the folder boundary
  // (see toProviderEvent). We accept the collapsed form so restore replays
  // journals written by shipped installs. Same table, same put — restore is
  // idempotent so the operation name doesn't affect the write.
  'invoice_line:update': put<InvoiceLine>((db) => db.invoice_lines),
  'invoice_line:delete': async (evt, ctx) => {
    const payload = asRecord(evt.payload, evt.event_id);
    const id = String(payload.id ?? evt.entity_id ?? '');
    if (id && (await ctx.db.invoice_lines.get(id))) {
      await ctx.db.invoice_lines.delete(id);
    }
  },

  'purchase:create': put<Purchase>((db) => db.purchases),
  'purchase:created': put<Purchase>((db) => db.purchases),
  // purchase:update either carries a full Purchase row OR a partial back-pointer
  // update from ReturnService.createPurchaseReturn ({id, reversed_by_purchase_id,
  // entity_version}). Detect the partial shape and merge into the existing row
  // so we don't clobber every other field. Mirrors invoice:update above.
  'purchase:update': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const isBackPointerMerge =
      p.reversed_by_purchase_id !== undefined &&
      p.business_id === undefined &&
      p.total_paise === undefined;
    if (isBackPointerMerge) {
      const id = String(p.id ?? '');
      const existing = await ctx.db.purchases.get(id);
      if (!existing) {
        ctx.diagnostics.push(
          `purchase:update ${id} (back-pointer merge): purchase not found`,
        );
        return;
      }
      if (existing.business_id !== ctx.businessId) throw new Error(`purchase:update ${id}: purchase belongs to another business`);
      existing.reversed_by_purchase_id =
        (p.reversed_by_purchase_id as string | null | undefined) ?? null;
      for (const field of [
        'replaces_purchase_id',
        'replaced_by_purchase_id',
        'reversal_journal_entry_id',
        'cancelled_at',
        'cancel_reason',
      ] as const) {
        if (p[field] !== undefined) existing[field] = p[field] as never;
      }
      if (typeof p.entity_version === 'number') {
        existing.entity_version = p.entity_version;
      }
      await ctx.db.purchases.put(existing);
      return;
    }
    await merge<Purchase>('purchase', (db) => db.purchases)(evt, ctx);
  },
  'purchase:updated': merge<Purchase>('purchase', (db) => db.purchases),

  'purchase:reverse': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const id = String(p.purchase_id ?? p.id ?? evt.entity_id ?? '');
    const existing = await ctx.db.purchases.get(id);
    if (!existing) {
      ctx.diagnostics.push(`purchase:reverse ${id}: purchase not found`);
      log.warn('restore.event.purchase-reverse-missing', 'restore: purchase reversal target missing', {
        businessId: ctx.businessId,
        eventId: evt.event_id,
        purchaseId: id,
      });
      return;
    }
    if (existing.business_id !== ctx.businessId) throw new Error(`purchase:reverse ${id}: purchase belongs to another business`);
    await ctx.db.purchases.put({
      ...existing,
      bill_number: String(p.renamed_bill_number ?? existing.bill_number),
      status: 'cancelled',
      notes: p.reason
        ? `${existing.notes ? `${existing.notes}\n` : ''}[REVERSED ${evt.timestamp}] ${String(p.reason)}`
        : existing.notes,
      reversal_journal_entry_id:
        (p.reversal_journal_id as string | null | undefined) ?? existing.reversal_journal_entry_id ?? null,
      cancelled_at: existing.cancelled_at ?? evt.timestamp,
      cancel_reason: (p.reason as string | null | undefined) ?? existing.cancel_reason ?? null,
      updated_at: evt.timestamp,
      entity_version: Math.max(existing.entity_version + 1, evt.entity_version),
    });
    Dexie.currentTransaction?.on('complete', () => log.info(
      'restore.event.purchase-reversed',
      'restore: purchase reversal applied',
      {
        businessId: ctx.businessId,
        eventId: evt.event_id,
        purchaseId: id,
        renamedBillNumber: p.renamed_bill_number ?? null,
        reversalJournalId: p.reversal_journal_id ?? null,
      },
    ));
  },

  'purchase_line:create': put<PurchaseLine>((db) => db.purchase_lines),
  'purchase_line:created': put<PurchaseLine>((db) => db.purchase_lines),
  'purchase_line:update': put<PurchaseLine>((db) => db.purchase_lines),

  'payment:create': put<Payment>((db) => db.payments),
  'payment:created': put<Payment>((db) => db.payments),
  // payment:update carries either a full Payment row or an allocation-merge
  // payload ({payment_id, allocations}) — the latter is what payment:allocated
  // events become after the worker's toProviderEvent collapses non-CRUD verbs
  // to 'update'. Detect the merge shape and merge allocations into the
  // existing row; else put the full row.
  'payment:update': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const isMerge =
      p.payment_id !== undefined && p.id === undefined;
    if (isMerge) {
      const paymentId = String(p.payment_id ?? '');
      const existing = await ctx.db.payments.get(paymentId);
      if (!existing) {
        ctx.diagnostics.push(
          `payment:update ${paymentId} (allocation merge): payment not found`,
        );
        return;
      }
      const allocations = Array.isArray(p.allocations) ? p.allocations : [];
      existing.allocations = allocations as Payment['allocations'];
      await ctx.db.payments.put(existing);
      return;
    }
    await merge<Payment>('payment', (db) => db.payments)(evt, ctx);
  },
  'payment:updated': merge<Payment>('payment', (db) => db.payments),

  'expense:create': put<Expense>((db) => db.expenses),
  'expense:created': put<Expense>((db) => db.expenses),
  'expense:update': merge<Expense>('expense', (db) => db.expenses),
  'expense:updated': merge<Expense>('expense', (db) => db.expenses),

  'advance:create': put<Advance>((db) => db.advances),
  'advance:created': put<Advance>((db) => db.advances),
  // advance:update carries either a full Advance row or an application-merge
  // payload ({advance_id, application, remaining_paise}) — the latter is the
  // wire form of AdvanceService.applyAdvance after the worker's toProviderEvent
  // collapses 'updated' → 'update'. Detect the merge shape: fetch existing
  // row, append the new application, replace remaining_paise, put. Else put
  // the full row.
  'advance:update': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const isMerge = p.advance_id !== undefined && p.id === undefined;
    if (isMerge) {
      const advanceId = String(p.advance_id ?? '');
      const existing = await ctx.db.advances.get(advanceId);
      if (!existing) {
        ctx.diagnostics.push(
          `advance:update ${advanceId} (application merge): advance not found`,
        );
        return;
      }
      const application = p.application as
        | Advance['applications'][number]
        | undefined;
      const remaining =
        typeof p.remaining_paise === 'number'
          ? p.remaining_paise
          : existing.remaining_paise;
      // Idempotent append: if this application (matched by invoice_id +
      // amount_paise + applied_at + journal_entry_id) is already present,
      // don't append again. Replay MUST NOT double-apply.
      const applications = [...existing.applications];
      if (application) {
        const already = applications.some(
          (a) =>
            a.invoice_id === application.invoice_id &&
            a.bill_id === application.bill_id &&
            a.amount_paise === application.amount_paise &&
            a.applied_at === application.applied_at &&
            a.journal_entry_id === application.journal_entry_id,
        );
        if (!already) applications.push(application);
      }
      existing.applications = applications;
      existing.remaining_paise = remaining;
      await ctx.db.advances.put(existing);
      return;
    }
    await merge<Advance>('advance', (db) => db.advances)(evt, ctx);
  },
  'advance:updated': merge<Advance>('advance', (db) => db.advances),

  'sales_return:create': put<SalesReturn>((db) => db.sales_returns),
  'sales_return:created': put<SalesReturn>((db) => db.sales_returns),
  'sales_return:update': merge<SalesReturn>('sales_return', (db) => db.sales_returns),
  'sales_return:updated': merge<SalesReturn>('sales_return', (db) => db.sales_returns),
  'sales_return_item:create': put<SalesReturnItem>((db) => db.sales_return_items),
  'sales_return_item:created': put<SalesReturnItem>((db) => db.sales_return_items),
  'sales_return_item:update': merge<SalesReturnItem>(
    'sales_return_item',
    (db) => db.sales_return_items,
  ),

  'account:create': put<Account>((db) => db.accounts),
  'account:created': put<Account>((db) => db.accounts),
  'account:update': merge<Account>('account', (db) => db.accounts),
  'account:updated': merge<Account>('account', (db) => db.accounts),

  'journal_entry:posted': put<JournalEntry>((db) => db.journal_entries),
  'journal_entry:create': put<JournalEntry>((db) => db.journal_entries),
  'journal_entry:created': put<JournalEntry>((db) => db.journal_entries),
  // Older journal files can contain a full journal-entry row under `update`
  // (the original entry was written with the wrong verb). Rebuild that row
  // when the payload has its identifying header fields, but keep ignoring
  // genuinely partial orphan updates so they cannot create phantom entries.
  'journal_entry:update': async (evt, ctx) => {
    const payload = asRecord(evt.payload, evt.event_id);
    if (payload.entry_number !== undefined && payload.business_id !== undefined) {
      await put<JournalEntry>((db) => db.journal_entries)(evt, ctx);
      return;
    }
    await merge<JournalEntry>('journal_entry', (db) => db.journal_entries, {
      recordMissing: false,
    })(evt, ctx);
  },

  'journal_line:create': put<JournalLine>((db) => db.journal_lines),
  'journal_line:created': put<JournalLine>((db) => db.journal_lines),
  // Some legacy writers used `update` for a complete journal-line row. Rebuild
  // those rows when the identifying fields are present, but keep ignoring
  // genuinely partial orphan updates.
  'journal_line:update': async (evt, ctx) => {
    const payload = asRecord(evt.payload, evt.event_id);
    if (
      payload.business_id !== undefined &&
      payload.entry_id !== undefined &&
      payload.account_id !== undefined &&
      payload.debit_paise !== undefined &&
      payload.credit_paise !== undefined
    ) {
      await put<JournalLine>((db) => db.journal_lines)(evt, ctx);
      return;
    }
    await merge<JournalLine>('journal_line', (db) => db.journal_lines, {
      recordMissing: false,
    })(evt, ctx);
  },

  'stock_movement:movement': put<StockMovement>((db) => db.stock_movements),
  'stock_movement:create': put<StockMovement>((db) => db.stock_movements),
  'stock_movement:created': put<StockMovement>((db) => db.stock_movements),
  'stock_movement:update': put<StockMovement>((db) => db.stock_movements),

  // payment:allocated event carries {payment_id, allocations} — NOT a full
  // Payment row. Merge allocations into the existing row rather than put.
  // (In createPayment the earlier payment:created event already carries the
  // allocations, so this is defensive re-establishment.)
  'payment:allocated': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const paymentId = String(p.payment_id ?? p.id ?? '');
    if (!paymentId) {
      ctx.diagnostics.push(`payment:allocated ${evt.event_id} missing payment_id`);
      return;
    }
    const allocations = Array.isArray(p.allocations) ? p.allocations : [];
    const existing = await ctx.db.payments.get(paymentId);
    if (!existing) {
      ctx.diagnostics.push(`payment:allocated ${paymentId}: payment not found`);
      return;
    }
    existing.allocations = allocations as Payment['allocations'];
    await ctx.db.payments.put(existing);
  },

  // spec §24: never destructive. Edit reverses the original + emits a credit
  // note separately. Wire form is 'invoice:reverse' after syncWorker collapses
  // 'reversed' → 'reverse'. Payload = {invoice_id, voided_at, reason,
  // credit_note_invoice_id} — the 'voided_at' field name is retained for
  // backward-compat with journal files already written by earlier versions.
  // Sets reversed_by_invoice_id on the original; the credit note itself arrives
  // via a separate invoice:create event.
  'invoice:reverse': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const id = String(p.invoice_id ?? p.id ?? '');
    if (!id) {
      ctx.diagnostics.push(`invoice:reverse event ${evt.event_id} has no invoice_id`);
      return;
    }
    const inv = await ctx.db.invoices.get(id);
    if (!inv) {
      ctx.diagnostics.push(`invoice:reverse ${id}: invoice not found`);
      return;
    }
    inv.reversed_by_invoice_id =
      (p.credit_note_invoice_id as string | null | undefined) ??
      inv.reversed_by_invoice_id;
    inv.updated_at = String(p.voided_at ?? new Date().toISOString());
    await ctx.db.invoices.put(inv);
  },

  // Soft-delete an invoice + cascade the same deleted_at/deleted_reason to any
  // payments/advances the deleter identified as fully-allocated to this invoice.
  // Payload is {invoice_id, deleted_at, reason, cascaded_payment_ids,
  // cascaded_advance_ids}.
  'invoice:delete': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const id = String(p.invoice_id ?? p.id ?? '');
    if (!id) {
      ctx.diagnostics.push(`invoice:delete event ${evt.event_id} has no invoice_id`);
      return;
    }
    if (p.permanently_deleted === true) {
      const paymentIds = Array.isArray(p.cascaded_payment_ids)
        ? (p.cascaded_payment_ids as string[])
        : [];
      const advanceIds = Array.isArray(p.cascaded_advance_ids)
        ? (p.cascaded_advance_ids as string[])
        : [];
      const cascadeTag = `cascade:${id}`;
      const paymentsToDelete = (
        await ctx.db.payments.bulkGet(paymentIds)
      ).filter(
        (row): row is Payment =>
          !!row &&
          row.business_id === ctx.businessId &&
          row.deleted_reason === cascadeTag &&
          row.allocations.length > 0 &&
          row.allocations.every((allocation) => allocation.invoice_id === id),
      );
      const advancesToDelete = (
        await ctx.db.advances.bulkGet(advanceIds)
      ).filter(
        (row): row is Advance =>
          !!row &&
          row.business_id === ctx.businessId &&
          row.deleted_reason === cascadeTag &&
          row.remaining_paise === 0 &&
          row.applications.length > 0 &&
          row.applications.every((application) => application.invoice_id === id),
      );
      await ctx.db.invoice_line_return_summary
        .where('invoice_id')
        .equals(id)
        .delete();
      await ctx.db.invoice_lines.where('invoice_id').equals(id).delete();
      await ctx.db.payments.bulkDelete(paymentsToDelete.map((row) => row.id));
      await ctx.db.advances.bulkDelete(advancesToDelete.map((row) => row.id));
      await ctx.db.invoices.delete(id);
      return;
    }
    const inv = await ctx.db.invoices.get(id);
    if (!inv) {
      ctx.diagnostics.push(`invoice:delete ${id}: invoice not found`);
      return;
    }
    const deletedAt = String(p.deleted_at ?? new Date().toISOString());
    const reason = (p.reason as string | undefined) ?? '';
    inv.deleted_at = deletedAt;
    inv.deleted_reason = reason;
    inv.deletion_reversal_journal_id =
      (p.deletion_reversal_journal_id as string | null | undefined) ??
      inv.deletion_reversal_journal_id;
    inv.updated_at = deletedAt;
    await ctx.db.invoices.put(inv);
    const cascadeTag = `cascade:${id}`;
    const paymentIds = Array.isArray(p.cascaded_payment_ids)
      ? (p.cascaded_payment_ids as string[])
      : [];
    for (const pid of paymentIds) {
      const pay = await ctx.db.payments.get(pid);
      if (pay) {
        pay.deleted_at = deletedAt;
        pay.deleted_reason = cascadeTag;
        await ctx.db.payments.put(pay);
      }
    }
    const advanceIds = Array.isArray(p.cascaded_advance_ids)
      ? (p.cascaded_advance_ids as string[])
      : [];
    for (const aid of advanceIds) {
      const adv = await ctx.db.advances.get(aid);
      if (adv) {
        adv.deleted_at = deletedAt;
        adv.deleted_reason = cascadeTag;
        await ctx.db.advances.put(adv);
      }
    }
  },

  // Payment refund: PaymentService.refundPayment emits (a) a payment:create
  // for the new refund row (direction='out', negative amount, negative
  // allocations) and (b) a payment:reverse event carrying reversedPayload =
  // {payment_id, reversed_by_payment_id, reason, reversed_at} pointing at the
  // ORIGINAL. The refund payment row's own create event carries all the state
  // restore needs — the paid_paise rebuild sums signed allocations across
  // both. Payment type has no reversed_by_payment_id column, so this handler
  // is intentionally a validation-only no-op that keeps unhandled-event count
  // at zero. If the original ever goes missing, log a diagnostic.
  'payment:reverse': async (evt, ctx) => {
    const p = asRecord(evt.payload, evt.event_id);
    const id = String(p.payment_id ?? '');
    if (!id) {
      ctx.diagnostics.push(`payment:reverse event ${evt.event_id} has no payment_id`);
      return;
    }
    const existing = await ctx.db.payments.get(id);
    if (!existing) {
      ctx.diagnostics.push(`payment:reverse ${id}: original payment not found`);
    }
  },
};

export function getEventHandler(
  entityType: string,
  operation: string,
): EventHandler | undefined {
  return HANDLERS[`${entityType}:${operation}`];
}

export async function applyEvent(
  evt: SyncEvent,
  ctx: HandlerContext,
): Promise<'applied' | 'unhandled'> {
  if (evt.business_id !== ctx.businessId) {
    throw new Error(
      `event ${evt.event_id}: event belongs to business ${evt.business_id}, expected ${ctx.businessId}`,
    );
  }
  if (evt.payload && typeof evt.payload === 'object' && !Array.isArray(evt.payload)) {
    const payloadBusinessId = (evt.payload as { business_id?: unknown }).business_id;
    if (typeof payloadBusinessId === 'string' && payloadBusinessId !== ctx.businessId) {
      throw new Error(
        `event ${evt.event_id}: payload belongs to business ${payloadBusinessId}, expected ${ctx.businessId}`,
      );
    }
  }
  const h = getEventHandler(evt.entity_type, evt.operation);
  if (!h) {
    log.warn('restore.event.unhandled', 'restore: no event handler registered', {
      businessId: ctx.businessId,
      eventId: evt.event_id,
      entityType: evt.entity_type,
      operation: evt.operation,
      entityId: evt.entity_id,
      entityVersion: evt.entity_version,
    });
    return 'unhandled';
  }
  await h(evt, ctx);
  return 'applied';
}
