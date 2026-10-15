import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { db } from '../../db';
import type { Account, Customer, Invoice } from '../../db/types';
import { SYSTEM_ACCOUNT_CODES } from '../../domain/coa';
import PaymentsPage from './PaymentsPage';

vi.mock('../hooks/useActiveBusiness', () => ({
  useActiveBusiness: () => ({ businessId: 'payments-test-biz', deviceId: 'payments-test-device', loading: false, error: null }),
}));

const BUSINESS_ID = 'payments-test-biz';

function makeInvoice(id: string, number: string, totalPaise: number): Invoice {
  return {
    id,
    business_id: BUSINESS_ID,
    invoice_number: number,
    invoice_date: '2026-10-01',
    due_date: null,
    customer_id: 'customer-1',
    customer_state_code: '27',
    place_of_supply: '27',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: totalPaise,
    discount_paise: 0,
    taxable_paise: totalPaise,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: totalPaise,
    total_paise: totalPaise,
    paid_paise: 0,
    balance_paise: totalPaise,
    status: 'issued',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: `journal-${id}`,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    entity_version: 1,
  };
}

beforeEach(async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open'); },
  });
  await Promise.all(db.tables.map((table) => table.clear()));
  const customer: Customer = {
    id: 'customer-1', business_id: BUSINESS_ID, name: 'Ravi Stores', phone: '', email: '',
    gstin: null, billing_address: '', shipping_address: '', state: '', state_code: '27',
    opening_balance_paise: 2500, credit_limit_paise: 0, notes: '', active: 1,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', entity_version: 1,
  };
  const accounts: Account[] = [
    { id: 'cash-account', business_id: BUSINESS_ID, code: SYSTEM_ACCOUNT_CODES.CASH, name: 'Cash', type: 'asset', subtype: '', parent_id: null, opening_balance_paise: 0, is_system: 1, active: 1, created_at: '', updated_at: '', entity_version: 1 },
    { id: 'receivable-account', business_id: BUSINESS_ID, code: SYSTEM_ACCOUNT_CODES.RECEIVABLE, name: 'Accounts Receivable', type: 'asset', subtype: '', parent_id: null, opening_balance_paise: 0, is_system: 1, active: 1, created_at: '', updated_at: '', entity_version: 1 },
  ];
  await db.customers.add(customer);
  await db.accounts.bulkAdd(accounts);
  await db.invoices.bulkAdd([
    makeInvoice('invoice-a', 'INV-001', 10000),
    makeInvoice('invoice-b', 'INV-002', 5000),
  ]);
});

afterEach(cleanup);

describe('Payments In', () => {
  it('shows customer total due and posts one payment across selected invoices', async () => {
    render(<MemoryRouter><PaymentsPage /></MemoryRouter>);

    await waitFor(async () => expect(await db.accounts.count()).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Payment In' }));
    await screen.findByRole('option', { name: 'Ravi Stores' });
    fireEvent.change(screen.getByLabelText('Party'), { target: { value: 'customer-1' } });
    const customerDue = await screen.findByText(/Customer total due:/);
    expect(customerDue.textContent).toContain('₹175.00');

    fireEvent.click(screen.getByRole('button', { name: 'Select open invoices' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice INV-001' }));
    expect(screen.queryByRole('button', { name: 'Save payment' })).toBeNull();
    const invoicePicker = screen.getByRole('dialog', { name: 'Select invoices' });
    fireEvent.click(within(invoicePicker).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Select invoices' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Select open invoices' })).toBeTruthy();
    expect((screen.getByLabelText('Amount ₹') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Select open invoices' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice INV-001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice INV-002' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect((screen.getByLabelText('Amount ₹') as HTMLInputElement).value).toBe('150.00');
    expect(screen.getByRole('button', { name: '2 invoice(s) selected' })).toBeTruthy();
    expect(screen.getByText(/Selected invoices due:/).textContent).toContain('₹150.00');
    expect(screen.getByRole('button', { name: 'Save payment' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Cash / bank account'), { target: { value: 'cash-account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save payment' }));

    await screen.findByText(/PAY-IN-/);
    expect(await db.payments.count()).toBe(1);
    const payment = await db.payments.toCollection().first();
    expect(payment?.amount_paise).toBe(15000);
    expect(payment?.allocations).toHaveLength(2);
    expect(payment?.allocations.map((allocation) => allocation.invoice_id).sort()).toEqual(['invoice-a', 'invoice-b']);
    expect((await db.invoices.get('invoice-a'))?.balance_paise).toBe(0);
    expect((await db.invoices.get('invoice-b'))?.balance_paise).toBe(0);
  });
});
