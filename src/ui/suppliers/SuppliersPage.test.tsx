import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { db } from '../../db';
import type { Advance, Supplier } from '../../db/types';
import { streamCsvExport } from '../../csv/streamCsvExport';
import SuppliersPage from './SuppliersPage';

vi.mock('../hooks/useActiveBusiness', () => ({
  useActiveBusiness: () => ({ businessId: 'supplier-test', deviceId: 'device-test', loading: false }),
}));
vi.mock('../../csv/streamCsvExport', () => ({ streamCsvExport: vi.fn() }));

const supplier: Supplier = {
  id: 'supplier-1', business_id: 'supplier-test', name: 'Test Supplier',
  phone: '', email: '', gstin: null, address: '', state: '', state_code: '',
  opening_balance_paise: 100000, notes: '', active: 1,
  created_at: '', updated_at: '', entity_version: 1,
};
const advance: Advance = {
  id: 'advance-1', business_id: 'supplier-test', advance_number: 'ADV-1',
  advance_date: '2026-11-04', party_type: 'supplier', party_id: supplier.id,
  method: 'bank', account_id: 'bank-1', amount_paise: 30000, remaining_paise: 30000,
  reference: '', notes: '', applications: [], journal_entry_id: 'journal-1',
  created_at: '', updated_at: '', entity_version: 1,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all(db.tables.map((table) => table.clear()));
  await db.suppliers.add(supplier);
  await db.advances.add(advance);
});
afterEach(cleanup);

it('shows Payable minus Advance and updates live through zero to a supplier credit', async () => {
  render(<MemoryRouter initialEntries={['/suppliers']}><SuppliersPage /></MemoryRouter>);
  await screen.findByRole('button', { name: /Net Due/ });
  const name = await screen.findByText('Test Supplier');
  const row = name.closest('tr')!;
  await waitFor(() => expect(within(row).getAllByRole('cell')[7].textContent).toContain('₹700.00'));
  await db.advances.update(advance.id, { amount_paise: 100000, remaining_paise: 100000 });
  await waitFor(() => expect(within(row).getAllByRole('cell')[7].textContent).toContain('₹0.00'));
  await db.advances.update(advance.id, { amount_paise: 150000, remaining_paise: 150000 });
  await waitFor(() => expect(within(row).getAllByRole('cell')[7].textContent).toContain('-₹500.00'));
});

it('exports Payable, Advance and Net Due consistently with the supplier list', async () => {
  render(<MemoryRouter initialEntries={['/suppliers']}><SuppliersPage /></MemoryRouter>);
  const name = await screen.findByText('Test Supplier');
  await waitFor(() => expect(name.closest('tr')?.textContent).toContain('₹700.00'));
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await waitFor(() => expect(streamCsvExport).toHaveBeenCalledOnce());
  const exported = vi.mocked(streamCsvExport).mock.calls[0][0];
  const getValue = (header: string) => exported.columns.find((column) => column.header === header)!
    .get(supplier as never);
  expect(getValue('Payable')).toBe('1000.00');
  expect(getValue('Advance')).toBe('300.00');
  expect(getValue('Net Due')).toBe('700.00');
});

it('sorts Net Due numerically and includes negative opening credit', async () => {
  await db.suppliers.add({ ...supplier, id: 'supplier-2', name: 'Credit Supplier', opening_balance_paise: -50000 });
  render(<MemoryRouter initialEntries={['/suppliers']}><SuppliersPage /></MemoryRouter>);
  const creditName = await screen.findByText('Credit Supplier');
  await waitFor(() => expect(creditName.closest('tr')?.textContent).toContain('-₹500.00'));
  const sort = screen.getByRole('button', { name: 'Sort by Net Due' });
  fireEvent.click(sort);
  let dataRows = screen.getAllByRole('row').filter((row) => within(row).queryByText(/Test Supplier|Credit Supplier/));
  expect(dataRows[0].textContent).toContain('Credit Supplier');
  fireEvent.click(sort);
  dataRows = screen.getAllByRole('row').filter((row) => within(row).queryByText(/Test Supplier|Credit Supplier/));
  expect(dataRows[0].textContent).toContain('Test Supplier');
});
