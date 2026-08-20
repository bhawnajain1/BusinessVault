import Dexie from 'dexie';
import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
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

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentValidationError';
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
          party_type: input.party_type,
          party_id: input.party_id,
          ref_id: paymentId,
          narration: `Payment ${input.payment_number}`,
          reverses_id: null,
          now,
        });

        await this.db.payments.add(paymentPreview);
        await this.db.journal_entries.add(journal.entry);
        await this.db.journal_lines.bulkAdd(journal.lines);

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
    if (
      (a.invoice_id && a.bill_id) ||
      (!a.invoice_id && !a.bill_id)
    ) {
      throw new PaymentValidationError(
        'allocation must target exactly one of invoice_id or bill_id',
      );
    }
    if (input.direction === 'in' && !a.invoice_id) {
      throw new PaymentValidationError(
        'inbound payment must allocate to invoice_id, not bill_id',
      );
    }
    if (input.direction === 'out' && !a.bill_id) {
      throw new PaymentValidationError(
        'outbound payment must allocate to bill_id, not invoice_id',
      );
    }
    sum += a.amount_paise;
    out.push({
      invoice_id: a.invoice_id,
      bill_id: a.bill_id,
      amount_paise: a.amount_paise,
    });
  }
  if (sum > input.amount_paise) {
    throw new PaymentValidationError(
      `over-allocation: SUM(allocations)=${sum} exceeds amount_paise=${input.amount_paise}`,
    );
  }
  // Regression fix: previously a payment could be posted where SUM(allocations)
  // was strictly less than amount_paise. buildJournalEntry then posted the full
  // amount_paise against AR/AP while allocations decremented only the allocated
  // portion — the difference silently created an unattributable balance
  // (customer over-payment) with no advance-account credit and no audit trail.
  // Reject under-allocation. Callers who want to record an advance/on-account
  // payment must add an explicit "advances" allocation.
  if (sum < input.amount_paise) {
    throw new PaymentValidationError(
      `under-allocation: SUM(allocations)=${sum} is less than amount_paise=${input.amount_paise}. ` +
        `To record an on-account payment, add an explicit allocation to the customer/supplier advance.`,
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
  party_type: PartyType;
  party_id: string;
  ref_id: string;
  narration: string;
  reverses_id: string | null;
  now: string;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const now = args.now;
  const debitAccount =
    args.direction === 'in'
      ? args.cash_or_bank_account_id
      : args.ar_or_ap_account_id;
  const creditAccount =
    args.direction === 'in'
      ? args.ar_or_ap_account_id
      : args.cash_or_bank_account_id;

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

  const lines: JournalLine[] = [
    {
      id: ulid(),
      business_id: args.business_id,
      entry_id: entry.id,
      line_no: 1,
      account_id: debitAccount,
      debit_paise: args.amount_paise,
      credit_paise: 0,
      party_type: args.direction === 'in' ? null : args.party_type,
      party_id: args.direction === 'in' ? null : args.party_id,
      description:
        args.direction === 'in' ? 'Cash/Bank received' : 'Accounts Payable settled',
    },
    {
      id: ulid(),
      business_id: args.business_id,
      entry_id: entry.id,
      line_no: 2,
      account_id: creditAccount,
      debit_paise: 0,
      credit_paise: args.amount_paise,
      party_type: args.direction === 'in' ? args.party_type : null,
      party_id: args.direction === 'in' ? args.party_id : null,
      description:
        args.direction === 'in'
          ? 'Accounts Receivable cleared'
          : 'Cash/Bank paid',
    },
  ];

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
