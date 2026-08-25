import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type {
  Invoice,
  InvoiceLine,
  ItemStock,
  JournalEntry,
  JournalLine,
  Purchase,
  PurchaseLine,
  StockMovement,
} from '../db/types';
import { appendSyncEvent } from './syncEventLog';

export interface ReturnServiceDeps {
  db: BusinessVaultDB;
  now?: () => string;
}

export interface CreateSalesReturnInput {
  businessId: string;
  deviceId: string;
  originalInvoiceId: string;
  creditNoteNumber: string;
  returnDate: string;
  reason: string;
  idempotencyKey?: string;
}

export interface CreatePurchaseReturnInput {
  businessId: string;
  deviceId: string;
  originalPurchaseId: string;
  debitNoteNumber: string;
  returnDate: string;
  reason: string;
  idempotencyKey?: string;
}

export class ReturnService {
  private readonly db: BusinessVaultDB;
  private readonly now: () => string;

  constructor(deps: ReturnServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Sales return: create a NEW invoice row (credit note) that reverses the
   * original, positive stock movements (goods returned to us), and a reverse
   * journal entry. Original invoice and its journal are NEVER mutated destructively —
   * we set `reversed_by_invoice_id` as a pointer, but that is a metadata field
   * that the caller can override; the historical record remains.
   */
  async createSalesReturn(
    input: CreateSalesReturnInput,
  ): Promise<Invoice> {
    const db = this.db;
    const now = this.now();

    return db.transaction(
      'rw',
      [
        db.invoices,
        db.invoice_lines,
        db.stock_movements,
        db.item_stock,
        db.journal_entries,
        db.journal_lines,
        db.sync_events,
      ],
      async () => {
        const original = await db.invoices.get(input.originalInvoiceId);
        if (!original) {
          throw new Error(`Original invoice not found: ${input.originalInvoiceId}`);
        }
        if (original.business_id !== input.businessId) {
          throw new Error(
            `Invoice ${input.originalInvoiceId} does not belong to business ${input.businessId}`,
          );
        }
        if (original.reversed_by_invoice_id) {
          throw new Error(
            `Invoice ${input.originalInvoiceId} has already been reversed by ${original.reversed_by_invoice_id}`,
          );
        }

        const originalLines = await db.invoice_lines
          .where('invoice_id')
          .equals(original.id)
          .toArray();

        const originalJe = await db.journal_entries.get(original.journal_entry_id);
        if (!originalJe) {
          throw new Error(
            `Original journal entry not found: ${original.journal_entry_id}`,
          );
        }
        const originalJeLines = await db.journal_lines
          .where('entry_id')
          .equals(originalJe.id)
          .toArray();

        const creditNoteId = ulid();
        const reverseJeId = ulid();

        const creditNote: Invoice = {
          ...original,
          id: creditNoteId,
          invoice_number: input.creditNoteNumber.trim(),
          invoice_date: input.returnDate,
          subtotal_paise: -original.subtotal_paise,
          discount_paise: -original.discount_paise,
          taxable_paise: -original.taxable_paise,
          cgst_paise: -original.cgst_paise,
          sgst_paise: -original.sgst_paise,
          igst_paise: -original.igst_paise,
          cess_paise: -original.cess_paise,
          round_off_paise: -original.round_off_paise,
          total_paise: -original.total_paise,
          paid_paise: 0,
          balance_paise: -original.total_paise,
          status: 'issued',
          reversed_by_invoice_id: null,
          reverses_invoice_id: original.id,
          notes: `Credit note for invoice ${original.invoice_number}. Reason: ${input.reason}`,
          journal_entry_id: reverseJeId,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };

        const dup = await db.invoices
          .where('[business_id+invoice_number]')
          .equals([input.businessId, creditNote.invoice_number])
          .first();
        if (dup) {
          throw new Error(
            `Credit note number already exists: ${creditNote.invoice_number}`,
          );
        }

        const returnLines: InvoiceLine[] = originalLines.map((li, idx) => ({
          ...li,
          id: ulid(),
          invoice_id: creditNoteId,
          line_no: idx + 1,
          qty_micros: -li.qty_micros,
          discount_paise: -li.discount_paise,
          taxable_paise: -li.taxable_paise,
          cgst_paise: -li.cgst_paise,
          sgst_paise: -li.sgst_paise,
          igst_paise: -li.igst_paise,
          cess_paise: -li.cess_paise,
          line_total_paise: -li.line_total_paise,
        }));

        // Positive stock movements — goods returning to our warehouse.
        const movements: StockMovement[] = originalLines.map((li) => ({
          id: ulid(),
          business_id: input.businessId,
          item_id: li.item_id,
          warehouse_id: li.warehouse_id,
          movement_type: 'sale_return',
          qty_micros: Math.abs(li.qty_micros),
          unit_cost_paise: li.unit_price_paise,
          ref_type: 'invoice',
          ref_id: creditNoteId,
          occurred_at: now,
          notes: `Sales return ${creditNote.invoice_number}`,
        }));

        // Reverse journal entry: swap debit/credit of every line.
        const reverseJeLines: JournalLine[] = originalJeLines.map((jl, idx) => ({
          id: ulid(),
          business_id: input.businessId,
          entry_id: reverseJeId,
          line_no: idx + 1,
          account_id: jl.account_id,
          debit_paise: jl.credit_paise,
          credit_paise: jl.debit_paise,
          party_type: jl.party_type,
          party_id: jl.party_id,
          description: `Reversal: ${jl.description}`,
        }));

        const reverseJe: JournalEntry = {
          id: reverseJeId,
          business_id: input.businessId,
          entry_number: `JE-${creditNote.invoice_number}`,
          entry_date: creditNote.invoice_date,
          narration: `Sales return for ${original.invoice_number}: ${input.reason}`,
          ref_type: 'invoice',
          ref_id: creditNoteId,
          reversed_by_id: null,
          reverses_id: originalJe.id,
          total_debit_paise: originalJe.total_credit_paise,
          total_credit_paise: originalJe.total_debit_paise,
          posted: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        if (reverseJe.total_debit_paise !== reverseJe.total_credit_paise) {
          throw new Error('Sales return journal not balanced');
        }

        await db.invoices.add(creditNote);
        for (const l of returnLines) await db.invoice_lines.add(l);

        // Update original with pointer (single field, still same entity version)
        await db.invoices.put({
          ...original,
          reversed_by_invoice_id: creditNoteId,
          updated_at: now,
          entity_version: original.entity_version + 1,
        });

        for (const m of movements) {
          await db.stock_movements.add(m);
          const stockKey = `${input.businessId}:${m.item_id}:${m.warehouse_id}`;
          const existing = await db.item_stock.get(stockKey);
          if (existing) {
            await db.item_stock.put({
              ...existing,
              qty_micros: existing.qty_micros + m.qty_micros,
              updated_at: now,
            });
          } else {
            const row: ItemStock = {
              id: stockKey,
              business_id: input.businessId,
              item_id: m.item_id,
              warehouse_id: m.warehouse_id,
              qty_micros: m.qty_micros,
              avg_cost_paise: m.unit_cost_paise,
              updated_at: now,
            };
            await db.item_stock.add(row);
          }
        }

        await db.journal_entries.add(reverseJe);
        for (const l of reverseJeLines) await db.journal_lines.add(l);

        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'invoice',
          entityId: creditNote.id,
          operation: 'created',
          payload: { ...creditNote, reverses_invoice_id: original.id },
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'invoice',
          entityId: original.id,
          operation: 'updated',
          payload: {
            id: original.id,
            reversed_by_invoice_id: creditNoteId,
            entity_version: original.entity_version + 1,
          },
          timestamp: now,
        });
        for (const m of movements) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'stock_movement',
            entityId: m.id,
            operation: 'movement',
            payload: m,
            timestamp: now,
          });
        }
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'journal_entry',
          entityId: reverseJe.id,
          operation: 'posted',
          payload: reverseJe,
          timestamp: now,
        });
        for (const l of returnLines) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'invoice_line',
            entityId: l.id,
            operation: 'created',
            payload: l,
            timestamp: now,
          });
        }
        for (const l of reverseJeLines) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'journal_line',
            entityId: l.id,
            operation: 'created',
            payload: l,
            timestamp: now,
          });
        }

        return creditNote;
      },
    );
  }

  /**
   * Purchase return: NEW purchase row (debit note) that reverses the original.
   * Negative stock movements (goods leaving our warehouse). Reverse journal entry.
   * Original purchase gets its `reversed_by` pointer bumped but no destructive edit.
   *
   * Note: schema does not have `reversed_by_purchase_id` on Purchase, so we track
   * the reversal only via the debit-note purchase row (its journal_entries.reverses_id).
   */
  async createPurchaseReturn(
    input: CreatePurchaseReturnInput,
  ): Promise<Purchase> {
    const db = this.db;
    const now = this.now();

    return db.transaction(
      'rw',
      [
        db.purchases,
        db.purchase_lines,
        db.stock_movements,
        db.item_stock,
        db.journal_entries,
        db.journal_lines,
        db.sync_events,
      ],
      async () => {
        const original = await db.purchases.get(input.originalPurchaseId);
        if (!original) {
          throw new Error(
            `Original purchase not found: ${input.originalPurchaseId}`,
          );
        }
        if (original.business_id !== input.businessId) {
          throw new Error(
            `Purchase ${input.originalPurchaseId} does not belong to business ${input.businessId}`,
          );
        }
        const originalJe = await db.journal_entries.get(original.journal_entry_id);
        if (!originalJe) {
          throw new Error(
            `Original journal entry not found: ${original.journal_entry_id}`,
          );
        }
        // Refuse duplicate return. Either the FK is already set on the original,
        // or a legacy debit note exists (pre-FK) whose JE reverses the original's JE.
        if (original.reversed_by_purchase_id) {
          throw new Error(
            `Purchase ${original.id} has already been reversed by ${original.reversed_by_purchase_id}`,
          );
        }
        const existingReversal = await db.journal_entries
          .where('business_id')
          .equals(input.businessId)
          .and((je) => je.reverses_id === originalJe.id)
          .first();
        if (existingReversal) {
          throw new Error(
            `Purchase ${original.id} has already been reversed by JE ${existingReversal.id}`,
          );
        }

        const originalLines = await db.purchase_lines
          .where('purchase_id')
          .equals(original.id)
          .toArray();
        const originalJeLines = await db.journal_lines
          .where('entry_id')
          .equals(originalJe.id)
          .toArray();

        const debitNoteId = ulid();
        const reverseJeId = ulid();

        const debitNote: Purchase = {
          ...original,
          id: debitNoteId,
          bill_number: input.debitNoteNumber.trim(),
          supplier_bill_number: `RET-${original.supplier_bill_number}`,
          bill_date: input.returnDate,
          subtotal_paise: -original.subtotal_paise,
          discount_paise: -original.discount_paise,
          taxable_paise: -original.taxable_paise,
          cgst_paise: -original.cgst_paise,
          sgst_paise: -original.sgst_paise,
          igst_paise: -original.igst_paise,
          cess_paise: -original.cess_paise,
          round_off_paise: -original.round_off_paise,
          total_paise: -original.total_paise,
          paid_paise: 0,
          balance_paise: -original.total_paise,
          status: 'received',
          reversed_by_purchase_id: null,
          reverses_purchase_id: original.id,
          notes: `Debit note for bill ${original.bill_number}. Reason: ${input.reason}`,
          journal_entry_id: reverseJeId,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        const dup = await db.purchases
          .where('[business_id+bill_number]')
          .equals([input.businessId, debitNote.bill_number])
          .first();
        if (dup) {
          throw new Error(
            `Debit note number already exists: ${debitNote.bill_number}`,
          );
        }

        const returnLines: PurchaseLine[] = originalLines.map((li, idx) => ({
          ...li,
          id: ulid(),
          purchase_id: debitNoteId,
          line_no: idx + 1,
          qty_micros: -li.qty_micros,
          discount_paise: -li.discount_paise,
          taxable_paise: -li.taxable_paise,
          cgst_paise: -li.cgst_paise,
          sgst_paise: -li.sgst_paise,
          igst_paise: -li.igst_paise,
          cess_paise: -li.cess_paise,
          line_total_paise: -li.line_total_paise,
        }));

        // Negative stock movements — goods leaving.
        const movements: StockMovement[] = originalLines.map((li) => ({
          id: ulid(),
          business_id: input.businessId,
          item_id: li.item_id,
          warehouse_id: li.warehouse_id,
          movement_type: 'purchase_return',
          qty_micros: -Math.abs(li.qty_micros),
          unit_cost_paise: li.unit_cost_paise,
          ref_type: 'purchase',
          ref_id: debitNoteId,
          occurred_at: now,
          notes: `Purchase return ${debitNote.bill_number}`,
        }));

        const reverseJeLines: JournalLine[] = originalJeLines.map((jl, idx) => ({
          id: ulid(),
          business_id: input.businessId,
          entry_id: reverseJeId,
          line_no: idx + 1,
          account_id: jl.account_id,
          debit_paise: jl.credit_paise,
          credit_paise: jl.debit_paise,
          party_type: jl.party_type,
          party_id: jl.party_id,
          description: `Reversal: ${jl.description}`,
        }));

        const reverseJe: JournalEntry = {
          id: reverseJeId,
          business_id: input.businessId,
          entry_number: `JE-${debitNote.bill_number}`,
          entry_date: debitNote.bill_date,
          narration: `Purchase return for ${original.bill_number}: ${input.reason}`,
          ref_type: 'purchase',
          ref_id: debitNoteId,
          reversed_by_id: null,
          reverses_id: originalJe.id,
          total_debit_paise: originalJe.total_credit_paise,
          total_credit_paise: originalJe.total_debit_paise,
          posted: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        if (reverseJe.total_debit_paise !== reverseJe.total_credit_paise) {
          throw new Error('Purchase return journal not balanced');
        }

        await db.purchases.add(debitNote);
        for (const l of returnLines) await db.purchase_lines.add(l);

        // Mark the original with a back-pointer so computePayables can attach
        // the debit note directly (no more supplier-level FIFO pool). Mirrors
        // the sales-return path above which sets reversed_by_invoice_id.
        await db.purchases.put({
          ...original,
          reversed_by_purchase_id: debitNoteId,
          updated_at: now,
          entity_version: original.entity_version + 1,
        });

        for (const m of movements) {
          await db.stock_movements.add(m);
          const stockKey = `${input.businessId}:${m.item_id}:${m.warehouse_id}`;
          const existing = await db.item_stock.get(stockKey);
          if (existing) {
            await db.item_stock.put({
              ...existing,
              qty_micros: existing.qty_micros + m.qty_micros,
              updated_at: now,
            });
          } else {
            const row: ItemStock = {
              id: stockKey,
              business_id: input.businessId,
              item_id: m.item_id,
              warehouse_id: m.warehouse_id,
              qty_micros: m.qty_micros,
              avg_cost_paise: m.unit_cost_paise,
              updated_at: now,
            };
            await db.item_stock.add(row);
          }
        }
        await db.journal_entries.add(reverseJe);
        for (const l of reverseJeLines) await db.journal_lines.add(l);

        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'purchase',
          entityId: debitNote.id,
          operation: 'created',
          payload: debitNote,
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'purchase',
          entityId: original.id,
          operation: 'updated',
          payload: {
            id: original.id,
            reversed_by_purchase_id: debitNoteId,
            entity_version: original.entity_version + 1,
          },
          timestamp: now,
        });
        for (const m of movements) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'stock_movement',
            entityId: m.id,
            operation: 'movement',
            payload: m,
            timestamp: now,
          });
        }
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'journal_entry',
          entityId: reverseJe.id,
          operation: 'posted',
          payload: reverseJe,
          timestamp: now,
        });
        for (const l of returnLines) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'purchase_line',
            entityId: l.id,
            operation: 'created',
            payload: l,
            timestamp: now,
          });
        }
        for (const l of reverseJeLines) {
          await appendSyncEvent(db, {
            businessId: input.businessId,
            deviceId: input.deviceId,
            entityType: 'journal_line',
            entityId: l.id,
            operation: 'created',
            payload: l,
            timestamp: now,
          });
        }

        return debitNote;
      },
    );
  }
}

export function createReturnService(
  deps: ReturnServiceDeps,
): ReturnService {
  return new ReturnService(deps);
}
