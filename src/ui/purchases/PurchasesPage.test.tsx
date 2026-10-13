import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { db } from '../../db';
import { createPurchaseService } from '../../domain/PurchaseService';
import PurchasesPage from './PurchasesPage';
import PurchaseDetail from './PurchaseDetail';

vi.mock('../hooks/useActiveBusiness', () => ({ useActiveBusiness: () => ({ businessId: 'biz-edit', deviceId: 'dev-edit', loading: false, error: null }) }));

const BIZ = 'biz-edit';
const ACCOUNT_CODES = ['5010', '1310', '1320', '1330', '1340', '2010'];

function RouteLocation() { return <output aria-label="Current route">{useLocation().pathname}</output>; }

async function seedBill(qtyMicros = 5_000_000) {
  await db.table('businesses').put({ id: BIZ, name: 'Edit business', state_code: '29', current_financial_year: '2026-27' });
  await db.table('suppliers').put({ id: 'sup-1', business_id: BIZ, name: 'Acme Supplies', state_code: '29' });
  await db.table('items').put({ id: 'item-1', business_id: BIZ, sku: 'SKU1', name: 'Widget', hsn: '8471', unit_id: 'u', is_service: 0, purchase_price_paise: 1000, tax_rate_bps: 1800 });
  await db.table('warehouses').put({ id: 'wh-2', business_id: BIZ, name: 'Back store', is_default: 0 });
  await db.table('warehouses').put({ id: 'wh-1', business_id: BIZ, name: 'Main', is_default: 1 });
  for (const code of ACCOUNT_CODES) await db.table('accounts').put({ id: `acc-${code}`, business_id: BIZ, code, name: code });
  return createPurchaseService({ db }).create({
    businessId: BIZ, deviceId: 'dev-edit', billNumber: 'PB-EDIT-1', billDate: '2026-10-01', supplierId: 'sup-1',
    supplierStateCode: '29', isInterstate: false, financialYear: '2026-27',
    accounts: { purchases: 'acc-5010', inputCgst: 'acc-1310', inputSgst: 'acc-1320', inputIgst: 'acc-1330', inputCess: 'acc-1340', accountsPayable: 'acc-2010' },
    // Non-default warehouse: the edit must keep stock where it was received.
    lines: [{ itemId: 'item-1', description: 'Widget', hsn: '8471', warehouseId: 'wh-2', qtyMicros, unitCostPaise: 1000, taxRateBps: 1800 }],
  });
}

function renderAt(path: string) {
  render(<MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/purchases" element={<PurchasesPage />} />
      <Route path="/purchases/:id" element={<PurchaseDetail />} />
      <Route path="/purchases/:id/edit" element={<PurchasesPage />} />
    </Routes>
    <RouteLocation />
  </MemoryRouter>);
}

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()));
});
afterEach(cleanup);

describe('purchase bill edit', () => {
  it('opens the bill prefilled, saves the correction and lands on the corrected bill', async () => {
    const original = await seedBill();
    renderAt(`/purchases/${original.id}/edit`);

    await screen.findByText('Edit Purchase — PB-EDIT-1');
    const qty = await screen.findByDisplayValue('5');
    expect(screen.getByDisplayValue('10.00')).toBeTruthy();
    fireEvent.change(qty, { target: { value: '4' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save Purchase' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save Purchase' }));

    await waitFor(() => expect(screen.getByLabelText('Current route').textContent).not.toContain('/edit'));
    const old = await db.purchases.get(original.id);
    expect(old?.status).toBe('cancelled');
    const corrected = await db.purchases.get(old!.replaced_by_purchase_id!);
    expect(corrected).toMatchObject({ bill_number: 'PB-EDIT-1', taxable_paise: 4000 });
    expect(screen.getByLabelText('Current route').textContent).toBe(`/purchases/${corrected!.id}`);
    expect((await db.item_stock.get(`${BIZ}:item-1:wh-2`))?.qty_micros).toBe(4_000_000);
    expect(await db.item_stock.get(`${BIZ}:item-1:wh-1`)).toBeUndefined();
  });

  it('shows why a paid bill cannot be edited', async () => {
    const original = await seedBill();
    await db.purchases.update(original.id, { paid_paise: 100 });
    renderAt(`/purchases/${original.id}`);

    const button = await screen.findByRole('button', { name: 'Edit bill' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/has payments applied/)).toBeTruthy();
  });

  it('opens the edit page from the detail page', async () => {
    const original = await seedBill();
    renderAt(`/purchases/${original.id}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit bill' }));
    await screen.findByText('Edit Purchase — PB-EDIT-1');
    expect(screen.getByLabelText('Current route').textContent).toBe(`/purchases/${original.id}/edit`);
  });
});
