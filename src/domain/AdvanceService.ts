import Dexie from 'dexie';
import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type {
  Advance,
  AdvanceApplication,
  Invoice,
  JournalEntry,
  JournalLine,
  PartyType,
  PaymentMethod,
  Purchase,
  SyncEvent,
} from '../db/types';
import { GENESIS_HASH, canonicalJson, sha256Hex } from '../journal/event';
import { SYSTEM_ACCOUNT_CODES, findAccountByCode } from './coa';

// AdvanceService — Phase 2 of payablesRec.md.
//
// An advance is money received from a customer (or paid to a supplier) BEFORE
// any invoice or bill exists. It is held as a liability (Customer Advances,
// COA 2050) or asset (Supplier Advances, COA 1250) until applied.
//
// Design decisions (Grug: keep local, match PaymentService shape):
//   - Advances live in their own `advances` table, not on Customer.balance.
//     Preserves receipt-level audit trail (spec §5).
//   - Journal on RECORD (customer): Dr Cash/Bank, Cr Customer Advances liability.
//   - Journal on APPLY (customer):  Dr Customer Advances, Cr Accounts Receivable.
//     And bump the target invoice's paid_paise / balance_paise so aging works.
//   - Suppliers are the mirror image throughout.
//   - We do NOT re-use PaymentService.createPayment for record-advance because
//     that flow validates SUM(allocations) == amount_paise; an advance is
//     inherently unallocated at receipt time. Instead, this service posts its
//     own JE and hash-chain event, mirroring PaymentService's transaction
//     boundary exactly.

export interface RecordAdvanceInput {
  business_id: string;
  device_id: string;
  advance_number: string;
  advance_date: string;
  party_type: PartyType;
  party_id: string;
  method: PaymentMethod;
  cash_or_bank_account_id: string;
  amount_paise: number;
  reference?: string;
  notes?: string;
}

export interface ApplyAdvanceInput {
  business_id: string;
  device_id: string;
  advance_id: string;
  invoice_id?: string; // customer advance → apply to invoice
  bill_id?: string; // supplier advance → apply to bill
  amount_paise: number;
  applied_on: string; // YYYY-MM-DD
}

export class AdvanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdvanceValidationError';
  }
}

export class AdvanceService {
  constructor(private readonly db: BusinessVaultDB = defaultDb) {}

  async recordAdvance(input: RecordAdvanceInput): Promise<Advance> {
    if (!Number.isInteger(input.amount_paise) || input.amount_paise <= 0) {
      throw new AdvanceValidationError('amount_paise must be positive integer');
    }

    const advanceAcctCode =
      input.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE
        : SYSTEM_ACCOUNT_CODES.SUPPLIER_ADVANCE;
    const advanceAcct = await findAccountByCode(input.business_id, advanceAcctCode, {
      db: this.db,
    });
    if (!advanceAcct) {
      throw new AdvanceValidationError(
        `Advance account (code ${advanceAcctCode}) not found — run "Repair chart of accounts" in Settings.`,
      );
    }

    const advanceId = ulid();
    const journalEntryId = ulid();
    const now = new Date().toISOString();

    const advance: Advance = {
      id: advanceId,
      business_id: input.business_id,
      advance_number: input.advance_number,
      advance_date: input.advance_date,
      party_type: input.party_type,
      party_id: input.party_id,
      method: input.method,
      account_id: input.cash_or_bank_account_id,
      amount_paise: input.amount_paise,
      remaining_paise: input.amount_paise,
      reference: input.reference ?? '',
      notes: input.notes ?? '',
      applications: [],
      journal_entry_id: journalEntryId,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };
    const createdHash = await sha256Hex(canonicalJson(advance));

    return await this.db.transaction(
      'rw',
      [
        this.db.advances,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        const existing = await this.db.advances
          .where('id')
          .equals(advanceId)
          .first();
        if (existing) return existing;

        // Customer advance receipt: Dr Cash/Bank, Cr Customer Advances liab.
        // Supplier advance paid:    Dr Supplier Advances asset, Cr Cash/Bank.
        const debitAccount =
          input.party_type === 'customer'
            ? input.cash_or_bank_account_id
            : advanceAcct.id;
        const creditAccount =
          input.party_type === 'customer'
            ? advanceAcct.id
            : input.cash_or_bank_account_id;

        const entry: JournalEntry = {
          id: journalEntryId,
          business_id: input.business_id,
          entry_number: `JE-ADV-${advanceId.slice(-8)}`,
          entry_date: input.advance_date,
          narration:
            input.party_type === 'customer'
              ? `Customer advance received (${input.advance_number})`
              : `Supplier advance paid (${input.advance_number})`,
          ref_type: 'advance',
          ref_id: advanceId,
          reversed_by_id: null,
          reverses_id: null,
          total_debit_paise: input.amount_paise,
          total_credit_paise: input.amount_paise,
          posted: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        const lines: JournalLine[] = [
          {
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: 1,
            account_id: debitAccount,
            debit_paise: input.amount_paise,
            credit_paise: 0,
            party_type: input.party_type === 'supplier' ? input.party_type : null,
            party_id: input.party_type === 'supplier' ? input.party_id : null,
            description:
              input.party_type === 'customer'
                ? 'Cash/Bank received on account'
                : 'Advance paid to supplier',
          },
          {
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: 2,
            account_id: creditAccount,
            debit_paise: 0,
            credit_paise: input.amount_paise,
            party_type: input.party_type === 'customer' ? input.party_type : null,
            party_id: input.party_type === 'customer' ? input.party_id : null,
            description:
              input.party_type === 'customer'
                ? 'Customer advance liability'
                : 'Cash/Bank paid',
          },
        ];

        await this.db.advances.add(advance);
        await this.db.journal_entries.add(entry);
        await this.db.journal_lines.bulkAdd(lines);

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'advance',
          entity_id: advanceId,
          operation: 'created',
          entity_version: 1,
          payload: advance,
          payload_hash: createdHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: entry.id,
          operation: 'posted',
          entity_version: 1,
          payload: entry,
          timestamp: now,
        });
        for (const l of lines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: l.id,
            operation: 'created',
            entity_version: 1,
            payload: l,
            timestamp: now,
          });
        }

        return advance;
      },
    );
  }

  async applyAdvance(input: ApplyAdvanceInput): Promise<Advance> {
    if (!Number.isInteger(input.amount_paise) || input.amount_paise <= 0) {
      throw new AdvanceValidationError('amount_paise must be positive integer');
    }
    if ((input.invoice_id && input.bill_id) || (!input.invoice_id && !input.bill_id)) {
      throw new AdvanceValidationError(
        'apply must target exactly one of invoice_id or bill_id',
      );
    }

    const advance = await this.db.advances.get(input.advance_id);
    if (!advance) {
      throw new AdvanceValidationError(`advance ${input.advance_id} not found`);
    }
    if (advance.business_id !== input.business_id) {
      throw new AdvanceValidationError('business_id mismatch');
    }
    if (advance.remaining_paise < input.amount_paise) {
      throw new AdvanceValidationError(
        `advance remaining ${advance.remaining_paise} is less than apply amount ${input.amount_paise}`,
      );
    }
    if (advance.party_type === 'customer' && !input.invoice_id) {
      throw new AdvanceValidationError('customer advance must apply to invoice');
    }
    if (advance.party_type === 'supplier' && !input.bill_id) {
      throw new AdvanceValidationError('supplier advance must apply to bill');
    }

    const advanceAcctCode =
      advance.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE
        : SYSTEM_ACCOUNT_CODES.SUPPLIER_ADVANCE;
    const arApCode =
      advance.party_type === 'customer'
        ? SYSTEM_ACCOUNT_CODES.RECEIVABLE
        : SYSTEM_ACCOUNT_CODES.PAYABLE;
    const advanceAcct = await findAccountByCode(input.business_id, advanceAcctCode, {
      db: this.db,
    });
    const arApAcct = await findAccountByCode(input.business_id, arApCode, { db: this.db });
    if (!advanceAcct || !arApAcct) {
      throw new AdvanceValidationError(
        `Chart of accounts missing ${advanceAcctCode} or ${arApCode} — run "Repair chart of accounts".`,
      );
    }

    const journalEntryId = ulid();
    const now = new Date().toISOString();

    // Pre-hash the application payload outside the transaction — sha256Hex is
    // async on a non-Dexie promise, and awaiting it inside would trigger
    // Dexie's PrematureCommitError.
    const application: AdvanceApplication = {
      invoice_id: input.invoice_id,
      bill_id: input.bill_id,
      amount_paise: input.amount_paise,
      applied_at: now,
      journal_entry_id: journalEntryId,
    };
    const projectedRemaining = advance.remaining_paise - input.amount_paise;
    const appliedHash = await sha256Hex(
      canonicalJson({
        advance_id: advance.id,
        application,
        remaining_paise: projectedRemaining,
      }),
    );

    return await this.db.transaction(
      'rw',
      [
        this.db.advances,
        this.db.invoices,
        this.db.purchases,
        this.db.journal_entries,
        this.db.journal_lines,
        this.db.sync_events,
      ],
      async () => {
        // Bump target's paid/balance so aging math works.
        if (input.invoice_id) {
          const inv = await this.db.invoices.get(input.invoice_id);
          if (!inv) throw new AdvanceValidationError(`invoice ${input.invoice_id} not found`);
          if (input.amount_paise > inv.balance_paise) {
            throw new AdvanceValidationError(
              `apply ${input.amount_paise} exceeds invoice ${inv.invoice_number} balance ${inv.balance_paise}`,
            );
          }
          const updated: Invoice = {
            ...inv,
            paid_paise: inv.paid_paise + input.amount_paise,
            balance_paise: inv.balance_paise - input.amount_paise,
            status: computeInvoiceStatusAfterApply(
              inv,
              inv.paid_paise + input.amount_paise,
              inv.balance_paise - input.amount_paise,
            ),
            updated_at: now,
            entity_version: inv.entity_version + 1,
          };
          await this.db.invoices.put(updated);
        } else if (input.bill_id) {
          const bill = await this.db.purchases.get(input.bill_id);
          if (!bill) throw new AdvanceValidationError(`bill ${input.bill_id} not found`);
          if (input.amount_paise > bill.balance_paise) {
            throw new AdvanceValidationError(
              `apply ${input.amount_paise} exceeds bill ${bill.bill_number} balance ${bill.balance_paise}`,
            );
          }
          const updated: Purchase = {
            ...bill,
            paid_paise: bill.paid_paise + input.amount_paise,
            balance_paise: bill.balance_paise - input.amount_paise,
            status: computePurchaseStatusAfterApply(
              bill,
              bill.paid_paise + input.amount_paise,
              bill.balance_paise - input.amount_paise,
            ),
            updated_at: now,
            entity_version: bill.entity_version + 1,
          };
          await this.db.purchases.put(updated);
        }

        // Customer apply: Dr Customer Advances (liability ↓), Cr AR (asset ↓).
        // Supplier apply: Dr AP (liability ↓),                Cr Supplier Advances (asset ↓).
        const debitAccount = advance.party_type === 'customer' ? advanceAcct.id : arApAcct.id;
        const creditAccount = advance.party_type === 'customer' ? arApAcct.id : advanceAcct.id;

        const entry: JournalEntry = {
          id: journalEntryId,
          business_id: input.business_id,
          entry_number: `JE-ADVAPP-${journalEntryId.slice(-8)}`,
          entry_date: input.applied_on,
          narration:
            advance.party_type === 'customer'
              ? `Advance ${advance.advance_number} applied to invoice`
              : `Advance ${advance.advance_number} applied to bill`,
          ref_type: 'advance_application',
          ref_id: advance.id,
          reversed_by_id: null,
          reverses_id: null,
          total_debit_paise: input.amount_paise,
          total_credit_paise: input.amount_paise,
          posted: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        const lines: JournalLine[] = [
          {
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: 1,
            account_id: debitAccount,
            debit_paise: input.amount_paise,
            credit_paise: 0,
            party_type: advance.party_type,
            party_id: advance.party_id,
            description:
              advance.party_type === 'customer'
                ? 'Customer advance consumed'
                : 'Supplier bill settled from advance',
          },
          {
            id: ulid(),
            business_id: input.business_id,
            entry_id: journalEntryId,
            line_no: 2,
            account_id: creditAccount,
            debit_paise: 0,
            credit_paise: input.amount_paise,
            party_type: advance.party_type,
            party_id: advance.party_id,
            description:
              advance.party_type === 'customer'
                ? 'Invoice paid from advance'
                : 'Supplier advance consumed',
          },
        ];

        const updatedAdvance: Advance = {
          ...advance,
          remaining_paise: projectedRemaining,
          applications: [...advance.applications, application],
          updated_at: now,
          entity_version: advance.entity_version + 1,
        };

        await this.db.advances.put(updatedAdvance);
        await this.db.journal_entries.add(entry);
        await this.db.journal_lines.bulkAdd(lines);

        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'advance',
          entity_id: advance.id,
          operation: 'updated',
          entity_version: updatedAdvance.entity_version,
          payload: {
            advance_id: advance.id,
            application,
            remaining_paise: updatedAdvance.remaining_paise,
          },
          payload_hash: appliedHash,
          timestamp: now,
        });
        await this.writeEventPrehashed({
          business_id: input.business_id,
          device_id: input.device_id,
          entity_type: 'journal_entry',
          entity_id: entry.id,
          operation: 'posted',
          entity_version: 1,
          payload: entry,
          timestamp: now,
        });
        for (const l of lines) {
          await this.writeEventPrehashed({
            business_id: input.business_id,
            device_id: input.device_id,
            entity_type: 'journal_line',
            entity_id: l.id,
            operation: 'created',
            entity_version: 1,
            payload: l,
            timestamp: now,
          });
        }

        return updatedAdvance;
      },
    );
  }

  async listByParty(
    business_id: string,
    party_type: PartyType,
    party_id: string,
  ): Promise<Advance[]> {
    const rows = await this.db.advances
      .where('[business_id+party_type+party_id]')
      .equals([business_id, party_type, party_id])
      .toArray();
    return rows.sort((a, b) =>
      a.advance_date < b.advance_date ? -1 : a.advance_date > b.advance_date ? 1 : 0,
    );
  }

  private async writeEventPrehashed(input: {
    business_id: string;
    device_id: string;
    entity_type: SyncEvent['entity_type'];
    entity_id: string;
    operation: string;
    entity_version: number;
    payload: unknown;
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

function computeInvoiceStatusAfterApply(
  inv: Invoice,
  newPaid: number,
  newBalance: number,
): Invoice['status'] {
  if (inv.status === 'cancelled') return 'cancelled';
  if (newBalance <= 0 && newPaid >= inv.total_paise) return 'paid';
  if (newPaid > 0) return 'partial';
  return inv.status === 'draft' ? 'draft' : 'issued';
}

function computePurchaseStatusAfterApply(
  bill: Purchase,
  newPaid: number,
  newBalance: number,
): Purchase['status'] {
  if (bill.status === 'cancelled') return 'cancelled';
  if (newBalance <= 0 && newPaid >= bill.total_paise) return 'paid';
  if (newPaid > 0) return 'partial';
  return bill.status;
}
