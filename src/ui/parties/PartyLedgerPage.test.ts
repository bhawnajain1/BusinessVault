import { describe, expect, it } from 'vitest';
import type { Advance, Payment, PartyType } from '../../db/types';
import { buildCustomerRows, buildSupplierRows } from './PartyLedgerPage';
import { buildStatement } from '../customers/CustomerDetailPage';
import { BusinessVaultDB } from '../../db/database';
import { seedChartOfAccounts, SYSTEM_ACCOUNT_CODES } from '../../domain/coa';
import { PaymentService } from '../../domain/PaymentService';

function payment(partyType: PartyType): Payment {
  return {
    id: 'payment-1', business_id: 'business-1', payment_number: 'PAY-1',
    payment_date: '2026-11-04', direction: partyType === 'customer' ? 'in' : 'out',
    party_type: partyType, party_id: 'party-1', method: 'bank', account_id: 'bank-1',
    amount_paise: 50000, reference: '', notes: '',
    allocations: [{ advance_id: 'advance-1', amount_paise: 50000 }],
    journal_entry_id: 'journal-payment-1', created_at: '2026-11-04T08:11:45Z',
    updated_at: '2026-11-04T08:11:45Z', entity_version: 1,
  };
}

function advance(partyType: PartyType, remaining: number): Advance {
  return {
    id: 'advance-1', business_id: 'business-1', advance_number: 'ADV-1',
    advance_date: '2026-11-04', party_type: partyType, party_id: 'party-1',
    method: 'bank', account_id: 'bank-1', amount_paise: 50000,
    remaining_paise: remaining, reference: '', notes: '', applications: [],
    journal_entry_id: 'journal-payment-1', created_at: '2026-11-04T08:11:45Z',
    updated_at: '2026-11-04T08:11:45Z', entity_version: 1,
  };
}

describe.each(['customer', 'supplier'] as const)('%s ledger advances', (partyType) => {
  function rows(payments: Payment[], advances: Advance[]) {
    return partyType === 'customer'
      ? buildCustomerRows(null, [], [], payments, advances)
      : buildSupplierRows(null, [], payments, advances);
  }

  it('reads persisted payment and advance records correctly without changing them', async () => {
    const db = new BusinessVaultDB(`ledger-regression-${partyType}-${Math.random()}`);
    try {
      const accounts = await seedChartOfAccounts('business-1', { db, deviceId: 'device-1' });
      const bank = accounts.find((account) => account.code === SYSTEM_ACCOUNT_CODES.BANK)!;
      const control = accounts.find((account) => account.code === (
        partyType === 'customer' ? SYSTEM_ACCOUNT_CODES.RECEIVABLE : SYSTEM_ACCOUNT_CODES.PAYABLE
      ))!;
      await new PaymentService(db).createPayment({
        business_id: 'business-1', device_id: 'device-1', payment_number: 'PAY-EXISTING',
        payment_date: '2026-11-04', direction: partyType === 'customer' ? 'in' : 'out',
        party_type: partyType, party_id: 'party-1', method: 'bank',
        cash_or_bank_account_id: bank.id, ar_or_ap_account_id: control.id,
        amount_paise: 50000, advance_number: 'ADV-EXISTING',
        allocations: [{ as_advance: true, amount_paise: 50000 }],
      });
      db.close();
      await db.open();
      const payments = await db.payments.toArray();
      const advances = await db.advances.toArray();
      expect(rows(payments, advances).reduce(
        (sum, row) => sum + row.debit_paise - row.credit_paise, 0,
      )).toBe(-50000);
      const bankLines = await db.journal_lines.filter((line) => line.account_id === bank.id).toArray();
      expect(bankLines).toHaveLength(1);
      expect(bankLines[0].debit_paise + bankLines[0].credit_paise).toBe(50000);
      expect(await db.payments.toArray()).toEqual(payments);
      expect(await db.advances.toArray()).toEqual(advances);
    } finally {
      await db.delete();
    }
  });

  it.each([50000, 20000, 0])('counts an existing payment-linked advance once with %i paise remaining', (remaining) => {
    const payments = [payment(partyType)];
    const advances = [advance(partyType, remaining)];
    const ledger = rows(payments, advances);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe('payment');
    expect(ledger.reduce((sum, row) => sum + row.debit_paise - row.credit_paise, 0)).toBe(-50000);
    if (partyType === 'customer') {
      expect(buildStatement([], [], payments, advances).reduce(
        (sum, row) => sum + row.debit_paise - row.credit_paise, 0,
      )).toBe(-50000);
    }
  });

  it('does not double-count the advance portion of a mixed allocated payment', () => {
    const pay = payment(partyType);
    pay.amount_paise = 80000;
    pay.allocations.push({
      ...(partyType === 'customer' ? { invoice_id: 'invoice-1' } : { bill_id: 'bill-1' }),
      amount_paise: 30000,
    });
    expect(rows([pay], [advance(partyType, 50000)]).reduce(
      (sum, row) => sum + row.credit_paise, 0,
    )).toBe(80000);
  });

  it.each([50000, 20000, 0])('preserves a standalone advance receipt with %i paise remaining', (remaining) => {
    const adv = { ...advance(partyType, remaining), journal_entry_id: 'standalone-journal' };
    expect(rows([], [adv])[0]?.credit_paise).toBe(50000);
    if (partyType === 'customer') {
      expect(buildStatement([], [], [], [adv])[0]?.credit_paise).toBe(50000);
    }
  });

  it('keeps a separate advance even when its amount equals a payment', () => {
    const adv = { ...advance(partyType, 50000), journal_entry_id: 'standalone-journal' };
    expect(rows([payment(partyType)], [adv])).toHaveLength(2);
  });

  it('does not use deleted payments to hide an active advance', () => {
    const pay = { ...payment(partyType), deleted_at: '2026-11-05T00:00:00Z' };
    const adv = advance(partyType, 50000);
    expect(rows([pay], [adv])[0]?.credit_paise).toBe(50000);
    if (partyType === 'customer') {
      expect(buildStatement([], [], [pay], [adv])[0]?.credit_paise).toBe(50000);
    }
  });

  it('does not treat missing journal identifiers as a shared transaction', () => {
    const pay = { ...payment(partyType), journal_entry_id: '' };
    const adv = { ...advance(partyType, 50000), journal_entry_id: '' };
    expect(rows([pay], [adv])).toHaveLength(2);
    if (partyType === 'customer') expect(buildStatement([], [], [pay], [adv])).toHaveLength(2);
  });

  it('excludes deleted standalone advances', () => {
    const adv = { ...advance(partyType, 50000), deleted_at: '2026-11-05T00:00:00Z' };
    expect(rows([], [adv])).toHaveLength(0);
  });
});

it('keeps legacy sales-return credits at their remaining amount, including cancellation', () => {
  for (const remaining of [20000, 0]) {
    const adv = { ...advance('customer', remaining), reference: 'sales_return:return-1' };
    const ledger = buildCustomerRows(null, [], [], [], [adv]);
    const statement = buildStatement([], [], [], [adv]);
    expect(ledger.reduce((sum, row) => sum + row.credit_paise, 0)).toBe(remaining);
    expect(statement.reduce((sum, row) => sum + row.credit_paise, 0)).toBe(remaining);
  }
});
