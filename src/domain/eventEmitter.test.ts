import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BusinessVaultDB } from '../db/database';
import { __resetMetaDbForTests } from '../lib/device';
import { setCurrentBusinessId } from '../lib/business';
import { emit } from './eventEmitter';
import type { Invoice, Customer } from '../db/types';

function freshDb(): BusinessVaultDB {
  return new BusinessVaultDB('bv-emit-' + Math.random().toString(36).slice(2));
}

const BIZ = 'biz-01HXYZ';

function makeInvoice(id: string, version = 1): Invoice {
  return {
    id,
    business_id: BIZ,
    invoice_number: 'INV-0001',
    invoice_date: '2026-08-19',
    due_date: null,
    customer_id: 'cust-1',
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: 10000,
    discount_paise: 0,
    taxable_paise: 10000,
    cgst_paise: 900,
    sgst_paise: 900,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    round_off_mode: 'none',
    pre_round_total_paise: 11800,
    total_paise: 11800,
    paid_paise: 0,
    balance_paise: 11800,
    status: 'issued',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: 'je-1',
    created_at: '2026-08-19T00:00:00.000Z',
    updated_at: '2026-08-19T00:00:00.000Z',
    entity_version: version,
  };
}

function makeCustomer(id: string, version = 1): Customer {
  return {
    id,
    business_id: BIZ,
    name: 'Acme',
    phone: '',
    email: '',
    gstin: null,
    billing_address: '',
    shipping_address: '',
    state: '',
    state_code: '',
    opening_balance_paise: 0,
    credit_limit_paise: 0,
    notes: '',
    active: 1,
    created_at: '2026-08-19T00:00:00.000Z',
    updated_at: '2026-08-19T00:00:00.000Z',
    entity_version: version,
  };
}

describe('emit', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetMetaDbForTests();
    await setCurrentBusinessId(BIZ);
  });

  it('first event for a new entity gets entityVersion=1', async () => {
    const db = freshDb();
    const evt = await emit('invoice', 'created', 'inv-1', makeInvoice('inv-1'), {
      db,
    });
    expect(evt.entityVersion).toBe(1);
    expect(evt.entityType).toBe('invoice');
    expect(evt.operation).toBe('created');
    expect(evt.entityId).toBe('inv-1');
    expect(evt.businessId).toBe(BIZ);
    expect(evt.deviceId).toBeTruthy();
  });

  it('increments entityVersion across subsequent events for the same (entityType, entityId)', async () => {
    const db = freshDb();
    const first = await emit(
      'invoice',
      'created',
      'inv-1',
      makeInvoice('inv-1'),
      { db },
    );
    const second = await emit(
      'invoice',
      'updated',
      'inv-1',
      { id: 'inv-1', notes: 'edit' },
      { db },
    );
    const third = await emit(
      'invoice',
      'reversed',
      'inv-1',
      {
        invoice_id: 'inv-1',
        voided_at: '2026-08-19T00:00:02.000Z',
        reason: 'user requested',
        credit_note_invoice_id: null,
      },
      { db },
    );
    expect(first.entityVersion).toBe(1);
    expect(second.entityVersion).toBe(2);
    expect(third.entityVersion).toBe(3);
  });

  it('scopes entityVersion per entityId, not globally', async () => {
    const db = freshDb();
    const a1 = await emit('invoice', 'created', 'inv-A', makeInvoice('inv-A'), {
      db,
    });
    const b1 = await emit('invoice', 'created', 'inv-B', makeInvoice('inv-B'), {
      db,
    });
    const a2 = await emit(
      'invoice',
      'updated',
      'inv-A',
      { id: 'inv-A', notes: 'x' },
      { db },
    );
    expect(a1.entityVersion).toBe(1);
    expect(b1.entityVersion).toBe(1);
    expect(a2.entityVersion).toBe(2);
  });

  it('scopes entityVersion per entityType', async () => {
    const db = freshDb();
    const inv = await emit('invoice', 'created', 'x-1', makeInvoice('x-1'), {
      db,
    });
    const cust = await emit(
      'customer',
      'created',
      'x-1',
      makeCustomer('x-1'),
      { db },
    );
    expect(inv.entityVersion).toBe(1);
    expect(cust.entityVersion).toBe(1);
  });

  it('short-circuits when idempotencyKey is reused, returning the original event', async () => {
    const db = freshDb();
    const key = 'invoice-create-01HXYZ';
    const first = await emit(
      'invoice',
      'created',
      'inv-1',
      makeInvoice('inv-1'),
      { idempotencyKey: key, db },
    );
    const second = await emit(
      'invoice',
      'created',
      'inv-1',
      makeInvoice('inv-1'),
      { idempotencyKey: key, db },
    );
    expect(second.eventId).toBe(first.eventId);
    expect(second.entityVersion).toBe(1);
    const count = await db.sync_events.where('business_id').equals(BIZ).count();
    expect(count).toBe(1);
  });

  it('idempotent short-circuit does not consume the next entityVersion', async () => {
    const db = freshDb();
    const key = 'k-1';
    const first = await emit(
      'invoice',
      'created',
      'inv-1',
      makeInvoice('inv-1'),
      { idempotencyKey: key, db },
    );
    await emit('invoice', 'created', 'inv-1', makeInvoice('inv-1'), {
      idempotencyKey: key,
      db,
    });
    const next = await emit(
      'invoice',
      'updated',
      'inv-1',
      { id: 'inv-1', notes: 'follow-up' },
      { db },
    );
    expect(first.entityVersion).toBe(1);
    expect(next.entityVersion).toBe(2);
  });
});
