import Dexie from 'dexie';
import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
  Advance,
  Invoice,
  JournalEntry,
  JournalLine,
  Payment,
  PaymentAllocation,
  PaymentDirection,
  PaymentMethod,
  PartyType,
  Purchase,
  SyncEvent,
} from '../db/types';
import { GENESIS_HASH, canonicalJson, sha256Hex } from '../journal/event';
import { SYSTEM_ACCOUNT_CODES, findAccountByCode } from './coa';
import { isAdvanceActive } from './paymentState';

// UI-facing payment split — three tendered methods plus "credit" (unpaid).
// Credit does NOT produce a Payment row; the invoice balance already reflects it.
export interface InvoicePaymentSplit {
  cash_paise: number;
  card_paise: number;
  upi_paise: number;
  credit_paise: number;
}

export interface PaymentAllocationInput {
  invoice_id?: string;
  bill_id?: string;
  // When true, this slice is held on account as a customer/supplier advance
  // instead of settling an invoice/bill. Materializes one Advance row inside
  // the same transaction as the payment (spec §13/§14: overpayment must not
  // become negative outstanding — the excess is an explicit advance instead).
  // Exactly one of {invoice_id, bill_id, as_advance} is set per allocation.
  as_advance?: boolean;
  amount_paise: number;
}

export interface CreatePaymentInput {
  business_id: string;
  device_id: string;
  payment_number: string;
  payment_date: string;
  direction: PaymentDirection;
  party_type: PartyType;
  party_id: string;
  method: PaymentMethod;
  cash_or_bank_account_id: string;
  ar_or_ap_account_id: string;
  amount_paise: number;
  reference?: string;
  notes?: string;
  allocations: PaymentAllocationInput[];
  // Required when any allocation has as_advance=true. Numbering the advance
  // stays under caller control so it fits the caller's PAY-/ADV- scheme.
  advance_number?: string;
  idempotency_key?: string;
}

export interface RefundPaymentInput {
  business_id: string;
  device_id: string;
  payment_id: string;
  refund_payment_number: string;
  refund_date: string;
  reason: string;
  idempotency_key?: string;
}

export interface SoftDeletePaymentInput {
  business_id: string;
  device_id: string;
  payment_id: string;
  reason: string;
}

export interface RestorePaymentInput {
  business_id: string;
  device_id: string;
  payment_id: string;
  // When true, RESTORE proceeds even if some original allocation slices no
  // longer fit the current invoice/bill outstanding — shortfalls fall through
  // to an advance for the payer/payee. When false (default) and any slice
  // cannot be fully restored to its original target, throws
  // PaymentRestoreConflictError so the UI can prompt the user.
  allow_partial?: boolean;
}

// Full Edit input — payment_number is IMMUTABLE across revisions and comes
// from the original row, not the caller. Everything else in this shape can
// change (amount, date, method, account, allocations, reference, notes).
export interface UpdatePaymentInput {
  business_id: string;
  device_id: string;
  payment_id: string;
  payment_date: string;
  method: PaymentMethod;
  cash_or_bank_account_id: string;
  ar_or_ap_account_id: string;
  amount_paise: number;
  reference?: string;
  notes?: string;
  allocations: PaymentAllocationInput[];
  advance_number?: string;
  reason?: string;
}

// Structured detail returned when softDeletePayment is refused because the
// payment created an advance that has since been partially/fully consumed by
// other invoices/bills. UI surfaces this in a "cannot delete" dialog with
// per-target links.
export interface AdvanceConsumer {
  advance_id: string;
  advance_number: string;
  invoice_id?: string;
  invoice_number?: string;
  bill_id?: string;
  bill_number?: string;
  applied_paise: number;
  applied_at: string;
}

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentValidationError';
  }
}

/**
 * Thrown by softDeletePayment / updatePayment when the payment created an
 * advance and that advance has since been applied (partially or fully) to
 * other invoices/bills. The consuming targets are attached so the UI can list
 * them and route the user to "reverse those applications first".
 *
 * User rule (from spec §Q1 clarification): allow delete only when
 *   (no advance was created) OR (advance is fully unconsumed).
 * A partial consumption blocks the delete just as fully as a total one — we
 * never automatically claw back money from downstream valid applications.
 */
export class PaymentAdvanceConsumedError extends Error {
  readonly code = 'PAYMENT_ADVANCE_CONSUMED';
  constructor(
    readonly payment_id: string,
    readonly consumers: AdvanceConsumer[],
  ) {
    super(
      `Payment ${payment_id} created an advance that has been consumed by ${consumers.length} downstream application(s)`,
    );
    this.name = 'PaymentAdvanceConsumedError';
  }
}

// Slice-level shape of what RESTORE could not do. `slice_kind` identifies the
// original allocation target; `requested_paise` is what the historical slice
// wanted; `available_paise` is what the target can accept right now. UI shows
// the shortfall and asks "OK to make the difference a customer advance?".
export interface RestoreAllocationConflict {
  slice_kind: 'invoice' | 'bill' | 'advance';
  target_id: string;
  target_number: string;
  requested_paise: number;
  available_paise: number;
}

export class PaymentRestoreConflictError extends Error {
  readonly code = 'RESTORE_ALLOCATION_CONFLICT';
  constructor(
    readonly payment_id: string,
    readonly conflicts: RestoreAllocationConflict[],
  ) {
    super(
      `Payment ${payment_id} cannot be fully restored to its original allocations`,
    );
    this.name = 'PaymentRestoreConflictError';
  }
}

export class PaymentService {
  constructor(private readonly db: BusinessVaultDB = defaultDb) {}

  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    validateCreateInput(input);

    const paymentId = ulid();
    const journalEntryId = ulid();
    const now = new Date().toISOString();
    const allocationsPreview = previewAllocations(input);
    const advanceAmount = allocationsPreview
      .filter((a) => a.advance_id === '__PENDING__')
      .reduce((s, a) => s + a.amount_paise, 0);
    const allocatedAmount = input.amount_paise - advanceAmount;

    // Advance-account lookup only when there's excess to capture on account.
    const advanceAcctCode =
      input.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE
        : SYSTEM_ACCOUNT_CODES.SUPPLIER_ADVANCE;
    const advanceAcct =
      advanceAmount > 0
        ? await findAccountByCode(input.business_id, advanceAcctCode, {
            db: this.db,
          })
        : null;
    if (advanceAmount > 0 && !advanceAcct) {
      throw new PaymentValidationError(
        `Advance account (code ${advanceAcctCode}) not found — run "Repair chart of accounts" in Settings.`,
      );
    }
    if (advanceAmount > 0 && !input.advance_number?.trim()) {
      throw new PaymentValidationError(
        'advance_number is required when any allocation has as_advance=true',
      );
    }

    // Materialize the Advance row up front so the payment's allocation slice
    // references a real advance_id (the JE and Advance share journal_entry_id).
    const advanceId = advanceAmount > 0 ? ulid() : null;
    const advance: Advance | null = advanceId
      ? {
          id: advanceId,
          business_id: input.business_id,
          advance_number: input.advance_number!.trim(),
          advance_date: input.payment_date,
          party_type: input.party_type,
          party_id: input.party_id,
          method: input.method,
          account_id: input.cash_or_bank_account_id,
          amount_paise: advanceAmount,
          remaining_paise: advanceAmount,
          reference: input.reference ?? '',
          notes: `Auto-created from excess on payment ${input.payment_number}`,
          applications: [],
          journal_entry_id: journalEntryId,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        }
      : null;
    if (advanceId) {
      for (const a of allocationsPreview) {
        if (a.advance_id === '__PENDING__') a.advance_id = advanceId;
      }
    }

    const paymentPreview: Payment = {
      id: paymentId,
      business_id: input.business_id,
      payment_number: input.payment_number,
      payment_date: input.payment_date,
      direction: input.direction,
      party_type: input.party_type,
      party_id: input.party_id,
      method: input.method,
      account_id: input.cash_or_bank_account_id,
      amount_paise: input.amount_paise,
      reference: input.reference ?? '',
      notes: input.notes ?? '',
      allocations: allocationsPreview,
      journal_entry_id: journalEntryId,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const createdHash = await sha256Hex(canonicalJson(paymentPreview));
    const advanceHash = advance ? await sha256Hex(canonicalJson(advance)) : '';
    const allocatedHash =
      allocationsPreview.length > 0
        ? await sha256Hex(
            canonicalJson({
              payment_id: paymentId,
              allocations: allocationsPreview,
            }),
          )
        : '';

    return await this.db.transaction(
      'rw',
      [
        this.db.payments,
        this.db.invoices,
        this.db.purchases,
        this.db.advances,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        const existing = await this.db.payments
          .where('[business_id+payment_number]')
          .equals([input.business_id, input.payment_number])
          .first();
        if (existing) return existing;

        await this.applyAllocationsToTargets(
          { business_id: input.business_id, direction: input.direction },
          allocationsPreview,
          'apply',
        );

        const journal = buildJournalEntry({
          id: journalEntryId,
          business_id: input.business_id,
          entry_date: input.payment_date,
          direction: input.direction,
          amount_paise: input.amount_paise,
          cash_or_bank_account_id: input.cash_or_bank_account_id,
          ar_or_ap_account_id: input.ar_or_ap_account_id,
          allocated_paise: allocatedAmount,
          advance_paise: advanceAmount,
          advance_account_id: advanceAcct?.id ?? null,
          party_type: input.party_type,
          party_id: input.party_id,
          ref_id: paymentId,
          narration: `Payment ${input.payment_number}`,
          reverses_id: null,
          now,
        });

        if (advance) await this.db.advances.add(advance);
        await this.db.payments.add(paymentPreview);
        await this.db.journal_entries.add(journal.entry);
        await this.db.journal_lines.bulkAdd(journal.lines);

        if (advance) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: advance.id,
            operation: 'created',
            entity_version: 1,
            payload: advance,
            payload_hash: advanceHash,
            timestamp: now,
          });
        }

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: paymentId,
          operation: 'created',
          entity_version: 1,
          payload: paymentPreview,
          payload_hash: createdHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: journal.entry.id,
          operation: 'posted',
          entity_version: 1,
          payload: journal.entry,
          timestamp: now,
        });
        for (const jl of journal.lines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            payload: jl,
            timestamp: now,
          });
        }

        if (allocationsPreview.length > 0) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'payment',
            entity_id: paymentId,
            operation: 'allocated',
            entity_version: 2,
            payload: {
              payment_id: paymentId,
              allocations: allocationsPreview,
            },
            payload_hash: allocatedHash,
            timestamp: now,
          });
        }

        return paymentPreview;
      },
    );
  }

  async refundPayment(input: RefundPaymentInput): Promise<Payment> {
    const original = await this.db.payments.get(input.payment_id);
    if (!original) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} not found`,
      );
    }
    if (original.business_id !== input.business_id) {
      throw new PaymentValidationError('business_id mismatch');
    }
    if (original.amount_paise < 0) {
      throw new PaymentValidationError(
        'cannot refund a refund/reversal payment',
      );
    }
    // Advance-carrying refunds would require unwinding the Advance row too
    // (its remaining_paise may already be partly consumed by apply-to-invoice).
    // Not modeled yet — cancel the associated advance explicitly first.
    if (original.allocations.some((a) => a.advance_id)) {
      throw new PaymentValidationError(
        'cannot refund a payment with on-account (as_advance) slices — cancel the associated advance first',
      );
    }
    const originalEntry = await this.db.journal_entries.get(
      original.journal_entry_id,
    );
    if (!originalEntry) {
      throw new PaymentValidationError(
        `journal_entry ${original.journal_entry_id} not found`,
      );
    }
    const originalLines = await this.db.journal_lines
      .where('[business_id+entry_id]')
      .equals([input.business_id, original.journal_entry_id])
      .toArray();

    const refundId = ulid();
    const refundJournalId = ulid();
    const now = new Date().toISOString();
    const reversedDirection: PaymentDirection =
      original.direction === 'in' ? 'out' : 'in';

    const refundAllocations: PaymentAllocation[] = original.allocations.map(
      (a) => ({
        invoice_id: a.invoice_id,
        bill_id: a.bill_id,
        advance_id: a.advance_id,
        amount_paise: -a.amount_paise,
      }),
    );

    const refund: Payment = {
      id: refundId,
      business_id: input.business_id,
      payment_number: input.refund_payment_number,
      payment_date: input.refund_date,
      direction: reversedDirection,
      party_type: original.party_type,
      party_id: original.party_id,
      method: original.method,
      account_id: original.account_id,
      amount_paise: -original.amount_paise,
      reference: `refund of ${original.payment_number}`,
      notes: input.reason,
      allocations: refundAllocations,
      journal_entry_id: refundJournalId,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const reversalEntry: JournalEntry = {
      id: refundJournalId,
      business_id: input.business_id,
      entry_number: `${originalEntry.entry_number}-REV`,
      entry_date: input.refund_date,
      narration: `Refund of ${original.payment_number}: ${input.reason}`,
      ref_type: 'reversal',
      ref_id: refundId,
      reversed_by_id: null,
      reverses_id: original.journal_entry_id,
      total_debit_paise: originalEntry.total_credit_paise,
      total_credit_paise: originalEntry.total_debit_paise,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const sortedOriginalLines = [...originalLines].sort(
      (a, b) => a.line_no - b.line_no,
    );
    const reversalLines: JournalLine[] = sortedOriginalLines.map((l, idx) => ({
      id: ulid(),
      business_id: input.business_id,
      entry_id: refundJournalId,
      line_no: idx + 1,
      account_id: l.account_id,
      debit_paise: l.credit_paise,
      credit_paise: l.debit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      description: `Reverse: ${l.description}`,
    }));

    const refundCreatedHash = await sha256Hex(canonicalJson(refund));
    const reversedPayload = {
      payment_id: original.id,
      reversed_by_payment_id: refundId,
      reason: input.reason,
      reversed_at: now,
    };
    const reversedHash = await sha256Hex(canonicalJson(reversedPayload));

    return await this.db.transaction(
      'rw',
      [
        this.db.payments,
        this.db.invoices,
        this.db.purchases,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        await this.applyAllocationsToTargets(
          { business_id: input.business_id, direction: original.direction },
          original.allocations,
          'reverse',
        );

        await this.db.payments.add(refund);
        await this.db.journal_entries.add(reversalEntry);
        await this.db.journal_lines.bulkAdd(reversalLines);

        await this.db.journal_entries.update(original.journal_entry_id, {
          reversed_by_id: reversalEntry.id,
          updated_at: now,
        });

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: refundId,
          operation: 'created',
          entity_version: 1,
          payload: refund,
          payload_hash: refundCreatedHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: reversalEntry.id,
          operation: 'posted',
          entity_version: 1,
          payload: reversalEntry,
          timestamp: now,
        });
        for (const jl of reversalLines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            payload: jl,
            timestamp: now,
          });
        }

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: original.id,
          operation: 'reversed',
          entity_version: (original.entity_version ?? 1) + 1,
          payload: reversedPayload,
          payload_hash: reversedHash,
          timestamp: now,
        });

        return refund;
      },
    );
  }

  /**
   * User-initiated soft-delete: move a payment to the Recycle Bin.
   *
   * Refused with PaymentAdvanceConsumedError if the payment created an
   * advance that has since been partially or fully applied to other
   * invoices/bills. Rationale (spec §Q1): the downstream applications
   * represent real money credited to real invoices; we do not silently
   * unwind them. The user must reverse those applications first, then
   * retry the delete.
   *
   * Reverses in-tx:
   *   - the payment's allocation impact on invoice/bill balances
   *   - a full reversal JE
   * Marks in-tx (never hard-deletes):
   *   - payment.deleted_at + deleted_reason
   *   - any advance the payment created (deleted_at + `cascade:${payment_id}`)
   *
   * Emits: payment.deleted, journal_entry.reversed, advance.deleted (if any).
   *
   * Idempotent — deleting an already-recycled payment returns silently.
   * Refuses to touch a SUPERSEDED row (that came from an Edit, not a user
   * action; only the ACTIVE tip of a revision chain is user-deletable).
   */
  async softDeletePayment(input: SoftDeletePaymentInput): Promise<void> {
    const original = await this.db.payments.get(input.payment_id);
    if (!original) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} not found`,
      );
    }
    if (original.business_id !== input.business_id) {
      throw new PaymentValidationError('business_id mismatch');
    }
    if (original.superseded_at) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} is superseded — delete the current revision instead`,
      );
    }
    if (original.deleted_at) return; // idempotent

    // ADVANCE-CONSUMPTION CHECK — enumerate every Advance row this payment
    // created and see if any application row was appended after creation.
    // An advance is created inside createPayment(), so its journal_entry_id
    // matches the payment's. Applications land there via a separate service.
    const consumers: AdvanceConsumer[] = [];
    const paymentAdvanceIds = new Set(
      original.allocations
        .map((a) => a.advance_id)
        .filter((id): id is string => !!id && id !== '__PENDING__'),
    );
    const advancesToCascade: Advance[] = [];
    for (const advanceId of paymentAdvanceIds) {
      const advance = await this.db.advances.get(advanceId);
      if (!advance) continue;
      if (!isAdvanceActive(advance)) continue;
      const apps = advance.applications ?? [];
      if (apps.length > 0) {
        for (const app of apps) {
          const invoice = app.invoice_id
            ? await this.db.invoices.get(app.invoice_id)
            : null;
          const bill = app.bill_id
            ? await this.db.purchases.get(app.bill_id)
            : null;
          consumers.push({
            advance_id: advance.id,
            advance_number: advance.advance_number,
            invoice_id: app.invoice_id,
            invoice_number: invoice?.invoice_number,
            bill_id: app.bill_id,
            bill_number: bill?.bill_number,
            applied_paise: app.amount_paise,
            applied_at: app.applied_at,
          });
        }
        continue; // leave for consumer-list — do not add to cascade
      }
      advancesToCascade.push(advance);
    }
    if (consumers.length > 0) {
      throw new PaymentAdvanceConsumedError(original.id, consumers);
    }

    const originalEntry = await this.db.journal_entries.get(
      original.journal_entry_id,
    );
    if (!originalEntry) {
      throw new PaymentValidationError(
        `journal_entry ${original.journal_entry_id} not found`,
      );
    }
    const originalLines = await this.db.journal_lines
      .where('[business_id+entry_id]')
      .equals([input.business_id, original.journal_entry_id])
      .toArray();

    const now = new Date().toISOString();
    const reversalJournalId = ulid();
    const trimmedReason = (input.reason ?? '').trim() || 'recycled';

    const reversalEntry: JournalEntry = {
      id: reversalJournalId,
      business_id: input.business_id,
      entry_number: `${originalEntry.entry_number}-REV`,
      entry_date: now.slice(0, 10),
      narration: `Recycle payment ${original.payment_number}: ${trimmedReason}`,
      ref_type: 'reversal',
      ref_id: original.id,
      reversed_by_id: null,
      reverses_id: original.journal_entry_id,
      total_debit_paise: originalEntry.total_credit_paise,
      total_credit_paise: originalEntry.total_debit_paise,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const sortedOriginalLines = [...originalLines].sort(
      (a, b) => a.line_no - b.line_no,
    );
    const reversalLines: JournalLine[] = sortedOriginalLines.map((l, idx) => ({
      id: ulid(),
      business_id: input.business_id,
      entry_id: reversalJournalId,
      line_no: idx + 1,
      account_id: l.account_id,
      debit_paise: l.credit_paise,
      credit_paise: l.debit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      description: `Reverse (recycle): ${l.description}`,
    }));

    const deletedPayload = {
      payment_id: original.id,
      deleted_at: now,
      reason: trimmedReason,
      reversal_entry_id: reversalJournalId,
      cascaded_advance_ids: advancesToCascade.map((a) => a.id),
    };
    const deletedHash = await sha256Hex(canonicalJson(deletedPayload));

    await this.db.transaction(
      'rw',
      [
        this.db.payments,
        this.db.invoices,
        this.db.purchases,
        this.db.advances,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        await this.applyAllocationsToTargets(
          { business_id: input.business_id, direction: original.direction },
          original.allocations,
          'reverse',
        );

        await this.db.journal_entries.add(reversalEntry);
        await this.db.journal_lines.bulkAdd(reversalLines);
        await this.db.journal_entries.update(original.journal_entry_id, {
          reversed_by_id: reversalEntry.id,
          updated_at: now,
        });

        await this.db.payments.update(original.id, {
          deleted_at: now,
          deleted_reason: trimmedReason,
          updated_at: now,
          entity_version: original.entity_version + 1,
        });
        for (const adv of advancesToCascade) {
          await this.db.advances.update(adv.id, {
            deleted_at: now,
            deleted_reason: `cascade:${original.id}`,
            updated_at: now,
            entity_version: adv.entity_version + 1,
          });
        }

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: original.id,
          operation: 'deleted',
          entity_version: original.entity_version + 1,
          payload: deletedPayload,
          payload_hash: deletedHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: reversalEntry.id,
          operation: 'posted',
          entity_version: 1,
          payload: reversalEntry,
          timestamp: now,
        });
        for (const jl of reversalLines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            payload: jl,
            timestamp: now,
          });
        }
        for (const adv of advancesToCascade) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: adv.id,
            operation: 'deleted',
            entity_version: adv.entity_version + 1,
            payload: {
              advance_id: adv.id,
              deleted_at: now,
              deleted_reason: `cascade:${original.id}`,
            },
            timestamp: now,
          });
        }
      },
    );
  }

  /**
   * Restore a payment from the Recycle Bin.
   *
   * Strategy — spec §Q1 amendment 2: never take money from another valid
   * payment automatically. For each original allocation slice:
   *
   *   1. Take min(original slice, current target outstanding). If the target
   *      is soft-deleted or gone, its capacity is 0.
   *   2. Apply that fitted amount. Shortfall (original − fitted) becomes an
   *      advance for the party in the payment's direction.
   *
   * If any slice cannot be fully re-applied to its original target and
   * `allow_partial` is false (the default), throws PaymentRestoreConflictError
   * with the per-slice detail so the UI can prompt the user before proceeding.
   * When `allow_partial` is true (UI has confirmed), shortfalls flow to advance
   * as described.
   *
   * The restore materializes a fresh JE that mirrors the original's shape but
   * with re-fitted allocations. The original JE stays reversed (from the
   * softDelete step) — the ledger keeps both entries, preserving history.
   *
   * Idempotent — restoring a non-recycled payment returns silently.
   * Refuses to restore a SUPERSEDED payment (Edit revisions are not
   * user-restorable from the Recycle Bin).
   */
  async restorePayment(input: RestorePaymentInput): Promise<Payment> {
    const original = await this.db.payments.get(input.payment_id);
    if (!original) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} not found`,
      );
    }
    if (original.business_id !== input.business_id) {
      throw new PaymentValidationError('business_id mismatch');
    }
    if (original.superseded_at) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} is superseded — cannot restore from Recycle Bin`,
      );
    }
    if (!original.deleted_at) {
      return original; // idempotent
    }

    // Fit each original slice to current outstanding. Advance slices restore
    // as an advance-again (their target is the party, not a specific doc).
    type Fit = {
      slice: PaymentAllocation;
      fitted_paise: number;
      shortfall_paise: number;
      conflict?: RestoreAllocationConflict;
    };
    const fits: Fit[] = [];
    for (const slice of original.allocations) {
      if (slice.invoice_id && original.direction === 'in') {
        const inv = await this.db.invoices.get(slice.invoice_id);
        const available = inv && !inv.deleted_at ? inv.balance_paise : 0;
        const fitted = Math.max(0, Math.min(slice.amount_paise, available));
        const shortfall = slice.amount_paise - fitted;
        fits.push({
          slice,
          fitted_paise: fitted,
          shortfall_paise: shortfall,
          conflict:
            shortfall > 0
              ? {
                  slice_kind: 'invoice',
                  target_id: slice.invoice_id,
                  target_number: inv?.invoice_number ?? '(deleted)',
                  requested_paise: slice.amount_paise,
                  available_paise: available,
                }
              : undefined,
        });
      } else if (slice.bill_id && original.direction === 'out') {
        const bill = await this.db.purchases.get(slice.bill_id);
        const available = bill ? bill.balance_paise : 0;
        const fitted = Math.max(0, Math.min(slice.amount_paise, available));
        const shortfall = slice.amount_paise - fitted;
        fits.push({
          slice,
          fitted_paise: fitted,
          shortfall_paise: shortfall,
          conflict:
            shortfall > 0
              ? {
                  slice_kind: 'bill',
                  target_id: slice.bill_id,
                  target_number: bill?.bill_number ?? '(deleted)',
                  requested_paise: slice.amount_paise,
                  available_paise: available,
                }
              : undefined,
        });
      } else if (slice.advance_id) {
        // Advance slices restore fully as advance — no shortfall possible.
        fits.push({
          slice,
          fitted_paise: slice.amount_paise,
          shortfall_paise: 0,
        });
      }
    }

    const conflicts = fits
      .map((f) => f.conflict)
      .filter((c): c is RestoreAllocationConflict => !!c);
    if (conflicts.length > 0 && !input.allow_partial) {
      throw new PaymentRestoreConflictError(original.id, conflicts);
    }

    // Build the restored payment's fresh allocation list. Any shortfall
    // pooled into a single advance slice (customer OR supplier per direction).
    const restoredAllocations: PaymentAllocation[] = [];
    let totalShortfall = 0;
    for (const f of fits) {
      if (f.fitted_paise > 0) {
        restoredAllocations.push({
          invoice_id: f.slice.invoice_id,
          bill_id: f.slice.bill_id,
          advance_id: f.slice.advance_id, // '__PENDING__' rewritten below
          amount_paise: f.fitted_paise,
        });
      }
      totalShortfall += f.shortfall_paise;
    }
    const needsNewAdvance = totalShortfall > 0;
    const restoredAdvanceId = needsNewAdvance ? ulid() : null;
    if (restoredAdvanceId) {
      restoredAllocations.push({
        advance_id: restoredAdvanceId,
        amount_paise: totalShortfall,
      });
    }

    // The restored payment reuses the original's identity except for its JE
    // (we materialize a fresh forward JE). The original's reversal JE from
    // softDelete stays in place — audit trail is: create → reverse → restore.
    const now = new Date().toISOString();
    const newJournalId = ulid();

    const advanceAcctCode =
      original.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE
        : SYSTEM_ACCOUNT_CODES.SUPPLIER_ADVANCE;
    const advanceAcct = needsNewAdvance
      ? await findAccountByCode(input.business_id, advanceAcctCode, {
          db: this.db,
        })
      : null;
    if (needsNewAdvance && !advanceAcct) {
      throw new PaymentValidationError(
        `Advance account (code ${advanceAcctCode}) not found — run "Repair chart of accounts" in Settings.`,
      );
    }
    const arApAcctCode =
      original.direction === 'in'
        ? SYSTEM_ACCOUNT_CODES.RECEIVABLE
        : SYSTEM_ACCOUNT_CODES.PAYABLE;
    const arApAcct = await findAccountByCode(input.business_id, arApAcctCode, {
      db: this.db,
    });
    if (!arApAcct) {
      throw new PaymentValidationError(
        `AR/AP account (code ${arApAcctCode}) not found — run "Repair chart of accounts".`,
      );
    }

    // Materialize new advance row if needed (shortfall path).
    const newAdvance: Advance | null = restoredAdvanceId
      ? {
          id: restoredAdvanceId,
          business_id: input.business_id,
          advance_number: `${original.payment_number}-ADV-R`,
          advance_date: now.slice(0, 10),
          party_type: original.party_type,
          party_id: original.party_id,
          method: original.method,
          account_id: original.account_id,
          amount_paise: totalShortfall,
          remaining_paise: totalShortfall,
          reference: original.reference,
          notes: `Restore shortfall from payment ${original.payment_number}`,
          applications: [],
          journal_entry_id: newJournalId,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        }
      : null;

    // Advances the softDelete cascade-hid: reactivate any whose id is still in
    // the restored allocations (i.e. we're restoring an as-advance slice).
    const advanceIdsInSlices = new Set(
      restoredAllocations
        .map((a) => a.advance_id)
        .filter((id): id is string => !!id && id !== restoredAdvanceId),
    );
    const advancesToUncascade: Advance[] = [];
    for (const advId of advanceIdsInSlices) {
      const adv = await this.db.advances.get(advId);
      if (adv && adv.deleted_reason === `cascade:${original.id}`) {
        advancesToUncascade.push(adv);
      }
    }

    const allocatedAmount = restoredAllocations
      .filter((a) => !a.advance_id)
      .reduce((s, a) => s + a.amount_paise, 0);
    const advanceAmount = restoredAllocations
      .filter((a) => a.advance_id)
      .reduce((s, a) => s + a.amount_paise, 0);

    const restoredPayment: Payment = {
      ...original,
      allocations: restoredAllocations,
      journal_entry_id: newJournalId,
      deleted_at: null,
      deleted_reason: null,
      updated_at: now,
      entity_version: original.entity_version + 1,
    };

    const restoredHash = await sha256Hex(canonicalJson(restoredPayment));

    return await this.db.transaction(
      'rw',
      [
        this.db.payments,
        this.db.invoices,
        this.db.purchases,
        this.db.advances,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        // Re-apply the fitted allocations to invoice/bill balances.
        await this.applyAllocationsToTargets(
          { business_id: input.business_id, direction: original.direction },
          restoredAllocations,
          'apply',
        );

        // Post fresh forward JE.
        const journal = buildJournalEntry({
          id: newJournalId,
          business_id: input.business_id,
          entry_date: now.slice(0, 10),
          direction: original.direction,
          amount_paise: original.amount_paise,
          cash_or_bank_account_id: original.account_id,
          ar_or_ap_account_id: arApAcct.id,
          allocated_paise: allocatedAmount,
          advance_paise: advanceAmount,
          advance_account_id: advanceAcct?.id ?? null,
          party_type: original.party_type,
          party_id: original.party_id,
          ref_id: original.id,
          narration: `Restore payment ${original.payment_number}`,
          reverses_id: null,
          now,
        });

        if (newAdvance) await this.db.advances.add(newAdvance);
        for (const adv of advancesToUncascade) {
          await this.db.advances.update(adv.id, {
            deleted_at: null,
            deleted_reason: null,
            updated_at: now,
            entity_version: adv.entity_version + 1,
          });
        }
        await this.db.payments.put(restoredPayment);
        await this.db.journal_entries.add(journal.entry);
        await this.db.journal_lines.bulkAdd(journal.lines);

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: original.id,
          operation: 'restored',
          entity_version: restoredPayment.entity_version,
          payload: restoredPayment,
          payload_hash: restoredHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: journal.entry.id,
          operation: 'posted',
          entity_version: 1,
          payload: journal.entry,
          timestamp: now,
        });
        for (const jl of journal.lines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            payload: jl,
            timestamp: now,
          });
        }
        if (newAdvance) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: newAdvance.id,
            operation: 'created',
            entity_version: 1,
            payload: newAdvance,
            timestamp: now,
          });
        }
        for (const adv of advancesToUncascade) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: adv.id,
            operation: 'restored',
            entity_version: adv.entity_version + 1,
            payload: {
              advance_id: adv.id,
              restored_at: now,
              restored_from_payment_id: original.id,
            },
            timestamp: now,
          });
        }

        return restoredPayment;
      },
    );
  }

  /**
   * Edit a payment via soft-delete-and-recreate (spec §Q2 Option 1).
   *
   * The original row is marked SUPERSEDED (not RECYCLED) — invisible in the
   * Payments list and the Recycle Bin, visible only in the per-payment
   * revision history. A brand-new Payment row is inserted with:
   *   - a fresh `id` and fresh `journal_entry_id`
   *   - the SAME `payment_number` (user-facing identity preserved)
   *   - `revision = original.revision + 1`
   *   - `replaces_payment_id = original.id`
   *
   * The original also has `replaced_by_payment_id` set to the new row's id
   * so the chain is walkable in either direction.
   *
   * If the original's advance was partially consumed elsewhere, the Edit is
   * refused with PaymentAdvanceConsumedError — the same rule as softDelete.
   *
   * Refuses to touch a superseded row (edit the current tip instead) or a
   * recycled row (restore first, then edit).
   */
  async updatePayment(input: UpdatePaymentInput): Promise<Payment> {
    const original = await this.db.payments.get(input.payment_id);
    if (!original) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} not found`,
      );
    }
    if (original.business_id !== input.business_id) {
      throw new PaymentValidationError('business_id mismatch');
    }
    if (original.superseded_at) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} is superseded — edit the current revision instead`,
      );
    }
    if (original.deleted_at) {
      throw new PaymentValidationError(
        `payment ${input.payment_id} is in the Recycle Bin — restore before editing`,
      );
    }

    // Reuse softDelete's advance-consumption check so Edit inherits the exact
    // same protection. We inspect advances first and refuse cleanly if any
    // downstream consumption has happened.
    const paymentAdvanceIds = new Set(
      original.allocations
        .map((a) => a.advance_id)
        .filter((id): id is string => !!id && id !== '__PENDING__'),
    );
    const consumers: AdvanceConsumer[] = [];
    for (const advanceId of paymentAdvanceIds) {
      const advance = await this.db.advances.get(advanceId);
      if (!advance) continue;
      if (!isAdvanceActive(advance)) continue;
      const apps = advance.applications ?? [];
      for (const app of apps) {
        const invoice = app.invoice_id
          ? await this.db.invoices.get(app.invoice_id)
          : null;
        const bill = app.bill_id
          ? await this.db.purchases.get(app.bill_id)
          : null;
        consumers.push({
          advance_id: advance.id,
          advance_number: advance.advance_number,
          invoice_id: app.invoice_id,
          invoice_number: invoice?.invoice_number,
          bill_id: app.bill_id,
          bill_number: bill?.bill_number,
          applied_paise: app.amount_paise,
          applied_at: app.applied_at,
        });
      }
    }
    if (consumers.length > 0) {
      throw new PaymentAdvanceConsumedError(original.id, consumers);
    }

    // Step 1: reverse the original in-tx (mirrors softDelete but marks
    // SUPERSEDED instead of RECYCLED, and forwards the chain link).
    // Step 2: post the new revision.
    //
    // Both live inside ONE outer transaction so a partial-failure never
    // leaves an orphan reversal without a replacement.
    const originalEntry = await this.db.journal_entries.get(
      original.journal_entry_id,
    );
    if (!originalEntry) {
      throw new PaymentValidationError(
        `journal_entry ${original.journal_entry_id} not found`,
      );
    }
    const originalLines = await this.db.journal_lines
      .where('[business_id+entry_id]')
      .equals([input.business_id, original.journal_entry_id])
      .toArray();

    // Validate + preview the new allocations without side effects (throws if
    // over/under-allocated, invalid mix, etc.).
    const createShim: CreatePaymentInput = {
      business_id: input.business_id,
      device_id: input.device_id,
      payment_number: original.payment_number, // preserved
      payment_date: input.payment_date,
      direction: original.direction,
      party_type: original.party_type,
      party_id: original.party_id,
      method: input.method,
      cash_or_bank_account_id: input.cash_or_bank_account_id,
      ar_or_ap_account_id: input.ar_or_ap_account_id,
      amount_paise: input.amount_paise,
      reference: input.reference,
      notes: input.notes,
      allocations: input.allocations,
      advance_number: input.advance_number,
    };
    validateCreateInput(createShim);
    const newAllocations = previewAllocations(createShim);

    const advanceAmount = newAllocations
      .filter((a) => a.advance_id === '__PENDING__')
      .reduce((s, a) => s + a.amount_paise, 0);
    const allocatedAmount = input.amount_paise - advanceAmount;

    const advanceAcctCode =
      original.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE
        : SYSTEM_ACCOUNT_CODES.SUPPLIER_ADVANCE;
    const advanceAcct =
      advanceAmount > 0
        ? await findAccountByCode(input.business_id, advanceAcctCode, {
            db: this.db,
          })
        : null;
    if (advanceAmount > 0 && !advanceAcct) {
      throw new PaymentValidationError(
        `Advance account (code ${advanceAcctCode}) not found — run "Repair chart of accounts".`,
      );
    }
    if (advanceAmount > 0 && !input.advance_number?.trim()) {
      throw new PaymentValidationError(
        'advance_number is required when any allocation has as_advance=true',
      );
    }

    const now = new Date().toISOString();
    const trimmedReason = (input.reason ?? '').trim() || 'edited';

    const newPaymentId = ulid();
    const newJournalId = ulid();
    const reversalJournalId = ulid();

    const newAdvanceId = advanceAmount > 0 ? ulid() : null;
    const newAdvance: Advance | null = newAdvanceId
      ? {
          id: newAdvanceId,
          business_id: input.business_id,
          advance_number: input.advance_number!.trim(),
          advance_date: input.payment_date,
          party_type: original.party_type,
          party_id: original.party_id,
          method: input.method,
          account_id: input.cash_or_bank_account_id,
          amount_paise: advanceAmount,
          remaining_paise: advanceAmount,
          reference: input.reference ?? '',
          notes: `Auto-created from excess on payment ${original.payment_number} (rev ${(original.revision ?? 1) + 1})`,
          applications: [],
          journal_entry_id: newJournalId,
          replaces_advance_id:
            paymentAdvanceIds.size === 1 ? [...paymentAdvanceIds][0] : null,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        }
      : null;
    if (newAdvanceId) {
      for (const a of newAllocations) {
        if (a.advance_id === '__PENDING__') a.advance_id = newAdvanceId;
      }
    }

    // Advances the original created — mark superseded (not deleted) so they
    // do not appear in Recycle Bin but ARE preserved for audit + chain.
    const advancesToSupersede: Advance[] = [];
    for (const advId of paymentAdvanceIds) {
      const adv = await this.db.advances.get(advId);
      if (adv && isAdvanceActive(adv)) advancesToSupersede.push(adv);
    }

    const newPayment: Payment = {
      id: newPaymentId,
      business_id: input.business_id,
      payment_number: original.payment_number,
      payment_date: input.payment_date,
      direction: original.direction,
      party_type: original.party_type,
      party_id: original.party_id,
      method: input.method,
      account_id: input.cash_or_bank_account_id,
      amount_paise: input.amount_paise,
      reference: input.reference ?? '',
      notes: input.notes ?? '',
      allocations: newAllocations,
      journal_entry_id: newJournalId,
      revision: (original.revision ?? 1) + 1,
      replaces_payment_id: original.id,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    const newPaymentHash = await sha256Hex(canonicalJson(newPayment));

    // Reversal JE for the original.
    const sortedOriginalLines = [...originalLines].sort(
      (a, b) => a.line_no - b.line_no,
    );
    const reversalEntry: JournalEntry = {
      id: reversalJournalId,
      business_id: input.business_id,
      entry_number: `${originalEntry.entry_number}-REV`,
      entry_date: now.slice(0, 10),
      narration: `Supersede payment ${original.payment_number}: ${trimmedReason}`,
      ref_type: 'reversal',
      ref_id: original.id,
      reversed_by_id: null,
      reverses_id: original.journal_entry_id,
      total_debit_paise: originalEntry.total_credit_paise,
      total_credit_paise: originalEntry.total_debit_paise,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    const reversalLines: JournalLine[] = sortedOriginalLines.map((l, idx) => ({
      id: ulid(),
      business_id: input.business_id,
      entry_id: reversalJournalId,
      line_no: idx + 1,
      account_id: l.account_id,
      debit_paise: l.credit_paise,
      credit_paise: l.debit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      description: `Reverse (edit): ${l.description}`,
    }));

    const supersededPayload = {
      payment_id: original.id,
      superseded_at: now,
      superseded_by_payment_id: newPaymentId,
      reason: trimmedReason,
      reversal_entry_id: reversalJournalId,
    };
    const supersededHash = await sha256Hex(canonicalJson(supersededPayload));

    return await this.db.transaction(
      'rw',
      [
        this.db.payments,
        this.db.invoices,
        this.db.purchases,
        this.db.advances,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        // Reverse the original's allocation impact.
        await this.applyAllocationsToTargets(
          { business_id: input.business_id, direction: original.direction },
          original.allocations,
          'reverse',
        );

        // Post reversal JE for the original.
        await this.db.journal_entries.add(reversalEntry);
        await this.db.journal_lines.bulkAdd(reversalLines);
        await this.db.journal_entries.update(original.journal_entry_id, {
          reversed_by_id: reversalEntry.id,
          updated_at: now,
        });

        // Mark original SUPERSEDED and link chain forward.
        await this.db.payments.update(original.id, {
          superseded_at: now,
          superseded_reason: trimmedReason,
          replaced_by_payment_id: newPaymentId,
          updated_at: now,
          entity_version: original.entity_version + 1,
        });

        // Mark original advances SUPERSEDED and link forward.
        for (const adv of advancesToSupersede) {
          const patch: Partial<Advance> = {
            superseded_at: now,
            superseded_reason: `edit:${original.id}`,
            updated_at: now,
            entity_version: adv.entity_version + 1,
          };
          if (newAdvanceId) patch.replaced_by_advance_id = newAdvanceId;
          await this.db.advances.update(adv.id, patch);
        }

        // Apply new allocations to invoice/bill balances.
        await this.applyAllocationsToTargets(
          { business_id: input.business_id, direction: original.direction },
          newAllocations,
          'apply',
        );

        // Post new forward JE.
        const journal = buildJournalEntry({
          id: newJournalId,
          business_id: input.business_id,
          entry_date: input.payment_date,
          direction: original.direction,
          amount_paise: input.amount_paise,
          cash_or_bank_account_id: input.cash_or_bank_account_id,
          ar_or_ap_account_id: input.ar_or_ap_account_id,
          allocated_paise: allocatedAmount,
          advance_paise: advanceAmount,
          advance_account_id: advanceAcct?.id ?? null,
          party_type: original.party_type,
          party_id: original.party_id,
          ref_id: newPaymentId,
          narration: `Payment ${original.payment_number} (rev ${newPayment.revision})`,
          reverses_id: null,
          now,
        });

        if (newAdvance) await this.db.advances.add(newAdvance);
        await this.db.payments.add(newPayment);
        await this.db.journal_entries.add(journal.entry);
        await this.db.journal_lines.bulkAdd(journal.lines);

        // Events — supersede then create.
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: original.id,
          operation: 'superseded',
          entity_version: original.entity_version + 1,
          payload: supersededPayload,
          payload_hash: supersededHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: reversalEntry.id,
          operation: 'posted',
          entity_version: 1,
          payload: reversalEntry,
          timestamp: now,
        });
        for (const jl of reversalLines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            payload: jl,
            timestamp: now,
          });
        }
        for (const adv of advancesToSupersede) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: adv.id,
            operation: 'superseded',
            entity_version: adv.entity_version + 1,
            payload: {
              advance_id: adv.id,
              superseded_at: now,
              superseded_by_advance_id: newAdvanceId,
              reason: `edit:${original.id}`,
            },
            timestamp: now,
          });
        }

        if (newAdvance) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'advance',
            entity_id: newAdvance.id,
            operation: 'created',
            entity_version: 1,
            payload: newAdvance,
            timestamp: now,
          });
        }
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'payment',
          entity_id: newPaymentId,
          operation: 'created',
          entity_version: 1,
          payload: newPayment,
          payload_hash: newPaymentHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: journal.entry.id,
          operation: 'posted',
          entity_version: 1,
          payload: journal.entry,
          timestamp: now,
        });
        for (const jl of journal.lines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: jl.id,
            operation: 'created',
            entity_version: 1,
            payload: jl,
            timestamp: now,
          });
        }

        return newPayment;
      },
    );
  }

  /** Walk the revision chain of a payment (oldest first, ACTIVE tip last). */
  async listPaymentRevisions(
    business_id: string,
    payment_number: string,
  ): Promise<Payment[]> {
    const rows = await this.db.payments
      .where('[business_id+payment_number]')
      .equals([business_id, payment_number])
      .toArray();
    return rows.sort(
      (a, b) => (a.revision ?? 1) - (b.revision ?? 1),
    );
  }

  /** List payments in the Recycle Bin (RECYCLED — superseded rows excluded). */
  async listRecycledPayments(business_id: string): Promise<Payment[]> {
    const rows = await this.db.payments
      .where('business_id')
      .equals(business_id)
      .toArray();
    return rows.filter((p) => !!p.deleted_at && !p.superseded_at);
  }

  async listPaymentsForInvoice(
    business_id: string,
    invoice_id: string,
  ): Promise<Payment[]> {
    const rows = await this.db.payments
      .where('business_id')
      .equals(business_id)
      .toArray();
    return rows.filter((p) =>
      p.allocations.some((a) => a.invoice_id === invoice_id),
    );
  }

  async listCustomerPayments(
    business_id: string,
    customer_id: string,
  ): Promise<Payment[]> {
    const rows = await this.db.payments
      .where('[business_id+party_type+party_id]')
      .equals([business_id, 'customer', customer_id])
      .toArray();
    return rows.sort((a, b) =>
      a.payment_date < b.payment_date ? -1 : a.payment_date > b.payment_date ? 1 : 0,
    );
  }

  // Post the cash/card/upi legs of an invoice payment split as one Payment
  // row each. Credit portion is intentionally skipped — the invoice's own
  // balance already carries it. Excess tender (change) is capped: allocations
  // never exceed the invoice's outstanding balance at the moment of posting.
  async postInvoicePayments(input: {
    business_id: string;
    device_id: string;
    invoice_id: string;
    payment_date: string;
    split: InvoicePaymentSplit;
  }): Promise<Payment[]> {
    const invoice = await this.db.invoices.get(input.invoice_id);
    if (!invoice) {
      throw new PaymentValidationError(
        `invoice ${input.invoice_id} not found`,
      );
    }
    if (invoice.business_id !== input.business_id) {
      throw new PaymentValidationError('invoice business_id mismatch');
    }

    const arAccount = await findAccountByCode(
      input.business_id,
      SYSTEM_ACCOUNT_CODES.RECEIVABLE,
    );
    if (!arAccount) {
      throw new PaymentValidationError(
        `Accounts Receivable account (code ${SYSTEM_ACCOUNT_CODES.RECEIVABLE}) not found — run "Repair chart of accounts" in Settings.`,
      );
    }

    const legs: Array<{ method: PaymentMethod; amount: number; accountCode: string }> = [];
    if (input.split.cash_paise > 0) {
      legs.push({ method: 'cash', amount: input.split.cash_paise, accountCode: SYSTEM_ACCOUNT_CODES.CASH });
    }
    if (input.split.card_paise > 0) {
      legs.push({ method: 'card', amount: input.split.card_paise, accountCode: SYSTEM_ACCOUNT_CODES.BANK });
    }
    if (input.split.upi_paise > 0) {
      legs.push({ method: 'upi', amount: input.split.upi_paise, accountCode: SYSTEM_ACCOUNT_CODES.BANK });
    }
    if (legs.length === 0) return [];

    let remainingBalance = invoice.balance_paise;
    const created: Payment[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const allocation = Math.min(leg.amount, remainingBalance);
      if (allocation <= 0) break;

      const account = await findAccountByCode(input.business_id, leg.accountCode);
      if (!account) {
        throw new PaymentValidationError(
          `${leg.method} account (code ${leg.accountCode}) not found — run "Repair chart of accounts".`,
        );
      }

      const payment = await this.createPayment({
        business_id: input.business_id,
        device_id: input.device_id,
        payment_number: `${invoice.invoice_number}-P${i + 1}`,
        payment_date: input.payment_date,
        direction: 'in',
        party_type: 'customer',
        party_id: invoice.customer_id,
        method: leg.method,
        cash_or_bank_account_id: account.id,
        ar_or_ap_account_id: arAccount.id,
        amount_paise: allocation,
        allocations: [{ invoice_id: input.invoice_id, amount_paise: allocation }],
      });
      created.push(payment);
      remainingBalance -= allocation;
    }
    return created;
  }


  private async applyAllocationsToTargets(
    ctx: { business_id: string; direction: PaymentDirection },
    allocations: PaymentAllocation[],
    mode: 'apply' | 'reverse',
  ): Promise<void> {
    const sign = mode === 'apply' ? 1 : -1;
    for (const a of allocations) {
      if (ctx.direction === 'in' && a.invoice_id) {
        const inv = await this.db.invoices.get(a.invoice_id);
        if (!inv) {
          throw new PaymentValidationError(
            `invoice ${a.invoice_id} not found`,
          );
        }
        if (inv.business_id !== ctx.business_id) {
          throw new PaymentValidationError('invoice business_id mismatch');
        }
        if (mode === 'apply' && a.amount_paise > inv.balance_paise) {
          throw new PaymentValidationError(
            `allocation ${a.amount_paise} exceeds invoice ${inv.invoice_number} balance ${inv.balance_paise}`,
          );
        }
        const updated: Invoice = {
          ...inv,
          paid_paise: inv.paid_paise + sign * a.amount_paise,
          balance_paise: inv.balance_paise - sign * a.amount_paise,
          status: computeInvoiceStatus(
            inv,
            inv.paid_paise + sign * a.amount_paise,
            inv.balance_paise - sign * a.amount_paise,
          ),
          updated_at: new Date().toISOString(),
          entity_version: inv.entity_version + 1,
        };
        await this.db.invoices.put(updated);
      } else if (ctx.direction === 'out' && a.bill_id) {
        const bill = await this.db.purchases.get(a.bill_id);
        if (!bill) {
          throw new PaymentValidationError(
            `bill ${a.bill_id} not found`,
          );
        }
        if (bill.business_id !== ctx.business_id) {
          throw new PaymentValidationError('bill business_id mismatch');
        }
        if (mode === 'apply' && a.amount_paise > bill.balance_paise) {
          throw new PaymentValidationError(
            `allocation ${a.amount_paise} exceeds bill ${bill.bill_number} balance ${bill.balance_paise}`,
          );
        }
        const updated: Purchase = {
          ...bill,
          paid_paise: bill.paid_paise + sign * a.amount_paise,
          balance_paise: bill.balance_paise - sign * a.amount_paise,
          status: computePurchaseStatus(
            bill,
            bill.paid_paise + sign * a.amount_paise,
            bill.balance_paise - sign * a.amount_paise,
          ),
          updated_at: new Date().toISOString(),
          entity_version: bill.entity_version + 1,
        };
        await this.db.purchases.put(updated);
      }
    }
  }

  private async writeEventPrehashed(input: {
    business_id: string;
    device_id: string;
    entity_type: SyncEvent['entity_type'];
    entity_id: string;
    operation: string;
    entity_version: number;
    payload: unknown;
    // Optional pre-computed hash. If absent we hash inside the tx via
    // Dexie.waitFor. Callers pre-hash for hot header events (payment, refund)
    // where the payload is already known outside the tx, and let helpers below
    // hash inside for sub-entity events (journal_line) whose ids are minted here.
    payload_hash?: string;
    timestamp: string;
  }): Promise<void> {
    const tail = await this.db.sync_events
      .where('[business_id+timestamp]')
      .between(
        [input.business_id, ''],
        [input.business_id, '￿'],
        true,
        true,
      )
      .reverse()
      .limit(1)
      .toArray();
    const previous_hash = tail[0]?.payload_hash ?? GENESIS_HASH;
    const payload_hash =
      input.payload_hash ??
      (await Dexie.waitFor(sha256Hex(canonicalJson(input.payload))));
    const evt: SyncEvent = {
      event_id: ulid(),
      business_id: input.business_id,
      device_id: input.device_id,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation as SyncEvent['operation'],
      entity_version: input.entity_version,
      timestamp: input.timestamp,
      payload: input.payload,
      payload_hash,
      previous_hash,
      sync_status: 'LOCAL_ONLY',
      sync_attempts: 0,
      last_error: null,
      synced_at: null,
      journal_file: null,
    };
    await this.db.sync_events.add(evt);
  }
}

function previewAllocations(
  input: CreatePaymentInput,
): PaymentAllocation[] {
  const out: PaymentAllocation[] = [];
  let sum = 0;
  for (const a of input.allocations) {
    if (!Number.isInteger(a.amount_paise) || a.amount_paise <= 0) {
      throw new PaymentValidationError(
        'allocation amount must be positive integer paise',
      );
    }
    // Exactly one of: invoice_id, bill_id, as_advance must be set per slice.
    const targetCount =
      (a.invoice_id ? 1 : 0) + (a.bill_id ? 1 : 0) + (a.as_advance ? 1 : 0);
    if (targetCount !== 1) {
      throw new PaymentValidationError(
        'allocation must target exactly one of invoice_id, bill_id, or as_advance',
      );
    }
    if (input.direction === 'in' && a.bill_id) {
      throw new PaymentValidationError(
        'inbound payment cannot allocate to bill_id',
      );
    }
    if (input.direction === 'out' && a.invoice_id) {
      throw new PaymentValidationError(
        'outbound payment cannot allocate to invoice_id',
      );
    }
    sum += a.amount_paise;
    out.push({
      invoice_id: a.invoice_id,
      bill_id: a.bill_id,
      // '__PENDING__' is rewritten to the real Advance.id after materialization
      // in createPayment. It never survives to the persisted Payment row.
      advance_id: a.as_advance ? '__PENDING__' : undefined,
      amount_paise: a.amount_paise,
    });
  }
  if (sum > input.amount_paise) {
    throw new PaymentValidationError(
      `over-allocation: SUM(allocations)=${sum} exceeds amount_paise=${input.amount_paise}`,
    );
  }
  // Under-allocation is rejected: the caller must explicitly capture any excess
  // with an { as_advance: true } slice so it lands in Customer/Supplier Advances
  // instead of silently inflating AR/AP with no audit trail.
  if (sum < input.amount_paise) {
    throw new PaymentValidationError(
      `under-allocation: SUM(allocations)=${sum} is less than amount_paise=${input.amount_paise}. ` +
        `To record excess on account, add an { as_advance: true, amount_paise: <excess> } allocation.`,
    );
  }
  return out;
}

function validateCreateInput(input: CreatePaymentInput): void {
  if (!Number.isInteger(input.amount_paise) || input.amount_paise <= 0) {
    throw new PaymentValidationError('amount_paise must be positive integer');
  }
  if (input.allocations.length === 0) {
    throw new PaymentValidationError('at least one allocation required');
  }
  if (!input.cash_or_bank_account_id || !input.ar_or_ap_account_id) {
    throw new PaymentValidationError(
      'cash_or_bank_account_id and ar_or_ap_account_id required',
    );
  }
}

function buildJournalEntry(args: {
  id: string;
  business_id: string;
  entry_date: string;
  direction: PaymentDirection;
  amount_paise: number;
  cash_or_bank_account_id: string;
  ar_or_ap_account_id: string;
  // Split of amount_paise: allocated portion settles AR/AP, advance portion
  // goes to CUSTOMER_ADVANCE/SUPPLIER_ADVANCE. allocated + advance === amount.
  // When advance_paise is 0, collapses to the classic 2-line entry.
  allocated_paise: number;
  advance_paise: number;
  advance_account_id: string | null;
  party_type: PartyType;
  party_id: string;
  ref_id: string;
  narration: string;
  reverses_id: string | null;
  now: string;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const now = args.now;
  const cashAccount = args.cash_or_bank_account_id;
  const arApAccount = args.ar_or_ap_account_id;

  const entry: JournalEntry = {
    id: args.id,
    business_id: args.business_id,
    entry_number: `JE-${args.id.slice(-8)}`,
    entry_date: args.entry_date,
    narration: args.narration,
    ref_type: 'payment',
    ref_id: args.ref_id,
    reversed_by_id: null,
    reverses_id: args.reverses_id,
    total_debit_paise: args.amount_paise,
    total_credit_paise: args.amount_paise,
    posted: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };

  const lines: JournalLine[] = [];
  let lineNo = 1;
  // direction 'in':  Dr Cash        Cr AR (allocated) + Cr CustomerAdvance (excess)
  // direction 'out': Dr AP (alloc) + Dr SupplierAdvance (excess)  Cr Cash
  if (args.direction === 'in') {
    lines.push({
      id: ulid(),
      business_id: args.business_id,
      entry_id: entry.id,
      line_no: lineNo++,
      account_id: cashAccount,
      debit_paise: args.amount_paise,
      credit_paise: 0,
      party_type: null,
      party_id: null,
      description: 'Cash/Bank received',
    });
    if (args.allocated_paise > 0) {
      lines.push({
        id: ulid(),
        business_id: args.business_id,
        entry_id: entry.id,
        line_no: lineNo++,
        account_id: arApAccount,
        debit_paise: 0,
        credit_paise: args.allocated_paise,
        party_type: args.party_type,
        party_id: args.party_id,
        description: 'Accounts Receivable cleared',
      });
    }
    if (args.advance_paise > 0) {
      lines.push({
        id: ulid(),
        business_id: args.business_id,
        entry_id: entry.id,
        line_no: lineNo++,
        account_id: args.advance_account_id!,
        debit_paise: 0,
        credit_paise: args.advance_paise,
        party_type: args.party_type,
        party_id: args.party_id,
        description: 'Customer advance received',
      });
    }
  } else {
    if (args.allocated_paise > 0) {
      lines.push({
        id: ulid(),
        business_id: args.business_id,
        entry_id: entry.id,
        line_no: lineNo++,
        account_id: arApAccount,
        debit_paise: args.allocated_paise,
        credit_paise: 0,
        party_type: args.party_type,
        party_id: args.party_id,
        description: 'Accounts Payable settled',
      });
    }
    if (args.advance_paise > 0) {
      lines.push({
        id: ulid(),
        business_id: args.business_id,
        entry_id: entry.id,
        line_no: lineNo++,
        account_id: args.advance_account_id!,
        debit_paise: args.advance_paise,
        credit_paise: 0,
        party_type: args.party_type,
        party_id: args.party_id,
        description: 'Supplier advance paid',
      });
    }
    lines.push({
      id: ulid(),
      business_id: args.business_id,
      entry_id: entry.id,
      line_no: lineNo++,
      account_id: cashAccount,
      debit_paise: 0,
      credit_paise: args.amount_paise,
      party_type: null,
      party_id: null,
      description: 'Cash/Bank paid',
    });
  }

  return { entry, lines };
}

function computeInvoiceStatus(
  inv: Invoice,
  newPaid: number,
  newBalance: number,
): Invoice['status'] {
  if (inv.status === 'cancelled') return 'cancelled';
  if (newBalance <= 0 && newPaid >= inv.total_paise) return 'paid';
  if (newPaid > 0) return 'partial';
  return inv.status === 'draft' ? 'draft' : 'issued';
}

function computePurchaseStatus(
  bill: Purchase,
  newPaid: number,
  newBalance: number,
): Purchase['status'] {
  if (bill.status === 'cancelled') return 'cancelled';
  if (newBalance <= 0 && newPaid >= bill.total_paise) return 'paid';
  if (newPaid > 0) return 'partial';
  return bill.status;
}
