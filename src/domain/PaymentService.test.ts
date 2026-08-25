import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BusinessVaultDB } from '../db/database';
import type { Invoice, Purchase, Account } from '../db/types';
import { PaymentService, PaymentValidationError } from './PaymentService';

const BIZ = 'biz-01HXYZ';
const DEV = 'dev-01HXYZ';

function freshDb(): BusinessVaultDB {
  return new BusinessVaultDB(
    'bv-payments-' + Math.random().toString(36).slice(2),
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
    created_at: '2026-08-19T00:00:00.000Z',
    updated_at: '2026-08-19T00:00:00.000Z',
    entity_version: 1,
  };
}

function makeInvoice(id: string, total: number, paid = 0): Invoice {
  return {
    id,
    business_id: BIZ,
    invoice_number: 'INV-' + id,
    invoice_date: '2026-08-19',
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
    total_paise: total,
    paid_paise: paid,
    balance_paise: total - paid,
    status: paid > 0 ? 'partial' : 'issued',
    reversed_by_invoice_id: null,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: 'je-inv-' + id,
    created_at: '2026-08-19T00:00:00.000Z',
    updated_at: '2026-08-19T00:00:00.000Z',
    entity_version: 1,
  };
}

function makeBill(id: string, total: number, paid = 0): Purchase {
  return {
    id,
    business_id: BIZ,
    bill_number: 'BILL-' + id,
    supplier_bill_number: 'SUP-' + id,
    bill_date: '2026-08-19',
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
    total_paise: total,
    paid_paise: paid,
    balance_paise: total - paid,
    status: paid > 0 ? 'partial' : 'received',
    reversed_by_purchase_id: null,
    reverses_purchase_id: null,
    notes: '',
    attachment_id: null,
    journal_entry_id: 'je-bill-' + id,
    created_at: '2026-08-19T00:00:00.000Z',
    updated_at: '2026-08-19T00:00:00.000Z',
    entity_version: 1,
  };
}

async function seed(db: BusinessVaultDB): Promise<void> {
  await db.accounts.bulkAdd([
    makeAccount('acc-cash', '1100', 'asset'),
    makeAccount('acc-ar', '1200', 'asset'),
    makeAccount('acc-ap', '2100', 'liability'),
    makeAccount('acc-cust-adv', '2050', 'liability'),
    makeAccount('acc-sup-adv', '1250', 'asset'),
  ]);
}

describe('PaymentService.createPayment', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('creates a payment, allocates to invoice, updates balance, posts balanced journal', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-1', 100000));

    const svc = new PaymentService(db);
    const payment = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-001',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 60000,
      allocations: [{ invoice_id: 'inv-1', amount_paise: 60000 }],
    });

    expect(payment.amount_paise).toBe(60000);
    expect(payment.allocations).toHaveLength(1);

    const inv = await db.invoices.get('inv-1');
    expect(inv?.paid_paise).toBe(60000);
    expect(inv?.balance_paise).toBe(40000);
    expect(inv?.status).toBe('partial');

    const lines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, payment.journal_entry_id])
      .toArray();
    const sumD = lines.reduce((s, l) => s + l.debit_paise, 0);
    const sumC = lines.reduce((s, l) => s + l.credit_paise, 0);
    expect(sumD).toBe(sumC);
    expect(sumD).toBe(60000);

    const events = await db.sync_events
      .where('business_id')
      .equals(BIZ)
      .toArray();
    const ops = events.map((e) => e.operation);
    expect(ops).toContain('created');
    expect(ops).toContain('allocated');
  });

  it('marks invoice paid when full amount allocated', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-2', 50000));
    const svc = new PaymentService(db);

    await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-002',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 50000,
      allocations: [{ invoice_id: 'inv-2', amount_paise: 50000 }],
    });

    const inv = await db.invoices.get('inv-2');
    expect(inv?.balance_paise).toBe(0);
    expect(inv?.status).toBe('paid');
  });

  it('refuses over-allocation vs payment amount', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-3', 100000));
    await db.invoices.add(makeInvoice('inv-4', 100000));
    const svc = new PaymentService(db);

    await expect(
      svc.createPayment({
        business_id: BIZ,
        device_id: DEV,
        payment_number: 'PAY-003',
        payment_date: '2026-08-19',
        direction: 'in',
        party_type: 'customer',
        party_id: 'cust-1',
        method: 'cash',
        cash_or_bank_account_id: 'acc-cash',
        ar_or_ap_account_id: 'acc-ar',
        amount_paise: 50000,
        allocations: [
          { invoice_id: 'inv-3', amount_paise: 40000 },
          { invoice_id: 'inv-4', amount_paise: 20000 },
        ],
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);

    const inv3 = await db.invoices.get('inv-3');
    const inv4 = await db.invoices.get('inv-4');
    expect(inv3?.balance_paise).toBe(100000);
    expect(inv4?.balance_paise).toBe(100000);

    const pays = await db.payments.count();
    expect(pays).toBe(0);
  });

  it('refuses under-allocation (SUM(allocations) < amount_paise) — regression', async () => {
    // Regression for silent over-payment: previously a payment could be posted
    // where SUM(allocations) was strictly less than amount_paise. The full
    // amount_paise was still debited against AR (creating a customer over-payment
    // with no advance-account credit). We now reject explicitly.
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-under-1', 50000));
    const svc = new PaymentService(db);

    await expect(
      svc.createPayment({
        business_id: BIZ,
        device_id: DEV,
        payment_number: 'PAY-UNDER',
        payment_date: '2026-08-19',
        direction: 'in',
        party_type: 'customer',
        party_id: 'cust-1',
        method: 'cash',
        cash_or_bank_account_id: 'acc-cash',
        ar_or_ap_account_id: 'acc-ar',
        amount_paise: 60000,
        allocations: [{ invoice_id: 'inv-under-1', amount_paise: 50000 }],
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);

    // Nothing must have been posted.
    expect(await db.payments.count()).toBe(0);
    const inv = await db.invoices.get('inv-under-1');
    expect(inv?.balance_paise).toBe(50000);
  });

  it('refuses allocation exceeding invoice balance', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-5', 30000, 20000));
    const svc = new PaymentService(db);

    await expect(
      svc.createPayment({
        business_id: BIZ,
        device_id: DEV,
        payment_number: 'PAY-004',
        payment_date: '2026-08-19',
        direction: 'in',
        party_type: 'customer',
        party_id: 'cust-1',
        method: 'cash',
        cash_or_bank_account_id: 'acc-cash',
        ar_or_ap_account_id: 'acc-ar',
        amount_paise: 20000,
        allocations: [{ invoice_id: 'inv-5', amount_paise: 15000 }],
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('supports outbound payment against a purchase bill', async () => {
    const db = freshDb();
    await seed(db);
    await db.purchases.add(makeBill('bill-1', 80000));
    const svc = new PaymentService(db);

    await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-OUT-1',
      payment_date: '2026-08-19',
      direction: 'out',
      party_type: 'supplier',
      party_id: 'sup-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ap',
      amount_paise: 80000,
      allocations: [{ bill_id: 'bill-1', amount_paise: 80000 }],
    });

    const bill = await db.purchases.get('bill-1');
    expect(bill?.balance_paise).toBe(0);
    expect(bill?.status).toBe('paid');
  });

  it('captures excess into a customer advance (payablesRec §13/§14) — invoice fully paid, remainder held on account', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-adv-1', 100000));
    const svc = new PaymentService(db);

    const payment = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-ADV-1',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 150000,
      advance_number: 'ADV-1',
      allocations: [
        { invoice_id: 'inv-adv-1', amount_paise: 100000 },
        { as_advance: true, amount_paise: 50000 },
      ],
    });

    const inv = await db.invoices.get('inv-adv-1');
    expect(inv?.balance_paise).toBe(0);
    expect(inv?.status).toBe('paid');

    const advs = await db.advances
      .where('[business_id+party_type+party_id]')
      .equals([BIZ, 'customer', 'cust-1'])
      .toArray();
    expect(advs.length).toBe(1);
    expect(advs[0].amount_paise).toBe(50000);
    expect(advs[0].remaining_paise).toBe(50000);
    expect(advs[0].journal_entry_id).toBe(payment.journal_entry_id);

    const advSlice = payment.allocations.find((a) => a.advance_id);
    expect(advSlice?.advance_id).toBe(advs[0].id);

    const lines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, payment.journal_entry_id])
      .toArray();
    const sumD = lines.reduce((s, l) => s + l.debit_paise, 0);
    const sumC = lines.reduce((s, l) => s + l.credit_paise, 0);
    expect(sumD).toBe(sumC);
    expect(sumD).toBe(150000);
    const advLine = lines.find((l) => l.account_id === 'acc-cust-adv');
    expect(advLine?.credit_paise).toBe(50000);
    const arLine = lines.find((l) => l.account_id === 'acc-ar');
    expect(arLine?.credit_paise).toBe(100000);

    const events = await db.sync_events
      .where('business_id')
      .equals(BIZ)
      .toArray();
    const advEvt = events.find(
      (e) => e.entity_type === 'advance' && e.operation === 'created',
    );
    expect(advEvt).toBeTruthy();
  });

  it('pure on-account customer receipt (no invoice slice) materializes an advance', async () => {
    const db = freshDb();
    await seed(db);
    const svc = new PaymentService(db);

    const payment = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-ADV-PURE',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 40000,
      advance_number: 'ADV-PURE',
      allocations: [{ as_advance: true, amount_paise: 40000 }],
    });

    const advs = await db.advances
      .where('[business_id+party_type+party_id]')
      .equals([BIZ, 'customer', 'cust-1'])
      .toArray();
    expect(advs.length).toBe(1);
    expect(advs[0].remaining_paise).toBe(40000);

    const lines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, payment.journal_entry_id])
      .toArray();
    // Dr Cash 40000, Cr CustomerAdvance 40000 — no AR line.
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.account_id === 'acc-ar')).toBe(false);
    const advLine = lines.find((l) => l.account_id === 'acc-cust-adv');
    expect(advLine?.credit_paise).toBe(40000);
  });

  it('captures excess into a supplier advance on outbound over-pay', async () => {
    const db = freshDb();
    await seed(db);
    await db.purchases.add(makeBill('bill-adv-1', 30000));
    const svc = new PaymentService(db);

    const payment = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-ADV-OUT',
      payment_date: '2026-08-19',
      direction: 'out',
      party_type: 'supplier',
      party_id: 'sup-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ap',
      amount_paise: 50000,
      advance_number: 'ADV-SUP-1',
      allocations: [
        { bill_id: 'bill-adv-1', amount_paise: 30000 },
        { as_advance: true, amount_paise: 20000 },
      ],
    });

    const bill = await db.purchases.get('bill-adv-1');
    expect(bill?.balance_paise).toBe(0);

    const advs = await db.advances
      .where('[business_id+party_type+party_id]')
      .equals([BIZ, 'supplier', 'sup-1'])
      .toArray();
    expect(advs.length).toBe(1);
    expect(advs[0].remaining_paise).toBe(20000);
    expect(advs[0].party_type).toBe('supplier');

    const lines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, payment.journal_entry_id])
      .toArray();
    // Dr AP 30000 + Dr SupplierAdvance 20000 + Cr Cash 50000
    const sumD = lines.reduce((s, l) => s + l.debit_paise, 0);
    expect(sumD).toBe(50000);
    const advLine = lines.find((l) => l.account_id === 'acc-sup-adv');
    expect(advLine?.debit_paise).toBe(20000);
  });

  it('requires advance_number when any allocation is as_advance', async () => {
    const db = freshDb();
    await seed(db);
    const svc = new PaymentService(db);

    await expect(
      svc.createPayment({
        business_id: BIZ,
        device_id: DEV,
        payment_number: 'PAY-NO-NUM',
        payment_date: '2026-08-19',
        direction: 'in',
        party_type: 'customer',
        party_id: 'cust-1',
        method: 'cash',
        cash_or_bank_account_id: 'acc-cash',
        ar_or_ap_account_id: 'acc-ar',
        amount_paise: 10000,
        allocations: [{ as_advance: true, amount_paise: 10000 }],
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });
});

describe('PaymentService.refundPayment', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('reverses a payment: restores invoice balance, posts reversing journal, keeps original', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-9', 100000));
    const svc = new PaymentService(db);

    const original = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-9',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 60000,
      allocations: [{ invoice_id: 'inv-9', amount_paise: 60000 }],
    });

    const invAfter = await db.invoices.get('inv-9');
    expect(invAfter?.balance_paise).toBe(40000);

    const refund = await svc.refundPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_id: original.id,
      refund_payment_number: 'PAY-9R',
      refund_date: '2026-08-20',
      reason: 'customer disputed',
    });

    expect(refund.amount_paise).toBe(-60000);
    expect(refund.direction).toBe('out');

    const invReset = await db.invoices.get('inv-9');
    expect(invReset?.paid_paise).toBe(0);
    expect(invReset?.balance_paise).toBe(100000);

    const revLines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, refund.journal_entry_id])
      .toArray();
    const sumD = revLines.reduce((s, l) => s + l.debit_paise, 0);
    const sumC = revLines.reduce((s, l) => s + l.credit_paise, 0);
    expect(sumD).toBe(sumC);
    expect(sumD).toBe(60000);

    const origLines = await db.journal_lines
      .where('[business_id+entry_id]')
      .equals([BIZ, original.journal_entry_id])
      .toArray();
    expect(origLines.length).toBe(2);

    const origEntry = await db.journal_entries.get(original.journal_entry_id);
    expect(origEntry?.reversed_by_id).toBe(refund.journal_entry_id);

    const events = await db.sync_events
      .where('business_id')
      .equals(BIZ)
      .toArray();
    const reversedEvts = events.filter(
      (e) => e.entity_id === original.id && e.operation === 'reversed',
    );
    expect(reversedEvts.length).toBe(1);
  });

  it('refuses to refund a payment carrying an as_advance slice', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-adv-r', 50000));
    const svc = new PaymentService(db);

    const p = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-ADV-R',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'bank',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 60000,
      advance_number: 'ADV-R',
      allocations: [
        { invoice_id: 'inv-adv-r', amount_paise: 50000 },
        { as_advance: true, amount_paise: 10000 },
      ],
    });

    await expect(
      svc.refundPayment({
        business_id: BIZ,
        device_id: DEV,
        payment_id: p.id,
        refund_payment_number: 'PAY-ADV-R-REV',
        refund_date: '2026-08-20',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('refuses to refund a refund (negative amount)', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-10', 100000));
    const svc = new PaymentService(db);

    const p = await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PAY-10',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 10000,
      allocations: [{ invoice_id: 'inv-10', amount_paise: 10000 }],
    });

    const refund = await svc.refundPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_id: p.id,
      refund_payment_number: 'PAY-10R',
      refund_date: '2026-08-20',
      reason: 'x',
    });

    await expect(
      svc.refundPayment({
        business_id: BIZ,
        device_id: DEV,
        payment_id: refund.id,
        refund_payment_number: 'PAY-10RR',
        refund_date: '2026-08-21',
        reason: 'no',
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });
});

describe('PaymentService lookup', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('listPaymentsForInvoice returns only payments touching that invoice', async () => {
    const db = freshDb();
    await seed(db);
    await db.invoices.add(makeInvoice('inv-A', 100000));
    await db.invoices.add(makeInvoice('inv-B', 100000));
    const svc = new PaymentService(db);

    await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PA',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 20000,
      allocations: [{ invoice_id: 'inv-A', amount_paise: 20000 }],
    });
    await svc.createPayment({
      business_id: BIZ,
      device_id: DEV,
      payment_number: 'PB',
      payment_date: '2026-08-19',
      direction: 'in',
      party_type: 'customer',
      party_id: 'cust-1',
      method: 'cash',
      cash_or_bank_account_id: 'acc-cash',
      ar_or_ap_account_id: 'acc-ar',
      amount_paise: 30000,
      allocations: [{ invoice_id: 'inv-B', amount_paise: 30000 }],
    });

    const forA = await svc.listPaymentsForInvoice(BIZ, 'inv-A');
    expect(forA.length).toBe(1);
    expect(forA[0].payment_number).toBe('PA');

    const forCust = await svc.listCustomerPayments(BIZ, 'cust-1');
    expect(forCust.length).toBe(2);
  });
});
