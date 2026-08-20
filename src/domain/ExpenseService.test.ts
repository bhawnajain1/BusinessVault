import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BusinessVaultDB } from '../db/database';
import { ExpenseService } from './ExpenseService';

const BIZ = 'biz-exp';
const DEV = 'dev-exp';

function freshDb(): BusinessVaultDB {
  return new BusinessVaultDB('bv-exp-' + Math.random().toString(36).slice(2));
}

describe('ExpenseService', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('creates an expense with balanced journal entry and emits events', async () => {
    const db = freshDb();
    const svc = new ExpenseService({ db });
    const e = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      expenseNumber: 'EXP-1',
      expenseDate: '2026-08-19',
      categoryAccountId: 'acc-rent',
      paymentAccountId: 'acc-cash',
      description: 'Office rent',
      amountPaise: 500000,
    });
    expect(e.total_paise).toBe(500000);
    const je = await db.journal_entries.get(e.journal_entry_id);
    expect(je).toBeDefined();
    expect(je!.total_debit_paise).toBe(500000);
    expect(je!.total_credit_paise).toBe(500000);
    const lines = await db.journal_lines.where('entry_id').equals(je!.id).toArray();
    expect(lines.length).toBe(2);
    const dr = lines.find((l) => l.debit_paise > 0);
    const cr = lines.find((l) => l.credit_paise > 0);
    expect(dr!.account_id).toBe('acc-rent');
    expect(cr!.account_id).toBe('acc-cash');

    const events = (await db.sync_events.toArray()) as unknown as Array<
      Record<string, unknown>
    >;
    const kinds = events.map((ev) => `${ev['entity_type']}.${ev['operation']}`).sort();
    expect(kinds).toEqual(
      [
        'expense.created',
        'journal_entry.posted',
        'journal_line.created',
        'journal_line.created',
      ].sort(),
    );
  });

  it('retries with same idempotencyKey return the same expense (regression)', async () => {
    const db = freshDb();
    const svc = new ExpenseService({ db });
    const first = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      expenseNumber: 'EXP-IDEMP',
      expenseDate: '2026-08-19',
      categoryAccountId: 'acc-rent',
      paymentAccountId: 'acc-cash',
      description: 'Rent',
      amountPaise: 100000,
      idempotencyKey: 'key-abc',
    });
    // Retry with the same key but different expenseNumber must return the
    // first expense (not throw a "number already exists" error and not add a
    // second row).
    const second = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      expenseNumber: 'EXP-IDEMP-RETRY',
      expenseDate: '2026-08-19',
      categoryAccountId: 'acc-rent',
      paymentAccountId: 'acc-cash',
      description: 'Rent (retry)',
      amountPaise: 100000,
      idempotencyKey: 'key-abc',
    });
    expect(second.id).toBe(first.id);
    expect((await db.expenses.toArray()).length).toBe(1);
  });

  it('rejects zero-amount expense and rolls back', async () => {
    const db = freshDb();
    const svc = new ExpenseService({ db });
    await expect(
      svc.create({
        businessId: BIZ,
        deviceId: DEV,
        expenseNumber: 'EXP-BAD',
        expenseDate: '2026-08-19',
        categoryAccountId: 'acc-rent',
        paymentAccountId: 'acc-cash',
        amountPaise: 0,
      }),
    ).rejects.toThrow(/amountPaise/);
    expect((await db.expenses.toArray()).length).toBe(0);
    expect((await db.journal_entries.toArray()).length).toBe(0);
    expect((await db.sync_events.toArray()).length).toBe(0);
  });
});
