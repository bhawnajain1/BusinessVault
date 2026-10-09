import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BusinessVaultDB } from '../db/database';
import { PurchaseService } from './PurchaseService';
import { computePayables } from './partyLedger';

const BIZ = 'biz-purch';
const DEV = 'dev-purch';

function freshDb(): BusinessVaultDB {
  return new BusinessVaultDB('bv-purch-' + Math.random().toString(36).slice(2));
}

const ACCOUNTS = {
  purchases: 'acc-purchases',
  inputCgst: 'acc-input-cgst',
  inputSgst: 'acc-input-sgst',
  inputIgst: 'acc-input-igst',
  inputCess: 'acc-input-cess',
  accountsPayable: 'acc-ap',
};

describe('PurchaseService', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('creates purchase, stock movement, and balanced journal entry', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db });
    const p = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-1',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [
        {
          itemId: 'item-1',
          warehouseId: 'wh-1',
          qtyMicros: 10_000_000, // 10 units
          unitCostPaise: 10000, // 100.00 per unit
          taxRateBps: 1800,
        },
      ],
    });
    // Line gross = 10 * 10000 = 100000; tax @18% = 18000, split 9000/9000
    expect(p.taxable_paise).toBe(100000);
    expect(p.cgst_paise).toBe(9000);
    expect(p.sgst_paise).toBe(9000);
    expect(p.igst_paise).toBe(0);
    expect(p.total_paise).toBe(118000);
    expect(p.balance_paise).toBe(118000);

    // Journal balanced
    const je = await db.journal_entries.get(p.journal_entry_id);
    expect(je).toBeDefined();
    expect(je!.total_debit_paise).toBe(je!.total_credit_paise);
    expect(je!.total_debit_paise).toBe(118000);

    // Stock movement present
    const movs = await db.stock_movements.toArray();
    expect(movs.length).toBe(1);
    expect(movs[0].qty_micros).toBe(10_000_000);
    expect(movs[0].movement_type).toBe('purchase');

    // item_stock cache updated
    const stock = await db.item_stock.get(`${BIZ}:item-1:wh-1`);
    expect(stock).toBeDefined();
    expect(stock!.qty_micros).toBe(10_000_000);

    // Events: purchase.created, purchase_line.created, stock_movement.movement,
    // journal_entry.posted, journal_line.created (one per JE line — 4 for
    // intrastate: Dr Purchases + Dr CGST + Dr SGST + Cr AP).
    const events = (await db.sync_events.toArray()) as unknown as Array<
      Record<string, unknown>
    >;
    const kinds = events.map((e) => `${e['entity_type']}.${e['operation']}`).sort();
    expect(kinds).toEqual(
      [
        'journal_entry.posted',
        'journal_line.created',
        'journal_line.created',
        'journal_line.created',
        'journal_line.created',
        'purchase.created',
        'purchase_line.created',
        'stock_movement.movement',
      ].sort(),
    );
    expect(p.due_date).toBe('2026-09-03');
  });

  it('keeps an explicitly supplied due date instead of applying the default', async () => {
    const db = freshDb();
    const p = await new PurchaseService({ db }).create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-DUE-DATE',
      billDate: '2026-08-19',
      dueDate: '2026-08-25',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [
        {
          itemId: 'item-1',
          warehouseId: 'wh-1',
          qtyMicros: 1_000_000,
          unitCostPaise: 10000,
          taxRateBps: 0,
        },
      ],
    });
    expect(p.due_date).toBe('2026-08-25');
  });

  it('uses banker\'s rounding on the half-split of odd tax amounts (regression)', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db });
    // Pick a taxable that generates an odd totalTax after bpsMul so half-split
    // must resolve a .5 case. taxable=1000, rate=1800 bps => tax=180 (even). Use
    // taxable=999, rate=1800 => 179.82 => 180 either rounding. We need a case
    // where the half-split is exactly *.5 to distinguish banker's from Math.round.
    //
    // Simpler: force totalTax=5 (odd) — half=2.5. bankersRound(2.5)=2 (round to
    // even). Math.round(2.5)=3. taxable=278 @ rate=1800bps => tax = 278*0.18 =
    // 50.04 => bankersRound=50; half=25 (exact). Not useful.
    //
    // Set taxRateBps directly using an unusual base:
    // taxable=250, rate=200bps => tax = 5. half = 2.5.
    const p = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-BANKERS',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [
        {
          itemId: 'item-1',
          warehouseId: 'wh-1',
          qtyMicros: 1_000_000, // 1 unit
          unitCostPaise: 250, // gross=250
          taxRateBps: 200, // 2% => tax=5
        },
      ],
    });
    // With banker's rounding, bankersRound(2.5)=2, so CGST=2, SGST=3 (5-2).
    // With Math.round (previous behavior), CGST=3, SGST=2.
    expect(p.cgst_paise + p.sgst_paise).toBe(5);
    expect(p.cgst_paise).toBe(2);
    expect(p.sgst_paise).toBe(3);
  });

  it('retries with same idempotencyKey return the same purchase (regression)', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db });
    const first = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-IDEMP',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      idempotencyKey: 'key-p1',
      lines: [
        {
          itemId: 'item-1',
          warehouseId: 'wh-1',
          qtyMicros: 1_000_000,
          unitCostPaise: 5000,
          taxRateBps: 0,
        },
      ],
    });
    // Retry with the same key but a DIFFERENT billNumber — should return the
    // original purchase without throwing "Bill number already exists" and
    // without inserting a second row / doubling stock.
    const second = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-IDEMP-RETRY',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      idempotencyKey: 'key-p1',
      lines: [
        {
          itemId: 'item-1',
          warehouseId: 'wh-1',
          qtyMicros: 1_000_000,
          unitCostPaise: 5000,
          taxRateBps: 0,
        },
      ],
    });
    expect(second.id).toBe(first.id);
    expect((await db.purchases.toArray()).length).toBe(1);
    // Stock should not be doubled.
    const stock = await db.item_stock.get(`${BIZ}:item-1:wh-1`);
    expect(stock!.qty_micros).toBe(1_000_000);
  });

  it('rejects duplicate bill number and rolls back all writes', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db });
    await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-DUP',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [
        {
          itemId: 'item-1',
          warehouseId: 'wh-1',
          qtyMicros: 1_000_000,
          unitCostPaise: 5000,
          taxRateBps: 0,
        },
      ],
    });
    await expect(
      svc.create({
        businessId: BIZ,
        deviceId: DEV,
        billNumber: 'BILL-DUP',
        billDate: '2026-08-19',
        supplierId: 'sup-1',
        supplierStateCode: '29',
        isInterstate: false,
        financialYear: '2026-27',
        accounts: ACCOUNTS,
        lines: [
          {
            itemId: 'item-1',
            warehouseId: 'wh-1',
            qtyMicros: 1_000_000,
            unitCostPaise: 5000,
            taxRateBps: 0,
          },
        ],
      }),
    ).rejects.toThrow(/Bill number already exists/);
    const purchases = await db.purchases.toArray();
    expect(purchases.length).toBe(1);
    // stock should equal first purchase's qty only (1_000_000), not doubled
    const stock = await db.item_stock.get(`${BIZ}:item-1:wh-1`);
    expect(stock!.qty_micros).toBe(1_000_000);
  });

  it('reverses and reissues an edited bill without duplicating stock or payables', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db, now: () => '2026-08-19T10:00:00.000Z' });
    const input = {
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-EDIT',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [{
        itemId: 'item-1',
        warehouseId: 'wh-1',
        qtyMicros: 10_000_000,
        unitCostPaise: 5000,
        taxRateBps: 0,
      }],
    };
    const original = await svc.create(input);
    const replacement = await svc.update(original.id, {
      ...input,
      lines: [{ ...input.lines[0], qtyMicros: 6_000_000 }],
    });

    const old = await db.purchases.get(original.id);
    expect(old?.status).toBe('cancelled');
    expect(old?.bill_number).toMatch(/^BILL-EDIT-REV-/);
    expect(old?.replaced_by_purchase_id).toBe(replacement.id);
    expect(old?.reversal_journal_entry_id).toBeTruthy();
    expect(replacement.replaces_purchase_id).toBe(original.id);
    expect(replacement.bill_number).toBe('BILL-EDIT');

    const reversal = await db.journal_entries.get(old!.reversal_journal_entry_id!);
    const originalJournal = await db.journal_entries.get(original.journal_entry_id);
    expect(reversal?.reverses_id).toBe(original.journal_entry_id);
    expect(originalJournal?.reversed_by_id).toBe(reversal?.id);

    const stock = await db.item_stock.get(`${BIZ}:item-1:wh-1`);
    expect(stock?.qty_micros).toBe(6_000_000);
    expect((await db.purchases.where('business_id').equals(BIZ).toArray()).filter(
      (p) => p.status !== 'cancelled' && !p.reverses_purchase_id,
    )).toHaveLength(1);
    const payables = computePayables(
      await db.purchases.where('business_id').equals(BIZ).toArray(),
      '2026-08-19',
    );
    expect(payables.totals.outstanding_paise).toBe(replacement.total_paise);
  });
  it('keeps inferred provenance when a legacy purchase edit fills UQC from the current unit', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db, now: () => '2026-08-19T10:00:00Z' });
    const input = { businessId: BIZ, deviceId: DEV, billNumber: 'BILL-LEGACY-SNAPSHOT', billDate: '2026-08-19',
      supplierId: 'sup-1', supplierStateCode: '29', isInterstate: false, financialYear: '2026-27', accounts: ACCOUNTS,
      lines: [{ itemId: 'item-1', warehouseId: 'wh-1', qtyMicros: 1_000_000, unitCostPaise: 1000, taxRateBps: 1800 }] };
    const original = await svc.create(input);
    const oldLine = (await db.purchase_lines.where('purchase_id').equals(original.id).toArray())[0];
    await db.purchase_lines.update(oldLine.id, { uqc_code: null, snapshot_source: null });
    await db.table('items').put({ id: 'item-1', business_id: BIZ, unit_id: 'unit', is_service: 0 });
    await db.units.put({ id: 'unit', business_id: BIZ, code: 'NOS', name: 'Numbers', decimal_places: 0,
      created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T00:00:00Z', entity_version: 1 });
    const replacement = await svc.update(original.id, input);
    expect((await db.purchase_lines.where('purchase_id').equals(replacement.id).toArray())[0]).toMatchObject({ uqc_code: 'NOS', snapshot_source: 'LEGACY_INFERRED', taxable_paise: oldLine.taxable_paise });
    await db.units.update('unit', { code: 'KGS' });
    const next = await svc.update(replacement.id, input);
    expect((await db.purchase_lines.where('purchase_id').equals(next.id).toArray())[0]).toMatchObject({ uqc_code: 'NOS', snapshot_source: 'LEGACY_INFERRED' });
    await db.delete();
  });

  it('cancels an unpaid bill and removes it from payables while preserving journals', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db, now: () => '2026-08-19T10:00:00.000Z' });
    const purchase = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-CANCEL',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [{ itemId: 'item-1', warehouseId: 'wh-1', qtyMicros: 1_000_000, unitCostPaise: 5000, taxRateBps: 0 }],
    });
    const cancelled = await svc.cancel(purchase.id, DEV, 'test cancellation');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancel_reason).toBe('test cancellation');
    expect(await db.journal_entries.get(purchase.journal_entry_id)).toBeDefined();
    expect(await db.journal_entries.get(cancelled.reversal_journal_entry_id!)).toBeDefined();
    expect(computePayables(await db.purchases.toArray(), '2026-08-19').totals.outstanding_paise).toBe(0);
    expect((await db.item_stock.get(`${BIZ}:item-1:wh-1`))?.qty_micros).toBe(0);
  });

  it('rejects cancelling a purchase already marked as returned', async () => {
    const db = freshDb();
    const svc = new PurchaseService({ db });
    const purchase = await svc.create({
      businessId: BIZ,
      deviceId: DEV,
      billNumber: 'BILL-RETURNED',
      billDate: '2026-08-19',
      supplierId: 'sup-1',
      supplierStateCode: '29',
      isInterstate: false,
      financialYear: '2026-27',
      accounts: ACCOUNTS,
      lines: [{
        itemId: 'item-1',
        warehouseId: 'wh-1',
        qtyMicros: 1_000_000,
        unitCostPaise: 5000,
        taxRateBps: 0,
      }],
    });
    await db.purchases.update(purchase.id, { reversed_by_purchase_id: 'debit-note-1' });

    await expect(svc.cancel(purchase.id, DEV)).rejects.toThrow(
      'already has a purchase return',
    );
    expect((await db.item_stock.get(`${BIZ}:item-1:wh-1`))?.qty_micros).toBe(1_000_000);
  });
});
