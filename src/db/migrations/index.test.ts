import { describe, expect, it } from 'vitest';
import { migrateSnapshot } from './index';

describe('purchase lifecycle migration', () => {
  it('links an unambiguous historical edit reversal', () => {
    const result = migrateSnapshot(
      {
        purchases: [
          {
            id: 'old',
            bill_number: 'BILL-1-REV-ABC123',
            status: 'cancelled',
            journal_entry_id: 'je-old',
            updated_at: '2026-08-19T10:00:00.000Z',
          },
          {
            id: 'new',
            bill_number: 'BILL-1',
            status: 'received',
          },
        ],
        journal_entries: [
          { id: 'je-old', reversed_by_id: null },
          { id: 'je-reversal', reverses_id: 'je-old' },
        ],
      },
      8,
      9,
    );

    expect(result.tables.purchases).toEqual([
      expect.objectContaining({
        id: 'old',
        replaced_by_purchase_id: 'new',
        reversal_journal_entry_id: 'je-reversal',
        cancel_reason: 'historical edit reversal',
      }),
      expect.objectContaining({ id: 'new', replaces_purchase_id: 'old' }),
    ]);
    expect(result.tables.journal_entries).toContainEqual(
      expect.objectContaining({ id: 'je-old', reversed_by_id: 'je-reversal' }),
    );
  });

  it('does not guess when multiple live replacements share a bill number', () => {
    const result = migrateSnapshot(
      {
        purchases: [
          { id: 'old', bill_number: 'BILL-1-REV-ABC123', status: 'cancelled', journal_entry_id: 'je-old' },
          { id: 'new-1', bill_number: 'BILL-1', status: 'received' },
          { id: 'new-2', bill_number: 'BILL-1', status: 'received' },
        ],
        journal_entries: [
          { id: 'je-old' },
          { id: 'je-reversal', reverses_id: 'je-old' },
        ],
      },
      8,
      9,
    );

    expect(result.tables.purchases[0]).toEqual(
      expect.objectContaining({ replaced_by_purchase_id: null, reversal_journal_entry_id: null }),
    );
  });
});

describe('compliance schema migrations', () => {
  it('chains v9 through v10 and v11 without overwriting values', () => {
    const result = migrateSnapshot(
      {
        payments: [{ id: 'p1' }],
        invoices: [{ id: 'i1', e_invoice_status: 'local_unverified', e_invoice_note: 'reviewed' }],
      },
      9,
      11,
    );

    expect(result.appliedSteps.map((step) => `${step.from}->${step.to}`)).toEqual(['9->10', '10->11']);
    expect(result.tables.payments[0]).toEqual({ id: 'p1', idempotency_key: null });
    expect(result.tables.invoices[0]).toEqual(
      expect.objectContaining({
        e_invoice_status: 'local_unverified',
        e_invoice_note: 'reviewed',
        e_invoice_irn: null,
      }),
    );
  });

  it('is idempotent for already-normalized compliance rows', () => {
    const tables = {
      payments: [{ id: 'p1', idempotency_key: 'retry-1' }],
      invoices: [{
        id: 'i1',
        e_invoice_status: 'not_recorded',
        e_invoice_irn: null,
        e_invoice_ack_number: null,
        e_invoice_ack_date: null,
        e_invoice_qr_reference: null,
        e_invoice_note: null,
      }],
    };
    const first = migrateSnapshot(tables, 9, 11).tables;
    const second = migrateSnapshot(first, 9, 11).tables;
    expect(second).toEqual(first);
  });
});

describe('customer-specific item price migration', () => {
  it('adds the customer_item_prices table when restoring a v11 snapshot', () => {
    const result = migrateSnapshot(
      { items: [{ id: 'item-1', sale_price_paise: 12500 }] },
      11,
      12,
    );

    expect(result.appliedSteps.map((step) => `${step.from}->${step.to}`)).toEqual(['11->12']);
    expect(result.tables.customer_item_prices).toEqual([]);
    expect(result.tables.items).toEqual([{ id: 'item-1', sale_price_paise: 12500 }]);
  });

  it('preserves existing customer-specific prices and is idempotent', () => {
    const tables = {
      customer_item_prices: [
        {
          id: 'business-1:customer-1:item-1',
          business_id: 'business-1',
          customer_id: 'customer-1',
          item_id: 'item-1',
          unit_price_paise: 9900,
        },
      ],
    };

    const first = migrateSnapshot(tables, 11, 12).tables;
    const second = migrateSnapshot(first, 11, 12).tables;

    expect(first).toEqual(tables);
    expect(second).toEqual(first);
  });
});
