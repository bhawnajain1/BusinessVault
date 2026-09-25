import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BusinessVaultDB } from '../db/database';
import type { Invoice, Purchase, Account } from '../db/types';
import { AdvanceService, AdvanceValidationError } from './AdvanceService';
import { SYSTEM_ACCOUNT_CODES } from './coa';

const BIZ = 'biz-adv';
const DEV = 'dev-adv';

function freshDb(): BusinessVaultDB {
  return new BusinessVaultDB(
    'bv-adv-' + Math.random().toString(36).slice(2),
  );
}

function makeAccount(id: string, code: string, type: Account['type']): Account {
  return {
    id,
    business_id: BIZ,
    code,
    name: code,
    type,
    subtype: '',
    parent_id: null,
    opening_balance_paise: 0,
    is_system: 1,
    active: 1,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    entity_version: 1,
  };
}

async function seedAccounts(db: BusinessVaultDB): Promise<void> {
  await db.accounts.bulkAdd([
    makeAccount('acc-cash', SYSTEM_ACCOUNT_CODES.CASH, 'asset'),
    makeAccount('acc-bank', SYSTEM_ACCOUNT_CODES.BANK, 'asset'),
    makeAccount('acc-ar', SYSTEM_ACCOUNT_CODES.RECEIVABLE, 'asset'),
    makeAccount('acc-ap', SYSTEM_ACCOUNT_CODES.PAYABLE, 'liability'),
    makeAccount('acc-cust-adv', SYSTEM_ACCOUNT_CODES.CUSTOMER_ADVANCE, 'liability'),
    makeAccount('acc-sup-adv', SYSTEM_ACCOUNT_CODES.SUPPLIER_ADVANCE, 'asset'),
  ]);
}

function makeInvoice(id: string, total: number): Invoice {
  return {
    id,
    business_id: BIZ,
    invoice_number: 'INV-' + id,
    invoice_date: '2026-08-20',
    due_date: null,
    customer_id: 'cust-1',
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: total,
    discount_paise: 0,
    taxable_paise: total,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: total,
    total_paise: total,
    paid_paise: 0,
    balance_paise: total,
    status: 'issued',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: 'je-' + id,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    entity_version: 1,
  };
}

function makeBill(id: string, total: number): Purchase {
  return {
    id,
    business_id: BIZ,
    bill_number: 'BILL-' + id,
    supplier_bill_number: 'SUP-' + id,
    bill_date: '2026-08-20',
    due_date: null,
    supplier_id: 'sup-1',
    supplier_state_code: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: total,
    discount_paise: 0,
    taxable_paise: total,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: total,
    total_paise: total,
    paid_paise: 0,
    balance_paise: total,
    status: 'received',
    reversed_by_purchase_id: null,
    reverses_purchase_id: null,
    notes: '',
    attachment_id: null,
    journal_entry_id: 'je-' + id,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    entity_version: 1,
  };
}

describe('AdvanceService', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('records a customer advance and posts balanced journal (Dr Cash, Cr Customer Advances)', async () => {
    const db = freshDb();
    await seedAccounts(db);
    const svc = new AdvanceService(db);

    const adv = await svc.recordAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_number: 'ADV-001',
      advance_date: '2026-08-20',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      amount_paise: 50_000,
    });

    expect(adv.remaining_paise).toBe(50_000);
    expect(adv.applications).toEqual([]);

    const entry = await db.journal_entries.get(adv.journal_entry_id);
    expect(entry?.total_debit_paise).toBe(50_000);
    expect(entry?.total_credit_paise).toBe(50_000);
    const lines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, adv.journal_entry_id])
      .toArray();
    const debit = lines.find((l) => l.debit_paise > 0)!;
    const credit = lines.find((l) => l.credit_paise > 0)!;
    expect(debit.account_id).toBe('acc-cash');
    expect(credit.account_id).toBe('acc-cust-adv');
  });

  it('applies a customer advance to an invoice and updates balance', async () => {
    const db = freshDb();
    await seedAccounts(db);
    await db.invoices.add(makeInvoice('inv-1', 80_000));
    const svc = new AdvanceService(db);

    const adv = await svc.recordAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_number: 'ADV-002',
      advance_date: '2026-08-20',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      amount_paise: 50_000,
    });

    const applied = await svc.applyAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_id: adv.id,
      invoice_id: 'inv-1',
      amount_paise: 50_000,
      applied_on: '2026-08-21',
    });

    expect(applied.remaining_paise).toBe(0);
    expect(applied.applications).toHaveLength(1);
    expect(applied.applications[0].invoice_id).toBe('inv-1');

    const inv = await db.invoices.get('inv-1');
    expect(inv?.paid_paise).toBe(50_000);
    expect(inv?.balance_paise).toBe(30_000);
    expect(inv?.status).toBe('partial');
  });

  it('rejects apply amount exceeding remaining', async () => {
    const db = freshDb();
    await seedAccounts(db);
    await db.invoices.add(makeInvoice('inv-2', 80_000));
    const svc = new AdvanceService(db);

    const adv = await svc.recordAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_number: 'ADV-003',
      advance_date: '2026-08-20',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'upi',
      cash_or_bank_account_id: 'acc-bank',
      amount_paise: 10_000,
    });

    await expect(
      svc.applyAdvance({
        business_id: BIZ,
        device_id: DEV,
        advance_id: adv.id,
        invoice_id: 'inv-2',
        amount_paise: 20_000,
        applied_on: '2026-08-21',
      }),
    ).rejects.toThrow(AdvanceValidationError);
  });

  it('supplier advance journal reverses direction (Dr Supplier Advances, Cr Cash)', async () => {
    const db = freshDb();
    await seedAccounts(db);
    const svc = new AdvanceService(db);

    const adv = await svc.recordAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_number: 'SADV-001',
      advance_date: '2026-08-20',
      party_type: 'supplier',
      party_id: 'sup-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-bank',
      amount_paise: 30_000,
    });

    const lines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, adv.journal_entry_id])
      .toArray();
    const debit = lines.find((l) => l.debit_paise > 0)!;
    const credit = lines.find((l) => l.credit_paise > 0)!;
    expect(debit.account_id).toBe('acc-sup-adv');
    expect(credit.account_id).toBe('acc-bank');
  });

  it('applies a supplier advance to a bill', async () => {
    const db = freshDb();
    await seedAccounts(db);
    await db.purchases.add(makeBill('bill-1', 40_000));
    const svc = new AdvanceService(db);

    const adv = await svc.recordAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_number: 'SADV-002',
      advance_date: '2026-08-20',
      party_type: 'supplier',
      party_id: 'sup-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-bank',
      amount_paise: 40_000,
    });

    const applied = await svc.applyAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_id: adv.id,
      bill_id: 'bill-1',
      amount_paise: 40_000,
      applied_on: '2026-08-21',
    });

    expect(applied.remaining_paise).toBe(0);
    const bill = await db.purchases.get('bill-1');
    expect(bill?.paid_paise).toBe(40_000);
    expect(bill?.balance_paise).toBe(0);
    expect(bill?.status).toBe('paid');
  });

  it('rejects customer advance applied to bill (party-type mismatch)', async () => {
    const db = freshDb();
    await seedAccounts(db);
    await db.purchases.add(makeBill('bill-2', 40_000));
    const svc = new AdvanceService(db);

    const adv = await svc.recordAdvance({
      business_id: BIZ,
      device_id: DEV,
      advance_number: 'ADV-004',
      advance_date: '2026-08-20',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      amount_paise: 10_000,
    });

    await expect(
      svc.applyAdvance({
        business_id: BIZ,
        device_id: DEV,
        advance_id: adv.id,
        bill_id: 'bill-2',
        amount_paise: 10_000,
        applied_on: '2026-08-21',
      }),
    ).rejects.toThrow(AdvanceValidationError);
  });
});
