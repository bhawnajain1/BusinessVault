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
} from '../db/types';

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
  <T>(table: (db: BusinessVaultDB) => { put(v: T): Promise<unknown> }) =>
  async (evt: SyncEvent, ctx: HandlerContext): Promise<void> => {
    const row = asRecord(evt.payload, evt.event_id) as unknown as T;
    await table(ctx.db).put(row);
  };

const HANDLERS: Record<string, EventHandler> = {
  'business:create': put<unknown>((db) => db.businesses),
  'business:created': put<unknown>((db) => db.businesses),
  'business:update': put<unknown>((db) => db.businesses),
  'business:updated': put<unknown>((db) => db.businesses),

  'customer:create': put<Customer>((db) => db.customers),
  'customer:update': put<Customer>((db) => db.customers),
  'customer:created': put<Customer>((db) => db.customers),
  'customer:updated': put<Customer>((db) => db.customers),

  'supplier:create': put<Supplier>((db) => db.suppliers),
  'supplier:created': put<Supplier>((db) => db.suppliers),
  'supplier:update': put<Supplier>((db) => db.suppliers),
  'supplier:updated': put<Supplier>((db) => db.suppliers),

  'category:create': put<Category>((db) => db.categories),
  'category:created': put<Category>((db) => db.categories),

  'unit:create': put<Unit>((db) => db.units),
  'unit:created': put<Unit>((db) => db.units),

  'warehouse:create': put<Warehouse>((db) => db.warehouses),
  'warehouse:created': put<Warehouse>((db) => db.warehouses),

  'item:create': put<Item>((db) => db.items),
  'item:created': put<Item>((db) => db.items),
  'item:update': put<Item>((db) => db.items),
  'item:updated': put<Item>((db) => db.items),

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
          adv.deleted_at = null;
          adv.deleted_reason = null;
          await ctx.db.advances.put(adv);
        }
      }
      return;
    }
    await ctx.db.invoices.put(p as unknown as Invoice);
  },
  'invoice:updated': put<Invoice>((db) => db.invoices),

  'invoice_line:create': put<InvoiceLine>((db) => db.invoice_lines),
  'invoice_line:created': put<InvoiceLine>((db) => db.invoice_lines),
  // syncWorker collapses non-CRUD verbs to 'update' at the folder boundary
  // (see toProviderEvent). We accept the collapsed form so restore replays
  // journals written by shipped installs. Same table, same put — restore is
  // idempotent so the operation name doesn't affect the write.
  'invoice_line:update': put<InvoiceLine>((db) => db.invoice_lines),

  'purchase:create': put<Purchase>((db) => db.purchases),
  'purchase:created': put<Purchase>((db) => db.purchases),
  'purchase:update': put<Purchase>((db) => db.purchases),
  'purchase:updated': put<Purchase>((db) => db.purchases),

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
    await ctx.db.payments.put(p as unknown as Payment);
  },
  'payment:updated': put<Payment>((db) => db.payments),

  'expense:create': put<Expense>((db) => db.expenses),
  'expense:created': put<Expense>((db) => db.expenses),
  'expense:update': put<Expense>((db) => db.expenses),
  'expense:updated': put<Expense>((db) => db.expenses),

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
    await ctx.db.advances.put(p as unknown as Advance);
  },
  'advance:updated': put<Advance>((db) => db.advances),

  'account:create': put<Account>((db) => db.accounts),
  'account:created': put<Account>((db) => db.accounts),

  'journal_entry:posted': put<JournalEntry>((db) => db.journal_entries),
  'journal_entry:create': put<JournalEntry>((db) => db.journal_entries),
  'journal_entry:created': put<JournalEntry>((db) => db.journal_entries),
  'journal_entry:update': put<JournalEntry>((db) => db.journal_entries),

  'journal_line:create': put<JournalLine>((db) => db.journal_lines),
  'journal_line:created': put<JournalLine>((db) => db.journal_lines),
  'journal_line:update': put<JournalLine>((db) => db.journal_lines),

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
    const inv = await ctx.db.invoices.get(id);
    if (!inv) {
      ctx.diagnostics.push(`invoice:delete ${id}: invoice not found`);
      return;
    }
    const deletedAt = String(p.deleted_at ?? new Date().toISOString());
    const reason = (p.reason as string | undefined) ?? '';
    inv.deleted_at = deletedAt;
    inv.deleted_reason = reason;
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
  const h = getEventHandler(evt.entity_type, evt.operation);
  if (!h) return 'unhandled';
  await h(evt, ctx);
  return 'applied';
}
