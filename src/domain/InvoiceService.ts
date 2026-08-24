import Dexie from 'dexie';
import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
  Account,
  Invoice,
  InvoiceLine,
  InvoiceStatus,
  ItemStock,
  JournalEntry,
  JournalLine,
  StockMovement,
  SyncEvent,
} from '../db/types';
import { canonicalJson, sha256Hex, GENESIS_HASH } from '../journal/event';
import { bankersRound } from './gst';
import { log } from '../lib/log';

// ---------- Account codes (system chart of accounts) ----------
// These must exist in the accounts table before an invoice can be created.
// AccountingService bootstraps them; see spec §8 accounting posting.
const ACC_RECEIVABLE_CODE = '1200';
const ACC_SALES_REVENUE_CODE = '4000';
const ACC_OUTPUT_CGST_CODE = '2210';
const ACC_OUTPUT_SGST_CODE = '2220';
const ACC_OUTPUT_IGST_CODE = '2230';
const ACC_OUTPUT_CESS_CODE = '2240';
const ACC_ROUND_OFF_CODE = '4900';
const ACC_COGS_CODE = '5020';
const ACC_INVENTORY_CODE = '1400';

// ---------- Public input types ----------
export interface CreateInvoiceLineInput {
  item_id: string;
  description?: string;
  hsn: string;
  warehouse_id: string;
  qty_micros: number;
  unit_price_paise: number;
  discount_pct_bps?: number;
  discount_paise?: number;
  taxable_paise: number;
  tax_rate_bps: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  cess_paise?: number;
  line_total_paise: number;
  // whether this line's item is inventory-tracked. If undefined we look up.
  track_inventory?: boolean;
}

export interface CreateInvoiceInput {
  business_id: string;
  device_id: string;
  invoice_number: string;
  invoice_date: string; // YYYY-MM-DD
  due_date?: string | null;
  customer_id: string;
  customer_state_code: string;
  place_of_supply: string;
  is_interstate: boolean;
  financial_year: string;
  lines: CreateInvoiceLineInput[];
  discount_paise?: number;
  round_off_paise?: number;
  notes?: string;
  terms?: string;
  idempotencyKey?: string;
}

export interface ReversalResult {
  originalInvoice: Invoice;
  creditNote: Invoice;
  reversingJournalEntryId: string;
}

export interface ListFilter {
  business_id: string;
  customer_id?: string;
  status?: InvoiceStatus;
  financial_year?: string;
  from_date?: string;
  to_date?: string;
}

export interface Pagination {
  offset?: number;
  limit?: number;
}

export class InvoiceService {
  constructor(private readonly db: BusinessVaultDB = defaultDb) {}

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    if (input.lines.length === 0) {
      throw new Error('InvoiceService.createInvoice: at least one line required');
    }

    // Idempotency short-circuit — check OUTSIDE the tx first to avoid rework
    // in the common case. Rechecked inside the tx for correctness.
    if (input.idempotencyKey) {
      const existing = await findByIdempotencyKey(
        this.db,
        input.business_id,
        input.idempotencyKey,
      );
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const invoiceId = ulid();
    const journalEntryId = ulid();

    // Compute totals from lines (defense in depth — caller supplied but we recompute).
    // Round each line's gross to integer paise using banker's rounding, then sum
    // integers, so subtotal_paise is guaranteed to be an integer even when a
    // line's (unit_price_paise * qty_micros / 1_000_000) is non-integer.
    const subtotalPaise = sumField(
      input.lines,
      (l) => bankersRound((l.unit_price_paise * l.qty_micros) / 1_000_000),
    );
    const lineTaxable = sum(input.lines.map((l) => l.taxable_paise));
    const lineCgst = sum(input.lines.map((l) => l.cgst_paise));
    const lineSgst = sum(input.lines.map((l) => l.sgst_paise));
    const lineIgst = sum(input.lines.map((l) => l.igst_paise));
    const lineCess = sum(input.lines.map((l) => l.cess_paise ?? 0));
    const discountPaise = input.discount_paise ?? 0;
    const roundOff = input.round_off_paise ?? 0;
    const totalPaise = lineTaxable + lineCgst + lineSgst + lineIgst + lineCess + roundOff;

    // Sanity: interstate ⇒ no CGST/SGST; intrastate ⇒ no IGST
    if (input.is_interstate && (lineCgst > 0 || lineSgst > 0)) {
      throw new Error('Interstate invoice must not carry CGST/SGST');
    }
    if (!input.is_interstate && lineIgst > 0) {
      throw new Error('Intrastate invoice must not carry IGST');
    }

    const invoice: Invoice = {
      id: invoiceId,
      business_id: input.business_id,
      invoice_number: input.invoice_number,
      invoice_date: input.invoice_date,
      due_date: input.due_date ?? null,
      customer_id: input.customer_id,
      customer_state_code: input.customer_state_code,
      place_of_supply: input.place_of_supply,
      is_interstate: input.is_interstate ? 1 : 0,
      financial_year: input.financial_year,
      subtotal_paise: subtotalPaise,
      discount_paise: discountPaise,
      taxable_paise: lineTaxable,
      cgst_paise: lineCgst,
      sgst_paise: lineSgst,
      igst_paise: lineIgst,
      cess_paise: lineCess,
      round_off_paise: roundOff,
      total_paise: totalPaise,
      paid_paise: 0,
      balance_paise: totalPaise,
      status: 'issued',
      reversed_by_invoice_id: null,
      reverses_invoice_id: null,
      notes: input.notes ?? '',
      terms: input.terms ?? '',
      pdf_attachment_id: null,
      journal_entry_id: journalEntryId,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const invoiceLines: InvoiceLine[] = input.lines.map((l, idx) => ({
      id: ulid(),
      business_id: input.business_id,
      invoice_id: invoiceId,
      line_no: idx + 1,
      item_id: l.item_id,
      description: l.description ?? '',
      hsn: l.hsn,
      warehouse_id: l.warehouse_id,
      qty_micros: l.qty_micros,
      unit_price_paise: l.unit_price_paise,
      discount_pct_bps: l.discount_pct_bps ?? 0,
      discount_paise: l.discount_paise ?? 0,
      taxable_paise: l.taxable_paise,
      tax_rate_bps: l.tax_rate_bps,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_paise: l.cess_paise ?? 0,
      line_total_paise: l.line_total_paise,
    }));

    // Journal lines: Dr AR / Cr Sales / Cr GST — must balance to the paise.
    // Signature of double-entry: SUM(debits) === SUM(credits) === total_paise.
    // Account lookups happen BEFORE the transaction because Dexie forbids
    // interleaving non-Dexie awaits (like SubtleCrypto.digest) inside a tx.
    const journalLines = await this.buildInvoiceJournalLines(
      input.business_id,
      journalEntryId,
      totalPaise,
      lineTaxable,
      lineCgst,
      lineSgst,
      lineIgst,
      lineCess,
    );

    // Pre-compute payload hash outside the tx (SubtleCrypto is async & not
    // Dexie-aware; awaiting it inside the tx would trigger PrematureCommitError).
    const invoiceEventPayload = { ...invoice, idempotencyKey: input.idempotencyKey ?? null };
    const invoicePayloadHash = await sha256Hex(canonicalJson(invoiceEventPayload));

    const journalEntry: JournalEntry = {
      id: journalEntryId,
      business_id: input.business_id,
      entry_number: `JE-${invoiceId}`,
      entry_date: input.invoice_date,
      narration: `Sales invoice ${input.invoice_number}`,
      ref_type: 'invoice',
      ref_id: invoiceId,
      reversed_by_id: null,
      reverses_id: null,
      total_debit_paise: totalPaise,
      total_credit_paise: totalPaise,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    // ---- The single atomic transaction (spec §8) ----
    return await this.db.transaction(
      'rw',
      [
        this.db.invoices,
        this.db.invoice_lines,
        this.db.items,
        this.db.item_stock,
        this.db.stock_movements,
        this.db.accounts,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        // Idempotency recheck INSIDE the transaction.
        if (input.idempotencyKey) {
          const already = await this.db.sync_events
            .where('[business_id+entity_type+entity_id]')
            .between(
              [input.business_id, 'invoice', ''],
              [input.business_id, 'invoice', '￿'],
            )
            .filter(
              (e) =>
                (e.payload as { idempotencyKey?: string } | null)?.idempotencyKey ===
                input.idempotencyKey,
            )
            .first();
          if (already) {
            const existing = await this.db.invoices.get(
              (already.payload as { id: string }).id,
            );
            if (existing) return existing;
          }
        }

        // 1. invoices row
        await this.db.invoices.add(invoice);

        // 2. invoice_lines rows + one sync event per line so restore can
        //    rehydrate the ledger. Handlers live at eventHandlers.ts.
        await this.db.invoice_lines.bulkAdd(invoiceLines);
        for (const line of invoiceLines) {
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'invoice_line',
            entity_id: line.id,
            operation: 'create' as SyncEvent['operation'],
            entity_version: 1,
            timestamp: now,
            payload: line,
          });
        }

        // 3. inventory reduction — stock_movements + item_stock decrement
        // Accumulate COGS across all inventory-tracked lines so we can post a
        // balanced Dr COGS / Cr Inventory pair alongside the sales journal.
        let totalCogsPaise = 0;
        for (const line of invoiceLines) {
          const item = await this.db.items.get(line.item_id);
          if (!item) {
            throw new Error(`Item not found: ${line.item_id}`);
          }
          if (item.track_inventory === 1) {
            const { cogsPaise } = await reduceStock(
              this.db,
              input.business_id,
              input.device_id,
              line.item_id,
              line.warehouse_id,
              line.qty_micros,
              invoiceId,
              input.invoice_date,
            );
            totalCogsPaise += cogsPaise;
          }
        }

        // 4. receivables — modelled as the AR journal line (Dr Accounts Receivable
        //    for total_paise, party_type=customer, party_id=customer_id). No
        //    separate receivables table exists; AR line IS the receivable of record.
        //    (Payments allocate against invoices, and invoice.balance_paise tracks
        //    open AR per invoice.)

        // 5. accounting: journal entry + balanced lines
        // If any inventory-tracked lines had a moving-average cost > 0, append
        // Dr COGS / Cr Inventory to the same journal. This pair is self-balancing
        // (Dr === Cr) so the whole entry stays balanced.
        const linesToPost = [...journalLines];
        if (totalCogsPaise > 0) {
          const cogsAcc = await requireAccount(
            this.db,
            input.business_id,
            ACC_COGS_CODE,
          );
          const invAcc = await requireAccount(
            this.db,
            input.business_id,
            ACC_INVENTORY_CODE,
          );
          const nextLineNo = linesToPost.length + 1;
          linesToPost.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: nextLineNo,
            account_id: cogsAcc.id,
            debit_paise: totalCogsPaise,
            credit_paise: 0,
            party_type: null,
            party_id: null,
            description: 'Cost of goods sold',
          });
          linesToPost.push({
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: nextLineNo + 1,
            account_id: invAcc.id,
            debit_paise: 0,
            credit_paise: totalCogsPaise,
            party_type: null,
            party_id: null,
            description: 'Inventory reduction',
          });
          journalEntry.total_debit_paise += totalCogsPaise;
          journalEntry.total_credit_paise += totalCogsPaise;
        }
        await this.db.journal_entries.add(journalEntry);
        await this.db.journal_lines.bulkAdd(linesToPost);
        assertBalanced(linesToPost);

        // 5b. sync events for journal_entry + each journal_line so restore
        //     rebuilds the ledger, not just the invoice header.
        await writeEventInTx(this.db, {
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: journalEntry.id,
          operation: 'posted' as SyncEvent['operation'],
          entity_version: 1,
          timestamp: now,
          payload: journalEntry,
        });
        for (const jl of linesToPost) {
          await writeEventInTx(this.db, {
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'create' as SyncEvent['operation'],
            entity_version: 1,
            timestamp: now,
            payload: jl,
          });
        }

        // 6. sync event — atomically written in the same tx.
        // Hash chain: previous_hash = the latest event's payload_hash for this business.
        // We read the tail INSIDE the tx to observe any concurrently-committed events.
        await writeEventInTx(this.db, {
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'invoice',
          entity_id: invoiceId,
          operation: 'created',
          entity_version: 1,
          timestamp: now,
          payload: invoiceEventPayload,
          payload_hash: invoicePayloadHash,
        });

        log.info('invoice', 'created', {
          invoiceId,
          businessId: input.business_id,
          number: invoice.invoice_number,
          totalPaise: invoice.total_paise,
          lineCount: input.lines.length,
        });
        return invoice;
      },
    );
  }

  // Internal mechanism used by updateInvoice to preserve the append-only journal
  // invariant during an edit: post a reversing JE + emit a mirror-negative credit
  // note that carries the original's amount back off the books. The original row
  // stays intact (audit chain). NOT a user-facing "void" — the user-facing surface
  // is Edit + Delete (see updateInvoice / deleteInvoice).
  private async reverseInvoicePosting(
    invoiceId: string,
    reason: string,
  ): Promise<ReversalResult> {
    if (!reason || reason.trim().length === 0) {
      throw new Error('reversal reason required');
    }

    const original = await this.db.invoices.get(invoiceId);
    if (!original) throw new Error(`Invoice not found: ${invoiceId}`);
    if (original.reversed_by_invoice_id) {
      throw new Error('Invoice already reversed');
    }

    const now = new Date().toISOString();
    const creditNoteId = ulid();
    const reversalJournalId = ulid();

    // Fetch original journal lines to reverse them exactly (defensive).
    const originalJournal = await this.db.journal_entries.get(original.journal_entry_id);
    if (!originalJournal) throw new Error('Original journal entry missing');
    const originalLines = await this.db.journal_lines
      .where('entry_id')
      .equals(original.journal_entry_id)
      .toArray();
    const originalInvoiceLines = await this.db.invoice_lines
      .where('invoice_id')
      .equals(invoiceId)
      .toArray();

    // Reversing journal: swap debit/credit on each line.
    const reversalLines: JournalLine[] = originalLines.map((l, idx) => ({
      id: ulid(),
      business_id: l.business_id,
      entry_id: reversalJournalId,
      line_no: idx + 1,
      account_id: l.account_id,
      debit_paise: l.credit_paise,
      credit_paise: l.debit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      description: `Reversal: ${l.description}`,
    }));

    const reversalJournal: JournalEntry = {
      id: reversalJournalId,
      business_id: original.business_id,
      entry_number: `JE-REV-${creditNoteId}`,
      entry_date: original.invoice_date,
      narration: `Reversal of ${original.invoice_number}: ${reason}`,
      ref_type: 'reversal',
      ref_id: creditNoteId,
      reversed_by_id: null,
      reverses_id: original.journal_entry_id,
      total_debit_paise: originalJournal.total_credit_paise,
      total_credit_paise: originalJournal.total_debit_paise,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    // Credit note = a negative-mirror invoice pointing back at the original.
    const creditNote: Invoice = {
      ...original,
      id: creditNoteId,
      invoice_number: `${original.invoice_number}-CN`,
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
      reverses_invoice_id: invoiceId,
      journal_entry_id: reversalJournalId,
      notes: `Credit note for ${original.invoice_number}. Reason: ${reason}`,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    // Pre-compute hashes outside tx (SubtleCrypto).
    // NOTE: payload field `voided_at` is retained for backwards wire compatibility
    // with journal files already written by earlier versions of this app.
    const reversalPayload = {
      invoice_id: invoiceId,
      voided_at: now,
      reason,
      credit_note_invoice_id: creditNoteId,
    };
    const reversalHash = await sha256Hex(canonicalJson(reversalPayload));
    const creditNotePayload = creditNote;
    const creditNoteHash = await sha256Hex(canonicalJson(creditNotePayload));

    return await this.db.transaction(
      'rw',
      [
        this.db.invoices,
        this.db.invoice_lines,
        this.db.items,
        this.db.item_stock,
        this.db.stock_movements,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        // Mark original as reversed (append-only: we do NOT delete rows).
        await this.db.invoices.update(invoiceId, {
          reversed_by_invoice_id: creditNoteId,
          updated_at: now,
          entity_version: original.entity_version + 1,
        });

        // Insert credit note invoice + mirror lines.
        await this.db.invoices.add(creditNote);
        const creditNoteLines: InvoiceLine[] = originalInvoiceLines.map((l) => ({
          ...l,
          id: ulid(),
          invoice_id: creditNoteId,
          qty_micros: -l.qty_micros,
          discount_paise: -l.discount_paise,
          taxable_paise: -l.taxable_paise,
          cgst_paise: -l.cgst_paise,
          sgst_paise: -l.sgst_paise,
          igst_paise: -l.igst_paise,
          cess_paise: -l.cess_paise,
          line_total_paise: -l.line_total_paise,
        }));
        await this.db.invoice_lines.bulkAdd(creditNoteLines);
        for (const cnl of creditNoteLines) {
          await writeEventInTx(this.db, {
            business_id: original.business_id,
            device_id: 'system',
            entity_type: 'invoice_line',
            entity_id: cnl.id,
            operation: 'create' as SyncEvent['operation'],
            entity_version: 1,
            timestamp: now,
            payload: cnl,
          });
        }

        // Reverse stock: return goods to inventory as sale_return.
        for (const line of originalInvoiceLines) {
          const item = await this.db.items.get(line.item_id);
          if (item && item.track_inventory === 1) {
            await returnStock(
              this.db,
              original.business_id,
              'system',
              line.item_id,
              line.warehouse_id,
              line.qty_micros,
              creditNoteId,
              original.invoice_date,
            );
          }
        }

        // Reversing journal.
        await this.db.journal_entries.add(reversalJournal);
        await this.db.journal_lines.bulkAdd(reversalLines);
        assertBalanced(reversalLines);
        await writeEventInTx(this.db, {
          business_id: original.business_id,
          device_id: 'system',
          entity_type: 'journal_entry',
          entity_id: reversalJournal.id,
          operation: 'posted' as SyncEvent['operation'],
          entity_version: 1,
          timestamp: now,
          payload: reversalJournal,
        });
        for (const rl of reversalLines) {
          await writeEventInTx(this.db, {
            business_id: original.business_id,
            device_id: 'system',
            entity_type: 'journal_line',
            entity_id: rl.id,
            operation: 'create' as SyncEvent['operation'],
            entity_version: 1,
            timestamp: now,
            payload: rl,
          });
        }

        // Sync events for the reversal + the credit note.
        await writeEventInTx(this.db, {
          business_id: original.business_id,
          device_id: 'system',
          entity_type: 'invoice',
          entity_id: invoiceId,
          operation: 'reversed',
          entity_version: original.entity_version + 1,
          timestamp: now,
          payload: reversalPayload,
          payload_hash: reversalHash,
        });
        await writeEventInTx(this.db, {
          business_id: original.business_id,
          device_id: 'system',
          entity_type: 'invoice',
          entity_id: creditNoteId,
          operation: 'created',
          entity_version: 1,
          timestamp: now,
          payload: creditNotePayload,
          payload_hash: creditNoteHash,
        });

        const updatedOriginal = await this.db.invoices.get(invoiceId);
        return {
          originalInvoice: updatedOriginal ?? original,
          creditNote,
          reversingJournalEntryId: reversalJournalId,
        };
      },
    );
  }

  /**
   * Soft-delete an invoice into the Recycle Bin. Journal entries and hash chain
   * stay intact (audit-preserving); only `deleted_at` + `deleted_reason` are set
   * on the invoice, its linked payments, and any advances applied to it. Restore
   * clears the same fields. Idempotent — deleting an already-deleted invoice is
   * a no-op.
   *
   * Notes on cascade: payments/advances with allocations spanning multiple
   * invoices are only soft-deleted when the deleted invoice is their SOLE
   * remaining allocation target — otherwise they'd disappear from party ledgers
   * where they still legitimately apply.
   */
  async deleteInvoice(invoiceId: string, reason: string): Promise<void> {
    const invoice = await this.db.invoices.get(invoiceId);
    if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
    if (invoice.deleted_at) return; // idempotent

    const now = new Date().toISOString();
    const trimmedReason = (reason ?? '').trim() || 'deleted';

    // Find linked payments (allocation touches this invoice). Dexie has no
    // index on allocation contents, so we scan the business's payments — small
    // volume in practice.
    const allPayments = await this.db.payments
      .where('business_id')
      .equals(invoice.business_id)
      .toArray();
    const paymentsToHide = allPayments.filter((p) => {
      if (p.deleted_at) return false;
      const targets = p.allocations ?? [];
      if (targets.length === 0) return false;
      // Only cascade if every remaining (non-deleted) allocation targets this invoice.
      return targets.every((a) => a.invoice_id === invoiceId);
    });

    const allAdvances = await this.db.advances
      .where('business_id')
      .equals(invoice.business_id)
      .toArray();
    const advancesToHide = allAdvances.filter((a) => {
      if (a.deleted_at) return false;
      const apps = a.applications ?? [];
      if (apps.length === 0) return false;
      return apps.every((app) => app.invoice_id === invoiceId);
    });

    const payload = {
      invoice_id: invoiceId,
      deleted_at: now,
      reason: trimmedReason,
      cascaded_payment_ids: paymentsToHide.map((p) => p.id),
      cascaded_advance_ids: advancesToHide.map((a) => a.id),
    };
    const payloadHash = await sha256Hex(canonicalJson(payload));

    await this.db.transaction(
      'rw',
      [this.db.invoices, this.db.payments, this.db.advances, this.db.sync_events],
      async () => {
        await this.db.invoices.update(invoiceId, {
          deleted_at: now,
          deleted_reason: trimmedReason,
          updated_at: now,
          entity_version: invoice.entity_version + 1,
        });
        for (const p of paymentsToHide) {
          await this.db.payments.update(p.id, {
            deleted_at: now,
            deleted_reason: `cascade:${invoiceId}`,
            updated_at: now,
            entity_version: p.entity_version + 1,
          });
        }
        for (const a of advancesToHide) {
          await this.db.advances.update(a.id, {
            deleted_at: now,
            deleted_reason: `cascade:${invoiceId}`,
            updated_at: now,
            entity_version: a.entity_version + 1,
          });
        }
        await writeEventInTx(this.db, {
          business_id: invoice.business_id,
          device_id: 'system',
          entity_type: 'invoice',
          entity_id: invoiceId,
          operation: 'deleted',
          entity_version: invoice.entity_version + 1,
          timestamp: now,
          payload,
          payload_hash: payloadHash,
        });
      },
    );
  }

  /**
   * Restore a soft-deleted invoice from the Recycle Bin. Also clears the
   * cascade flag on any payment/advance we marked with `cascade:${invoiceId}`.
   * Idempotent — restoring a non-deleted invoice is a no-op.
   */
  async restoreInvoice(invoiceId: string): Promise<void> {
    const invoice = await this.db.invoices.get(invoiceId);
    if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
    if (!invoice.deleted_at) return; // idempotent

    const now = new Date().toISOString();
    const cascadeTag = `cascade:${invoiceId}`;

    const allPayments = await this.db.payments
      .where('business_id')
      .equals(invoice.business_id)
      .toArray();
    const paymentsToRestore = allPayments.filter((p) => p.deleted_reason === cascadeTag);

    const allAdvances = await this.db.advances
      .where('business_id')
      .equals(invoice.business_id)
      .toArray();
    const advancesToRestore = allAdvances.filter((a) => a.deleted_reason === cascadeTag);

    const payload = {
      invoice_id: invoiceId,
      restored_at: now,
      restored_payment_ids: paymentsToRestore.map((p) => p.id),
      restored_advance_ids: advancesToRestore.map((a) => a.id),
    };
    const payloadHash = await sha256Hex(canonicalJson(payload));

    await this.db.transaction(
      'rw',
      [this.db.invoices, this.db.payments, this.db.advances, this.db.sync_events],
      async () => {
        await this.db.invoices.update(invoiceId, {
          deleted_at: null,
          deleted_reason: null,
          updated_at: now,
          entity_version: invoice.entity_version + 1,
        });
        for (const p of paymentsToRestore) {
          await this.db.payments.update(p.id, {
            deleted_at: null,
            deleted_reason: null,
            updated_at: now,
            entity_version: p.entity_version + 1,
          });
        }
        for (const a of advancesToRestore) {
          await this.db.advances.update(a.id, {
            deleted_at: null,
            deleted_reason: null,
            updated_at: now,
            entity_version: a.entity_version + 1,
          });
        }
        await writeEventInTx(this.db, {
          business_id: invoice.business_id,
          device_id: 'system',
          entity_type: 'invoice',
          entity_id: invoiceId,
          operation: 'updated',
          entity_version: invoice.entity_version + 1,
          timestamp: now,
          payload,
          payload_hash: payloadHash,
        });
      },
    );
  }

  /**
   * Edit an existing invoice. To preserve the append-only journal invariant
   * (spec §24) the underlying implementation reverses the original's postings —
   * emits a reversing journal + a mirror-negative credit note — and then posts a
   * fresh invoice under the same invoice_number. The reversed original stays in
   * the ledger for audit; UI filters it out of default list views. Callers see
   * a normal "edit" — the reversal shape is not surfaced.
   */
  async updateInvoice(
    invoiceId: string,
    input: Omit<CreateInvoiceInput, 'invoice_number' | 'idempotencyKey'>,
  ): Promise<Invoice> {
    const original = await this.db.invoices.get(invoiceId);
    if (!original) throw new Error(`Invoice not found: ${invoiceId}`);
    if (original.reversed_by_invoice_id) {
      throw new Error('Cannot edit an already-superseded invoice');
    }
    await this.reverseInvoicePosting(invoiceId, 'edit');
    return this.createInvoice({
      ...input,
      invoice_number: original.invoice_number,
    });
  }

  async listInvoices(filter: ListFilter, pagination: Pagination = {}): Promise<Invoice[]> {
    const offset = pagination.offset ?? 0;
    const limit = pagination.limit ?? 50;

    let coll = this.db.invoices.where('business_id').equals(filter.business_id);
    if (filter.customer_id) {
      coll = this.db.invoices
        .where('[business_id+customer_id]')
        .equals([filter.business_id, filter.customer_id]);
    } else if (filter.status) {
      coll = this.db.invoices
        .where('[business_id+status]')
        .equals([filter.business_id, filter.status]);
    } else if (filter.financial_year) {
      coll = this.db.invoices
        .where('[business_id+financial_year]')
        .equals([filter.business_id, filter.financial_year]);
    }

    const rows = await coll
      .filter((inv) => {
        if (filter.customer_id && inv.customer_id !== filter.customer_id) return false;
        if (filter.status && inv.status !== filter.status) return false;
        if (filter.financial_year && inv.financial_year !== filter.financial_year) return false;
        if (filter.from_date && inv.invoice_date < filter.from_date) return false;
        if (filter.to_date && inv.invoice_date > filter.to_date) return false;
        return true;
      })
      .offset(offset)
      .limit(limit)
      .toArray();

    return rows;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    return this.db.invoices.get(id);
  }

  // ---------- private helpers ----------

  private async buildInvoiceJournalLines(
    businessId: string,
    entryId: string,
    total: number,
    net: number,
    cgst: number,
    sgst: number,
    igst: number,
    cess: number = 0,
  ): Promise<JournalLine[]> {
    const ar = await requireAccount(this.db, businessId, ACC_RECEIVABLE_CODE);
    const sales = await requireAccount(this.db, businessId, ACC_SALES_REVENUE_CODE);

    const lines: JournalLine[] = [];
    let lineNo = 1;

    // Dr Accounts Receivable — total (net + all GST)
    lines.push({
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: lineNo++,
      account_id: ar.id,
      debit_paise: total,
      credit_paise: 0,
      party_type: 'customer',
      party_id: null, // filled by caller-context; keep null at journal level
      description: 'Accounts Receivable',
    });

    // Cr Sales Revenue — net (taxable)
    lines.push({
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: lineNo++,
      account_id: sales.id,
      debit_paise: 0,
      credit_paise: net,
      party_type: null,
      party_id: null,
      description: 'Sales revenue',
    });

    if (igst > 0) {
      const igstAcc = await requireAccount(this.db, businessId, ACC_OUTPUT_IGST_CODE);
      lines.push({
        id: ulid(),
        business_id: businessId,
        entry_id: entryId,
        line_no: lineNo++,
        account_id: igstAcc.id,
        debit_paise: 0,
        credit_paise: igst,
        party_type: null,
        party_id: null,
        description: 'Output IGST',
      });
    }
    if (cgst > 0) {
      const cgstAcc = await requireAccount(this.db, businessId, ACC_OUTPUT_CGST_CODE);
      lines.push({
        id: ulid(),
        business_id: businessId,
        entry_id: entryId,
        line_no: lineNo++,
        account_id: cgstAcc.id,
        debit_paise: 0,
        credit_paise: cgst,
        party_type: null,
        party_id: null,
        description: 'Output CGST',
      });
    }
    if (sgst > 0) {
      const sgstAcc = await requireAccount(this.db, businessId, ACC_OUTPUT_SGST_CODE);
      lines.push({
        id: ulid(),
        business_id: businessId,
        entry_id: entryId,
        line_no: lineNo++,
        account_id: sgstAcc.id,
        debit_paise: 0,
        credit_paise: sgst,
        party_type: null,
        party_id: null,
        description: 'Output SGST',
      });
    }
    if (cess > 0) {
      const cessAcc = await requireAccount(this.db, businessId, ACC_OUTPUT_CESS_CODE);
      lines.push({
        id: ulid(),
        business_id: businessId,
        entry_id: entryId,
        line_no: lineNo++,
        account_id: cessAcc.id,
        debit_paise: 0,
        credit_paise: cess,
        party_type: null,
        party_id: null,
        description: 'Output Cess',
      });
    }

    // Handle rounding: if net + all-gst + cess != total, add a rounding line so
    // it balances. Rounding is posted to a dedicated Round Off account, not
    // Sales Revenue, so PnL / GST reports don't get polluted.
    const credits = lines.reduce((a, l) => a + l.credit_paise, 0);
    const debits = lines.reduce((a, l) => a + l.debit_paise, 0);
    const diff = debits - credits;
    if (diff !== 0) {
      const roundOff = await requireAccount(this.db, businessId, ACC_ROUND_OFF_CODE);
      lines.push({
        id: ulid(),
        business_id: businessId,
        entry_id: entryId,
        line_no: lineNo++,
        account_id: roundOff.id,
        debit_paise: diff < 0 ? -diff : 0,
        credit_paise: diff > 0 ? diff : 0,
        party_type: null,
        party_id: null,
        description: 'Round off',
      });
    }

    return lines;
  }
}

// ---------- module-private helpers ----------

async function findByIdempotencyKey(
  db: BusinessVaultDB,
  businessId: string,
  key: string,
): Promise<Invoice | null> {
  const events = await db.sync_events
    .where('[business_id+entity_type+entity_id]')
    .between([businessId, 'invoice', ''], [businessId, 'invoice', '￿'])
    .toArray();
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const e of events) {
    const p = e.payload as { idempotencyKey?: string; id?: string } | null;
    if (!p || p.idempotencyKey !== key) continue;
    if (new Date(e.timestamp).getTime() < twentyFourHoursAgo) continue;
    if (!p.id) continue;
    const inv = await db.invoices.get(p.id);
    if (inv) return inv;
  }
  return null;
}

async function requireAccount(
  db: BusinessVaultDB,
  businessId: string,
  code: string,
): Promise<Account> {
  const acc = await db.accounts
    .where('[business_id+code]')
    .equals([businessId, code])
    .first();
  if (!acc) {
    throw new Error(
      `Chart of accounts is missing required system account ${code}. ` +
        `Run AccountingService.bootstrapChartOfAccounts() first.`,
    );
  }
  return acc;
}

async function reduceStock(
  db: BusinessVaultDB,
  businessId: string,
  deviceId: string,
  itemId: string,
  warehouseId: string,
  qtyMicros: number,
  invoiceId: string,
  invoiceDate: string,
): Promise<{ unitCostPaise: number; cogsPaise: number }> {
  const key = [businessId, itemId, warehouseId] as const;
  const stock = await db.item_stock
    .where('[business_id+item_id+warehouse_id]')
    .equals(key as unknown as (string | number)[])
    .first();

  const now = new Date().toISOString();
  // Moving-average COGS: unit cost is whatever we've been valuing this item
  // at right now. Reducing stock does NOT change avg_cost — only inbound
  // movements (purchase, purchase_return, opening) recompute it.
  const unitCostPaise = stock?.avg_cost_paise ?? 0;
  const cogsPaise = bankersRound((unitCostPaise * qtyMicros) / 1_000_000);

  if (stock) {
    const newQty = stock.qty_micros - qtyMicros;
    await db.item_stock.update(stock.id, {
      qty_micros: newQty,
      updated_at: now,
    });
  } else {
    const newStock: ItemStock = {
      id: ulid(),
      business_id: businessId,
      item_id: itemId,
      warehouse_id: warehouseId,
      qty_micros: -qtyMicros,
      avg_cost_paise: 0,
      updated_at: now,
    };
    await db.item_stock.add(newStock);
  }

  const movement: StockMovement = {
    id: ulid(),
    business_id: businessId,
    item_id: itemId,
    warehouse_id: warehouseId,
    movement_type: 'sale',
    qty_micros: -qtyMicros,
    unit_cost_paise: unitCostPaise,
    ref_type: 'invoice',
    ref_id: invoiceId,
    occurred_at: invoiceDate,
    notes: '',
  };
  await db.stock_movements.add(movement);
  await writeEventInTx(db, {
    business_id: businessId,
    device_id: deviceId,
    entity_type: 'stock_movement',
    entity_id: movement.id,
    operation: 'movement' as SyncEvent['operation'],
    entity_version: 1,
    timestamp: invoiceDate,
    payload: movement,
  });
  return { unitCostPaise, cogsPaise };
}

async function returnStock(
  db: BusinessVaultDB,
  businessId: string,
  deviceId: string,
  itemId: string,
  warehouseId: string,
  qtyMicros: number,
  creditNoteId: string,
  entryDate: string,
): Promise<void> {
  const stock = await db.item_stock
    .where('[business_id+item_id+warehouse_id]')
    .equals([businessId, itemId, warehouseId] as unknown as (string | number)[])
    .first();
  const now = new Date().toISOString();
  if (stock) {
    await db.item_stock.update(stock.id, {
      qty_micros: stock.qty_micros + qtyMicros,
      updated_at: now,
    });
  }

  const movement: StockMovement = {
    id: ulid(),
    business_id: businessId,
    item_id: itemId,
    warehouse_id: warehouseId,
    movement_type: 'sale_return',
    qty_micros: qtyMicros,
    unit_cost_paise: stock?.avg_cost_paise ?? 0,
    ref_type: 'reversal',
    ref_id: creditNoteId,
    occurred_at: entryDate,
    notes: '',
  };
  await db.stock_movements.add(movement);
  await writeEventInTx(db, {
    business_id: businessId,
    device_id: deviceId,
    entity_type: 'stock_movement',
    entity_id: movement.id,
    operation: 'movement' as SyncEvent['operation'],
    entity_version: 1,
    timestamp: entryDate,
    payload: movement,
  });
}

interface WriteEventInput {
  business_id: string;
  device_id: string;
  entity_type: SyncEvent['entity_type'];
  entity_id: string;
  operation: SyncEvent['operation'];
  entity_version: number;
  timestamp: string;
  payload: unknown;
  // Optional pre-computed hash. If absent, we hash inside the tx via
  // Dexie.waitFor so SubtleCrypto's non-Dexie promise doesn't break the tx zone.
  payload_hash?: string;
}

/**
 * Writes a sync event inside an already-open Dexie transaction. Callers may
 * pre-compute payload_hash; otherwise we hash inline via Dexie.waitFor.
 */
async function writeEventInTx(
  db: BusinessVaultDB,
  input: WriteEventInput,
): Promise<SyncEvent> {
  // Hash chain: previous_hash = payload_hash of the latest event for this business.
  const tail = await db.sync_events
    .where('[business_id+timestamp]')
    .between([input.business_id, ''], [input.business_id, '￿'])
    .reverse()
    .first();
  const previousHash = tail ? tail.payload_hash : GENESIS_HASH;

  const payloadHash =
    input.payload_hash ??
    (await Dexie.waitFor(sha256Hex(canonicalJson(input.payload))));

  const evt: SyncEvent = {
    event_id: ulid(),
    business_id: input.business_id,
    device_id: input.device_id,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    entity_version: input.entity_version,
    timestamp: input.timestamp,
    payload: input.payload,
    payload_hash: payloadHash,
    previous_hash: previousHash,
    sync_status: 'LOCAL_ONLY',
    sync_attempts: 0,
    last_error: null,
    synced_at: null,
    journal_file: null,
  };
  await db.sync_events.add(evt);
  return evt;
}

function assertBalanced(lines: JournalLine[]): void {
  let d = 0;
  let c = 0;
  for (const l of lines) {
    d += l.debit_paise;
    c += l.credit_paise;
  }
  if (d !== c) {
    throw new Error(`Journal not balanced: debits=${d} credits=${c}`);
  }
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function sumField<T>(xs: T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}

function microsToInt(m: number): number {
  return m / 1_000_000;
}
