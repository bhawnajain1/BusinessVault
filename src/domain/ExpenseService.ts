import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type { Expense, JournalEntry, JournalLine } from '../db/types';
import { appendSyncEvent } from './syncEventLog';

export interface ExpenseServiceDeps {
  db: BusinessVaultDB;
  now?: () => string;
}

export interface CreateExpenseInput {
  businessId: string;
  deviceId: string;
  expenseNumber: string;
  expenseDate: string;
  categoryAccountId: string; // debit — the expense P&L account
  paymentAccountId: string; // credit — cash or bank
  supplierId?: string | null;
  description?: string;
  amountPaise: number; // net expense amount
  taxPaise?: number; // input GST if any (posted to a separate GST account? For a
                     // grug-simple expense with no ITC we lump into the expense
                     // account. Caller can pass 0 if they want.)
  attachmentId?: string | null;
  idempotencyKey?: string;
}

export class ExpenseService {
  private readonly db: BusinessVaultDB;
  private readonly now: () => string;

  constructor(deps: ExpenseServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateExpenseInput): Promise<Expense> {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new Error('amountPaise must be positive integer paise');
    }
    if (input.taxPaise !== undefined) {
      if (!Number.isInteger(input.taxPaise) || input.taxPaise < 0) {
        throw new Error('taxPaise must be non-negative integer paise');
      }
    }
    if (!input.expenseNumber || input.expenseNumber.trim().length === 0) {
      throw new Error('expenseNumber is required');
    }

    const now = this.now();
    const expenseId = ulid();
    const journalId = ulid();
    const tax = input.taxPaise ?? 0;
    const total = input.amountPaise + tax;

    const expense: Expense = {
      id: expenseId,
      business_id: input.businessId,
      expense_number: input.expenseNumber.trim(),
      expense_date: input.expenseDate,
      category_account_id: input.categoryAccountId,
      payment_account_id: input.paymentAccountId,
      supplier_id: input.supplierId ?? null,
      description: input.description ?? '',
      amount_paise: input.amountPaise,
      tax_paise: tax,
      total_paise: total,
      attachment_id: input.attachmentId ?? null,
      journal_entry_id: journalId,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const journal: JournalEntry = {
      id: journalId,
      business_id: input.businessId,
      entry_number: `JE-${expense.expense_number}`,
      entry_date: expense.expense_date,
      narration: `Expense ${expense.expense_number}: ${expense.description}`.trim(),
      ref_type: 'expense',
      ref_id: expenseId,
      reversed_by_id: null,
      reverses_id: null,
      total_debit_paise: total,
      total_credit_paise: total,
      posted: 1,
      created_at: now,
      updated_at: now,
      entity_version: 1,
    };

    const journalLines: JournalLine[] = [
      {
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: 1,
        account_id: input.categoryAccountId,
        debit_paise: total,
        credit_paise: 0,
        party_type: input.supplierId ? 'supplier' : null,
        party_id: input.supplierId ?? null,
        description: expense.description,
      },
      {
        id: ulid(),
        business_id: input.businessId,
        entry_id: journalId,
        line_no: 2,
        account_id: input.paymentAccountId,
        debit_paise: 0,
        credit_paise: total,
        party_type: null,
        party_id: null,
        description: `Payment for expense ${expense.expense_number}`,
      },
    ];

    if (journal.total_debit_paise !== journal.total_credit_paise) {
      throw new Error('Expense journal not balanced');
    }

    const db = this.db;
    return db.transaction(
      'rw',
      [db.expenses, db.journal_entries, db.journal_lines, db.sync_events],
      async () => {
        // Idempotency check FIRST: if the caller retries a create with the same
        // idempotencyKey, return the previously-persisted expense instead of
        // adding a second row (which would otherwise fail the expense_number
        // dup check with a confusing error).
        if (input.idempotencyKey) {
          const priorEvent = (await db.sync_events.toArray()) as unknown as Array<
            Record<string, unknown>
          >;
          for (const r of priorEvent) {
            if (
              r['business_id'] === input.businessId &&
              r['entity_type'] === 'expense' &&
              r['idempotency_key'] === input.idempotencyKey
            ) {
              const existing = await db.expenses.get(String(r['entity_id']));
              if (existing) return existing;
            }
          }
        }

        const dup = await db.expenses
          .where('business_id')
          .equals(input.businessId)
          .and((e) => e.expense_number === expense.expense_number)
          .first();
        if (dup) {
          throw new Error(
            `Expense number already exists: ${expense.expense_number}`,
          );
        }

        await db.expenses.add(expense);
        await db.journal_entries.add(journal);
        for (const l of journalLines) await db.journal_lines.add(l);

        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'expense',
          entityId: expense.id,
          operation: 'created',
          payload: expense,
          timestamp: now,
          idempotencyKey: input.idempotencyKey,
        });
        await appendSyncEvent(db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'journal_entry',
          entityId: journal.id,
          operation: 'posted',
          payload: journal,
          timestamp: now,
        });
        for (const l of journalLines) {
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
        return expense;
      },
    );
  }

  async get(id: string): Promise<Expense | undefined> {
    return this.db.expenses.get(id);
  }

  async list(businessId: string): Promise<Expense[]> {
    return this.db.expenses
      .where('business_id')
      .equals(businessId)
      .toArray();
  }
}

export function createExpenseService(
  deps: ExpenseServiceDeps,
): ExpenseService {
  return new ExpenseService(deps);
}
