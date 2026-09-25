import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { reconcileAfter } from './reconciliation';
import { db } from '../db';
import { log } from '../lib/log';
import type { JournalEntry, JournalLine, Business } from '../db/types';

function makeBusiness(id = 'biz1'): Business {
  const now = new Date().toISOString();
  return {
    id,
    name: 'Test Co',
    legal_name: 'Test Co',
    gstin: null,
    pan: null,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    state_code: '',
    pincode: '',
    country: 'IN',
    phone: '',
    email: '',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    signature_ref: null,
    show_signature_on_invoice: 0,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 3,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  } as Business;
}

async function seedBalancedJournal(businessId: string): Promise<void> {
  const entryId = ulid();
  const now = new Date().toISOString();
  const entry: JournalEntry = {
    id: entryId,
    business_id: businessId,
    entry_number: 'JE-1',
    entry_date: '2026-08-26',
    narration: 'test',
    ref_type: 'invoice',
    ref_id: null,
    reversed_by_id: null,
    reverses_id: null,
    total_debit_paise: 10000,
    total_credit_paise: 10000,
    posted: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  const lines: JournalLine[] = [
    {
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: 1,
      account_id: 'A/R',
      debit_paise: 10000,
      credit_paise: 0,
      party_type: null,
      party_id: null,
      description: 'debit',
    },
    {
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: 2,
      account_id: 'Sales',
      debit_paise: 0,
      credit_paise: 10000,
      party_type: null,
      party_id: null,
      description: 'credit',
    },
  ];
  await db.journal_entries.add(entry);
  await db.journal_lines.bulkAdd(lines);
}

async function seedUnbalancedJournal(businessId: string): Promise<void> {
  const entryId = ulid();
  const now = new Date().toISOString();
  const entry: JournalEntry = {
    id: entryId,
    business_id: businessId,
    entry_number: 'JE-BAD',
    entry_date: '2026-08-26',
    narration: 'unbalanced on purpose',
    ref_type: 'invoice',
    ref_id: null,
    reversed_by_id: null,
    reverses_id: null,
    total_debit_paise: 5000,
    total_credit_paise: 5000,
    posted: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.journal_entries.add(entry);
  await db.journal_lines.bulkAdd([
    {
      id: ulid(),
      business_id: businessId,
      entry_id: entryId,
      line_no: 1,
      account_id: 'A/R',
      debit_paise: 5000,
      credit_paise: 0,
      party_type: null,
      party_id: null,
      description: '',
    },
    // deliberately dropping the credit line — sum(dr) != sum(cr)
  ]);
}

describe('§17 reconcileAfter', () => {
  beforeEach(async () => {
    // Flush any buffered entries from prior tests before clearing the store —
    // otherwise those buffered writes land AFTER our .clear() and pollute the
    // next test's log assertions.
    await log.flush();
    await db.businesses.clear();
    await db.journal_entries.clear();
    await db.journal_lines.clear();
    await db.invoices.clear();
    await db.audit_log.clear();
    await db.debug_logs.clear();
    await db.businesses.put(makeBusiness('biz1'));
  });

  it('reports ok when journal is balanced and no receivables drift', async () => {
    await seedBalancedJournal('biz1');
    const res = await reconcileAfter('biz1', 'invoice.edit');
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.accounting.balanced).toBe(true);
    expect(res.accounting.totalDebits).toBe(10000);
    expect(res.accounting.totalCredits).toBe(10000);
  });

  it('reports failure and writes audit_log row when accounting is unbalanced', async () => {
    await seedUnbalancedJournal('biz1');
    const res = await reconcileAfter('biz1', 'invoice.recycle', {
      operationId: 'OP123',
      deviceId: 'dev1',
    });
    expect(res.ok).toBe(false);
    expect(res.accounting.balanced).toBe(false);
    expect(res.failures.length).toBeGreaterThan(0);
    // audit_log has a durable record.
    const rows = await db.audit_log
      .where('business_id')
      .equals('biz1')
      .toArray();
    const failed = rows.find((r) => r.action === 'reconciliation.failed');
    expect(failed).toBeDefined();
    const after = failed!.after as { op: string; operationId: string | null };
    expect(after.op).toBe('invoice.recycle');
    expect(after.operationId).toBe('OP123');
    expect(failed!.device_id).toBe('dev1');
  });

  it('never throws even if the business has no journal at all', async () => {
    // Empty journal is a legitimate startup state — should be balanced (0=0).
    const res = await reconcileAfter('biz1', 'drive.restore');
    expect(res.ok).toBe(true);
    expect(res.accounting.totalDebits).toBe(0);
    expect(res.accounting.totalCredits).toBe(0);
  });

  it('logs a debug breadcrumb on start and info on ok result', async () => {
    await seedBalancedJournal('biz1');
    await reconcileAfter('biz1', 'sales_return.create', {
      operationId: 'OP-SR-1',
    });
    await log.flush();
    const logs = await db.debug_logs.toArray();
    const startLog = logs.find((l) => l.source === 'reconciliation.start');
    const okLog = logs.find((l) => l.source === 'reconciliation.ok');
    expect(startLog).toBeDefined();
    expect(okLog).toBeDefined();
    expect((okLog!.ctx as { operationId: string }).operationId).toBe('OP-SR-1');
  });
});
