import { describe, expect, it } from 'vitest';
import type { Advance, Invoice, Payment, SalesReturn } from '../../db/types';
import { buildStatement, calculateNetPaid } from './CustomerDetailPage';
import { buildCustomerRows } from '../parties/PartyLedgerPage';

function payment(
  id: string,
  direction: Payment['direction'],
  amount_paise: number,
  invoice_id: string,
): Payment {
  return {
    id,
    business_id: 'business-1',
    payment_number: id,
    payment_date: '2026-09-30',
    direction,
    party_type: 'customer',
    party_id: 'customer-1',
    method: 'cash',
    account_id: 'cash-1',
    amount_paise,
    reference: direction === 'out' ? `refund of ${invoice_id}` : '',
    notes: '',
    allocations: [{ invoice_id, amount_paise }],
    journal_entry_id: `journal-${id}`,
    created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:00.000Z',
    entity_version: 1,
  };
}

function invoice(id: string, number: string): Invoice {
  return {
    id,
    business_id: 'business-1',
    invoice_number: number,
    invoice_date: '2026-09-01',
    due_date: null,
    customer_id: 'customer-1',
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: 10000,
    discount_paise: 0,
    taxable_paise: 10000,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: 10000,
    total_paise: 10000,
    paid_paise: 10000,
    balance_paise: 0,
    status: 'cancelled',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: `journal-${id}`,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:00.000Z',
    entity_version: 1,
  };
}

function salesReturn(id: string, invoice_id: string): SalesReturn {
  return {
    id,
    business_id: 'business-1',
    return_number: id,
    original_invoice_id: invoice_id,
    customer_id: 'customer-1',
    return_date: '2026-09-30',
    reason: 'Full return',
    status: 'posted',
    total_paise: 10000,
    apply_to_balance_paise: 10000,
    subtotal_paise: 10000,
    discount_paise: 0,
    taxable_paise: 10000,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: 10000,
    customer_credit_paise: 0,
    notes: '',
    reversed_credit_note_invoice_id: null,
    legacy_migration_classification: null,
    device_id: 'device-1',
    journal_entry_id: `journal-${id}`,
    created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:00.000Z',
    entity_version: 1,
  };
}

describe('customer payment refunds', () => {
  it('nets multiple fully paid and fully refunded invoices to zero', () => {
    const invoices = [invoice('invoice-1', 'INV-001'), invoice('invoice-2', 'INV-002')];
    const payments = [
      payment('receipt-1', 'in', 10000, 'invoice-1'),
      payment('receipt-2', 'in', 10000, 'invoice-2'),
      payment('refund-1', 'out', -10000, 'invoice-1'),
      payment('refund-2', 'out', -10000, 'invoice-2'),
    ];
    const returns = [salesReturn('return-1', 'invoice-1'), salesReturn('return-2', 'invoice-2')];
    const advances: Advance[] = [];

    expect(calculateNetPaid(payments)).toBe(0);

    const statement = buildStatement(invoices, returns, payments, advances);
    const closingBalance = statement.reduce(
      (balance, row) => balance + row.debit_paise - row.credit_paise,
      0,
    );
    expect(closingBalance).toBe(0);
    expect(statement.filter((row) => row.transaction.includes('refund-')).length).toBe(2);
    expect(statement.some((row) => row.transaction.includes('refund-1'))).toBe(true);
    expect(statement.some((row) => row.transaction.includes('refund-2'))).toBe(true);

    const ledgerRows = buildCustomerRows(null, invoices, returns, payments, advances);
    expect(ledgerRows.reduce((balance, row) => balance + row.debit_paise - row.credit_paise, 0)).toBe(0);
    expect(ledgerRows.filter((row) => row.kind === 'payment' && row.debit_paise > 0)).toHaveLength(2);
    expect(ledgerRows.some((row) => row.kind === 'advance')).toBe(false);
  });
});
