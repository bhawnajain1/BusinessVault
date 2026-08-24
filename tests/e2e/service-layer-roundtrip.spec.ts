// Service-layer round-trip test.
//
// Complements google-drive-disaster-recovery.spec.ts. That test seeds tables
// directly with `bulkAdd` and asserts restore rebuilds them. This one goes
// through the DOMAIN SERVICE LAYER — the same code the app runs when a user
// clicks "Create Invoice" — because that's the layer where sub-entity events
// (invoice_line, stock_movement, journal_entry, journal_line, purchase_line)
// are emitted. See PR #7. The bhawna data-loss chain would have surfaced here
// early: any service that quietly forgets to journal a sub-row shows up as a
// non-matching row count after restore.
//
// Flow:
//   1. Fresh Dexie in a private name. Seed business + accounts + units +
//      categories + warehouse via the same journaled helpers Onboarding uses.
//   2. Create ONE of every entity via its domain service (Customer, Supplier,
//      Item, Purchase, Invoice, Payment, Advance, Expense, plus a manual
//      InventoryService.recordMovement).
//   3. Snapshot the "before" per-table row counts + a few load-bearing
//      derived values.
//   4. Read every sync_events row from the DB, project to provider-event
//      shape, and flush via LocalFolderStorageProvider.writeJournalEvents into
//      a tmp folder — same code path the sync worker takes.
//   5. Also writeSnapshot() with an empty snapshot so restore has a starting
//      point (rebuildFromDrive needs snapshotIndex.json to exist).
//   6. Nuke the DB completely. Open a fresh Dexie with a new name.
//   7. Call rebuildFromDrive against the folder — same as the Restore Wizard.
//   8. Assert every table's row count matches, plus derived fields:
//        - invoice paid_paise / balance_paise / status after the payment
//        - item_stock qty after purchase + invoice + manual movement
//        - trial balance = 0 (accounting invariant)
//        - GST totals match
//
// Runtime target: < 10 seconds (single of each entity). The heavy DR test
// covers volume; this one covers surface area.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { ulid } from 'ulid';

import { BusinessVaultDB } from '../../src/db/database';
import { LocalFolderStorageProvider } from '../../src/storage/LocalFolderStorageProvider';
import { rebuildFromDrive } from '../../src/restore/rebuildFromDrive';
import { seedChartOfAccounts, SYSTEM_ACCOUNT_CODES, findAccountByCode } from '../../src/domain/coa';
import { appendSyncEvent } from '../../src/domain/syncEventLog';
import { CustomerService } from '../../src/domain/CustomerService';
import { SupplierService } from '../../src/domain/SupplierService';
import { ItemService } from '../../src/domain/ItemService';
import { PurchaseService } from '../../src/domain/PurchaseService';
import { InvoiceService } from '../../src/domain/InvoiceService';
import { PaymentService } from '../../src/domain/PaymentService';
import { AdvanceService } from '../../src/domain/AdvanceService';
import { ExpenseService } from '../../src/domain/ExpenseService';
import { InventoryService } from '../../src/domain/InventoryService';
import { toProviderEvent } from '../../src/sync/syncWorker';
import { TABLE_SPECS } from '../../src/restore/tableSchema';
import type {
  Business,
  Category,
  SyncEvent as StoredSyncEvent,
  Unit,
  Warehouse,
} from '../../src/db/types';
import type {
  SyncEvent as ProviderSyncEvent,
} from '../../src/storage/CustomerStorageProvider';

(globalThis as unknown as { Blob: typeof NodeBlob }).Blob = NodeBlob;
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BID = 'biz_svc_rt';
const BUSINESS_NAME = 'RoundTrip Traders';
const DEVICE_ID = 'device_svc_rt';
const FY = '2026-27';
const NOW_ISO = '2026-08-21T10:00:00.000Z';
const NOW_DATE = '2026-08-21';

// ---------------------------------------------------------------------------
// Seed helpers — inline copies of Onboarding + seedDefaultMasters that accept
// an explicit db (the shipped helpers use the global default db).
// ---------------------------------------------------------------------------

async function seedBusinessRow(db: BusinessVaultDB): Promise<Business> {
  const row: Business = {
    id: BID,
    name: BUSINESS_NAME,
    legal_name: 'RoundTrip Traders Pvt Ltd',
    gstin: '29AAECR1234H1Z5',
    pan: 'AAECR1234H',
    address_line1: '10 MG Road',
    address_line2: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    state_code: '29',
    pincode: '560001',
    country: 'IN',
    phone: '9000000000',
    email: 'ops@roundtrip.example',
    financial_year_start_month: 4,
    current_financial_year: FY,
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV-',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    entity_version: 1,
  };
  await db.transaction('rw', [db.businesses, db.sync_events], async () => {
    await db.businesses.add(row);
    await appendSyncEvent(db, {
      businessId: BID,
      deviceId: DEVICE_ID,
      entityType: 'business',
      entityId: BID,
      operation: 'created',
      payload: row,
      timestamp: NOW_ISO,
    });
  });
  return row;
}

async function seedMasters(
  db: BusinessVaultDB,
): Promise<{ warehouseId: string; unitId: string; categoryId: string }> {
  const wh: Warehouse = {
    id: ulid(),
    business_id: BID,
    name: 'Main Store',
    address: '',
    is_default: 1,
    active: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    entity_version: 1,
  };
  const unit: Unit = {
    id: ulid(),
    business_id: BID,
    code: 'PCS',
    name: 'Pieces',
    decimal_places: 0,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    entity_version: 1,
  };
  const category: Category = {
    id: ulid(),
    business_id: BID,
    name: 'General',
    parent_id: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    entity_version: 1,
  };
  await db.transaction(
    'rw',
    [db.warehouses, db.units, db.categories, db.sync_events],
    async () => {
      await db.warehouses.add(wh);
      await appendSyncEvent(db, {
        businessId: BID,
        deviceId: DEVICE_ID,
        entityType: 'warehouse',
        entityId: wh.id,
        operation: 'created',
        payload: wh,
        timestamp: NOW_ISO,
      });
      await db.units.add(unit);
      await appendSyncEvent(db, {
        businessId: BID,
        deviceId: DEVICE_ID,
        entityType: 'unit',
        entityId: unit.id,
        operation: 'created',
        payload: unit,
        timestamp: NOW_ISO,
      });
      await db.categories.add(category);
      await appendSyncEvent(db, {
        businessId: BID,
        deviceId: DEVICE_ID,
        entityType: 'category',
        entityId: category.id,
        operation: 'created',
        payload: category,
        timestamp: NOW_ISO,
      });
    },
  );
  return { warehouseId: wh.id, unitId: unit.id, categoryId: category.id };
}

// ---------------------------------------------------------------------------
// Project stored sync_events rows to the provider event shape via the shipped
// syncWorker.toProviderEvent — so this test exercises the same mapping the
// real backup worker uses. If that mapper drops information (e.g. collapses a
// non-CRUD verb to 'update' when restore has no matching handler), the
// backup→restore round-trip surfaces it here.
// ---------------------------------------------------------------------------

function projectToProviderEvent(row: StoredSyncEvent): ProviderSyncEvent {
  return toProviderEvent(row);
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('service-layer round-trip', () => {
  let root: string;
  let db: BusinessVaultDB;
  let dbName: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-svc-rt-'));
    dbName = `bv_svc_rt_${ulid()}`;
    db = new BusinessVaultDB(dbName);
    await db.open();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it(
    'creates every entity via services, backs up to folder, restores bit-exactly',
    async () => {
      // -------------------------------------------------------------------
      // Phase 1 — Seed business + system CoA + masters (journaled).
      // -------------------------------------------------------------------
      await seedBusinessRow(db);
      await seedChartOfAccounts(BID, { db, deviceId: DEVICE_ID });
      const { warehouseId, unitId, categoryId } = await seedMasters(db);

      // -------------------------------------------------------------------
      // Phase 2 — Run every service the app exposes for a normal workday.
      // -------------------------------------------------------------------
      const custSvc = new CustomerService({ db });
      const suppSvc = new SupplierService({ db });
      const itemSvc = new ItemService({ db });
      const purcSvc = new PurchaseService({ db });
      const invSvc = new InvoiceService(db);
      const paySvc = new PaymentService(db);
      const advSvc = new AdvanceService(db);
      const expSvc = new ExpenseService({ db });
      const invtySvc = new InventoryService({ db });

      const customer = await custSvc.create({
        businessId: BID,
        deviceId: DEVICE_ID,
        name: 'Ravi Kumar',
        phone: '9000000001',
        gstin: null,
        billingAddress: 'Bengaluru',
        state: 'Karnataka',
        stateCode: '29',
      });

      const supplier = await suppSvc.create({
        businessId: BID,
        deviceId: DEVICE_ID,
        name: 'Acme Wholesale',
        phone: '8000000001',
        gstin: null,
        address: 'Peenya',
        state: 'Karnataka',
        stateCode: '29',
      });

      const item = await itemSvc.create({
        businessId: BID,
        deviceId: DEVICE_ID,
        sku: 'SKU-001',
        name: 'Widget',
        hsn: '8471',
        categoryId,
        unitId,
        salePricePaise: 10_000, // ₹100 / unit
        purchasePricePaise: 6_000, // ₹60 / unit
        taxRateBps: 1800, // 18% GST — intra-state → CGST 9 + SGST 9
        trackInventory: true,
      });

      // Resolve system accounts by code for the services that require them.
      const [
        accCash,
        accBank,
        accAr,
        accInputCgst,
        accInputSgst,
        accInputIgst,
        accInputCess,
        accAp,
        accPurchases,
        accMisc,
      ] = await Promise.all([
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.CASH, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.BANK, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.RECEIVABLE, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.INPUT_CGST, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.INPUT_SGST, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.INPUT_IGST, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.INPUT_CESS, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.PAYABLE, { db }),
        findAccountByCode(BID, SYSTEM_ACCOUNT_CODES.PURCHASES, { db }),
        findAccountByCode(BID, '6080', { db }), // Misc Expense
      ]);
      if (
        !accCash || !accBank || !accAr || !accInputCgst || !accInputSgst ||
        !accInputIgst || !accInputCess || !accAp || !accPurchases || !accMisc
      ) {
        throw new Error('CoA seed missing a required account');
      }

      // Purchase: 100 units of SKU-001 at ₹60 each → 6000 net + 18% GST = 7080
      const purchase = await purcSvc.create({
        businessId: BID,
        deviceId: DEVICE_ID,
        billNumber: 'BILL-001',
        billDate: NOW_DATE,
        supplierId: supplier.id,
        supplierStateCode: '29',
        isInterstate: false,
        financialYear: FY,
        lines: [
          {
            itemId: item.id,
            hsn: item.hsn,
            warehouseId,
            qtyMicros: 100_000_000, // 100 units
            unitCostPaise: 6_000,
            taxRateBps: 1800,
            trackInventory: true,
          },
        ],
        accounts: {
          purchases: accPurchases.id,
          inputCgst: accInputCgst.id,
          inputSgst: accInputSgst.id,
          inputIgst: accInputIgst.id,
          inputCess: accInputCess.id,
          accountsPayable: accAp.id,
        },
      });

      // Invoice: 5 units at ₹100 sale price → 500 net + 18% GST (CGST 45 + SGST 45) = 590
      const invoice = await invSvc.createInvoice({
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_number: 'INV-000001',
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 5_000_000, // 5 units
            unit_price_paise: 10_000,
            taxable_paise: 50_000,
            tax_rate_bps: 1800,
            cgst_paise: 4_500,
            sgst_paise: 4_500,
            igst_paise: 0,
            line_total_paise: 59_000,
          },
        ],
      });
      expect(invoice.total_paise).toBe(59_000);

      // Partial payment: cover half the invoice
      const halfPay = 29_500;
      await paySvc.createPayment({
        business_id: BID,
        device_id: DEVICE_ID,
        payment_number: 'PMT-000001',
        payment_date: NOW_DATE,
        direction: 'in',
        party_type: 'customer',
        party_id: customer.id,
        method: 'cash',
        cash_or_bank_account_id: accCash.id,
        ar_or_ap_account_id: accAr.id,
        amount_paise: halfPay,
        allocations: [{ invoice_id: invoice.id, amount_paise: halfPay }],
      });

      // Advance: customer prepays ₹200 for a future order
      await advSvc.recordAdvance({
        business_id: BID,
        device_id: DEVICE_ID,
        advance_number: 'ADV-000001',
        advance_date: NOW_DATE,
        party_type: 'customer',
        party_id: customer.id,
        method: 'bank',
        cash_or_bank_account_id: accBank.id,
        amount_paise: 20_000,
      });

      // Expense: ₹150 misc, paid from cash
      await expSvc.create({
        businessId: BID,
        deviceId: DEVICE_ID,
        expenseNumber: 'EXP-001',
        expenseDate: NOW_DATE,
        categoryAccountId: accMisc.id,
        paymentAccountId: accCash.id,
        description: 'Office supplies',
        amountPaise: 15_000,
      });

      // Manual inventory adjustment: +3 units (write-in / found stock)
      await invtySvc.recordMovement({
        businessId: BID,
        deviceId: DEVICE_ID,
        itemId: item.id,
        warehouseId,
        kind: 'adjustment',
        qtyDelta: 3, // +3 units
        unitCost: 60,
        reason: 'Physical count adjustment',
      });

      // -------------------------------------------------------------------
      // Phase 2b — Exercise the mutation paths that emit non-CRUD verbs
      // (applyAdvance → advance:update merge; voidInvoice → invoice:reverse;
      // refundPayment → payment:reverse + payment:create; deleteInvoice →
      // invoice:delete + cascade; restoreInvoice → invoice:update restore).
      // Each of these was silently broken before the naming-split fix — see
      // the eventHandlers.ts comments. Losing any of them shows up here as
      // a table-count mismatch or a wrong derived balance after restore.
      // -------------------------------------------------------------------

      // Invoice #2 — apply advance against it. Advance is ₹200; invoice #2
      // is ₹100 total so the advance covers it fully with ₹100 remaining.
      const invoice2 = await invSvc.createInvoice({
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_number: 'INV-000002',
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 1_000_000, // 1 unit
            unit_price_paise: 8_474, // 8474 + 18% GST ≈ 10000
            taxable_paise: 8_474,
            tax_rate_bps: 1800,
            cgst_paise: 763,
            sgst_paise: 763,
            igst_paise: 0,
            line_total_paise: 10_000,
          },
        ],
      });
      // recordAdvance emitted 'created'; capture that advance id.
      const advances = await db.advances.where('business_id').equals(BID).toArray();
      const advance = advances[0];
      expect(advance).toBeDefined();
      await advSvc.applyAdvance({
        business_id: BID,
        device_id: DEVICE_ID,
        advance_id: advance.id,
        invoice_id: invoice2.id,
        amount_paise: 10_000,
        applied_on: NOW_DATE,
      });

      // Invoice #3 — void it (creates credit note + reversal journal).
      const invoice3 = await invSvc.createInvoice({
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_number: 'INV-000003',
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 1_000_000,
            unit_price_paise: 8_474,
            taxable_paise: 8_474,
            tax_rate_bps: 1800,
            cgst_paise: 763,
            sgst_paise: 763,
            igst_paise: 0,
            line_total_paise: 10_000,
          },
        ],
      });
      // Edit invoice3 — the underlying reversal + credit-note flow is the same
      // as the old voidInvoice path; updateInvoice is now the public surface.
      await invSvc.updateInvoice(invoice3.id, {
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 1_000_000,
            unit_price_paise: 8_474,
            taxable_paise: 8_474,
            tax_rate_bps: 1800,
            cgst_paise: 763,
            sgst_paise: 763,
            igst_paise: 0,
            line_total_paise: 10_000,
          },
        ],
      });
      const reversedInvoice3 = await invSvc.getInvoice(invoice3.id);
      expect(reversedInvoice3?.reversed_by_invoice_id).toBeDefined();
      const invoice3CreditNoteId = reversedInvoice3!.reversed_by_invoice_id!;

      // Invoice #4 — pay in full, then refund the payment.
      const invoice4 = await invSvc.createInvoice({
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_number: 'INV-000004',
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 1_000_000,
            unit_price_paise: 8_474,
            taxable_paise: 8_474,
            tax_rate_bps: 1800,
            cgst_paise: 763,
            sgst_paise: 763,
            igst_paise: 0,
            line_total_paise: 10_000,
          },
        ],
      });
      const inv4Payment = await paySvc.createPayment({
        business_id: BID,
        device_id: DEVICE_ID,
        payment_number: 'PMT-000002',
        payment_date: NOW_DATE,
        direction: 'in',
        party_type: 'customer',
        party_id: customer.id,
        method: 'cash',
        cash_or_bank_account_id: accCash.id,
        ar_or_ap_account_id: accAr.id,
        amount_paise: 10_000,
        allocations: [{ invoice_id: invoice4.id, amount_paise: 10_000 }],
      });
      await paySvc.refundPayment({
        business_id: BID,
        device_id: DEVICE_ID,
        payment_id: inv4Payment.id,
        refund_payment_number: 'PMT-REF-000001',
        refund_date: NOW_DATE,
        reason: 'customer returned goods',
      });

      // Invoice #5 — has a payment fully allocated to it, then soft-delete +
      // restore. This is the ONLY scenario that exercises the cascade code
      // path in the invoice:delete handler AND the restore-cascade code path
      // in the invoice:update restore branch. Without an allocated payment
      // both cascaded_payment_ids and restored_payment_ids would be empty
      // and those loops would never execute — silently passing tests even
      // if the loops were removed.
      const invoice5 = await invSvc.createInvoice({
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_number: 'INV-000005',
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 1_000_000,
            unit_price_paise: 8_474,
            taxable_paise: 8_474,
            tax_rate_bps: 1800,
            cgst_paise: 763,
            sgst_paise: 763,
            igst_paise: 0,
            line_total_paise: 10_000,
          },
        ],
      });
      const inv5Payment = await paySvc.createPayment({
        business_id: BID,
        device_id: DEVICE_ID,
        payment_number: 'PMT-000003',
        payment_date: NOW_DATE,
        direction: 'in',
        party_type: 'customer',
        party_id: customer.id,
        method: 'cash',
        cash_or_bank_account_id: accCash.id,
        ar_or_ap_account_id: accAr.id,
        amount_paise: 10_000,
        allocations: [{ invoice_id: invoice5.id, amount_paise: 10_000 }],
      });
      await invSvc.deleteInvoice(invoice5.id, 'duplicate entry');
      await invSvc.restoreInvoice(invoice5.id);

      // Invoice #6 — soft-delete WITHOUT restoring. Restore must reproduce
      // the deleted_at flag exactly (not resurrect the row silently).
      const invoice6 = await invSvc.createInvoice({
        business_id: BID,
        device_id: DEVICE_ID,
        invoice_number: 'INV-000006',
        invoice_date: NOW_DATE,
        customer_id: customer.id,
        customer_state_code: '29',
        place_of_supply: '29',
        is_interstate: false,
        financial_year: FY,
        lines: [
          {
            item_id: item.id,
            hsn: item.hsn,
            warehouse_id: warehouseId,
            qty_micros: 1_000_000,
            unit_price_paise: 8_474,
            taxable_paise: 8_474,
            tax_rate_bps: 1800,
            cgst_paise: 763,
            sgst_paise: 763,
            igst_paise: 0,
            line_total_paise: 10_000,
          },
        ],
      });
      await invSvc.deleteInvoice(invoice6.id, 'still bogus');

      // -------------------------------------------------------------------
      // Phase 3 — Snapshot the "before" state.
      // -------------------------------------------------------------------
      const before = await snapshotCounts(db);

      // Stock math: purchase +100, adjustment +3, six invoices consume 5+1+1+1+1+1 = 10.
      // Invoice #3 was edited via updateInvoice, which reverses the original
      // (+1 stock via sale_return) and immediately posts a fresh invoice for
      // the same qty (-1 stock) — net zero change from the edit. Deletion is
      // soft, does NOT reverse stock. Total = 100 + 3 - 10 = 93.
      const stockRow = await db.item_stock
        .where('[business_id+item_id+warehouse_id]')
        .equals([BID, item.id, warehouseId])
        .first();
      expect(stockRow?.qty_micros).toBe(93_000_000);

      // -------------------------------------------------------------------
      // Phase 4 — Flush every LOCAL_ONLY sync_event to the folder.
      //   - Connect a LocalFolderStorageProvider to the tmp root.
      //   - writeJournalEvents against the provider (same call the sync
      //     worker makes).
      //   - writeSnapshot with an empty CSV set for each table + a
      //     manifest — rebuildFromDrive needs snapshots/index.json to exist,
      //     otherwise it complains "no snapshot found".
      // -------------------------------------------------------------------
      const producer = new LocalFolderStorageProvider();
      await producer.connect({ kind: 'local-folder', rootPath: root });
      await producer.initializeBusiness({ businessId: BID, businessName: BUSINESS_NAME });

      const storedEvents = await db.sync_events
        .where('business_id')
        .equals(BID)
        .toArray();
      const providerEvents = storedEvents.map(projectToProviderEvent);
      const writeResult = await producer.writeJournalEvents(providerEvents);
      expect(writeResult.written).toBe(providerEvents.length);
      expect(writeResult.duplicates).toEqual([]);

      // Empty snapshot — restore will replay the entire journal.
      const emptyManifest = {
        schemaVersion: 1,
        businessId: BID,
        businessName: BUSINESS_NAME,
        counts: {},
      };
      await producer.writeSnapshot({
        businessId: BID,
        kind: 'daily',
        asOf: NOW_DATE,
        files: [],
        manifest: emptyManifest,
      });

      // -------------------------------------------------------------------
      // Phase 5 — Nuke the DB. Simulate loss of the device.
      // -------------------------------------------------------------------
      db.close();
      await db.delete();
      await producer.disconnect();

      // -------------------------------------------------------------------
      // Phase 6 — Fresh Dexie, restore from folder alone.
      // -------------------------------------------------------------------
      const restoredDbName = `bv_svc_rt_restore_${ulid()}`;
      const restoredDb = new BusinessVaultDB(restoredDbName);
      await restoredDb.open();
      const restoreProvider = new LocalFolderStorageProvider();
      const report = await rebuildFromDrive(restoreProvider, {
        db: restoredDb,
        providerConfig: { kind: 'local-folder', rootPath: root },
      });

      try {
        expect(report.accountingBalanced).toBe(true);
        expect(report.inventoryConsistent).toBe(true);
        expect(report.gstReconciled).toBe(true);
        expect(report.diagnostics.ok).toBe(true);

        // -----------------------------------------------------------------
        // Phase 7 — Compare table row counts + derived fields.
        // -----------------------------------------------------------------
        const after = await snapshotCounts(restoredDb);

        // Every counted table matches.
        const mismatches: string[] = [];
        for (const table of Object.keys(before.counts)) {
          if (after.counts[table] !== before.counts[table]) {
            mismatches.push(
              `${table}: before=${before.counts[table]} after=${after.counts[table]}`,
            );
          }
        }
        expect(mismatches, mismatches.join('\n')).toEqual([]);

        // Invoice #1: partial payment. paid = halfPay, balance = total - halfPay.
        const restoredInv = await restoredDb.invoices.get(invoice.id);
        expect(restoredInv).toBeDefined();
        expect(restoredInv!.paid_paise).toBe(halfPay);
        expect(restoredInv!.balance_paise).toBe(59_000 - halfPay);
        expect(restoredInv!.status).toBe('partial');

        // Invoice #3: voided. reversed_by_invoice_id points at the credit
        // note, and — importantly — status stays 'issued' (the reversal path
        // never sets status='cancelled'; the app hides superseded invoices via
        // the reversed_by_invoice_id non-null check). If the invoice:reverse
        // handler is ever regressed to set status='cancelled', this assert
        // catches the divergence.
        const restoredInv3 = await restoredDb.invoices.get(invoice3.id);
        expect(restoredInv3).toBeDefined();
        expect(restoredInv3!.reversed_by_invoice_id).toBe(invoice3CreditNoteId);
        expect(restoredInv3!.status).toBe('issued');

        // Invoice #4: paid, then refunded. rebuildInvoicePaidBalance sums
        // BOTH the original payment (+10000) and the refund allocation
        // (-10000), so paid_paise must come back to 0 and status to 'issued'.
        // If restore's paid-balance rebuild still filters by direction='in'
        // the refund is silently dropped and this asserts breaks.
        const restoredInv4 = await restoredDb.invoices.get(invoice4.id);
        expect(restoredInv4).toBeDefined();
        expect(restoredInv4!.paid_paise).toBe(0);
        expect(restoredInv4!.status).toBe('issued');

        // Invoice #5: deleted then restored. deleted_at must be null on the
        // invoice AND on the cascaded payment (restore-cascade path). If the
        // restore-cascade loop in eventHandlers.ts is removed, the payment
        // stays soft-deleted and this asserts fires.
        const restoredInv5 = await restoredDb.invoices.get(invoice5.id);
        expect(restoredInv5).toBeDefined();
        expect(restoredInv5!.deleted_at ?? null).toBeNull();
        const restoredInv5Payment = await restoredDb.payments.get(inv5Payment.id);
        expect(restoredInv5Payment).toBeDefined();
        expect(restoredInv5Payment!.deleted_at ?? null).toBeNull();
        expect(restoredInv5Payment!.deleted_reason ?? null).toBeNull();

        // Invoice #6: deleted (not restored). deleted_at must be set.
        const restoredInv6 = await restoredDb.invoices.get(invoice6.id);
        expect(restoredInv6).toBeDefined();
        expect(restoredInv6!.deleted_at).toBeTruthy();
        expect(restoredInv6!.deleted_reason).toBe('still bogus');

        // Advance: applied to invoice #2. remaining = 20000 - 10000 = 10000.
        // Applications array must contain exactly one application.
        const restoredAdvance = await restoredDb.advances.get(advance.id);
        expect(restoredAdvance).toBeDefined();
        expect(restoredAdvance!.remaining_paise).toBe(10_000);
        expect(restoredAdvance!.applications.length).toBe(1);
        expect(restoredAdvance!.applications[0].invoice_id).toBe(invoice2.id);
        expect(restoredAdvance!.applications[0].amount_paise).toBe(10_000);

        // Invoice #2: fully covered by the applied advance. paid_paise must
        // reflect the advance-applied amount and status must be 'paid'.
        // Regression guard for the silent-corruption bug where
        // rebuildInvoicePaidBalance summed only payment allocations and
        // dropped advance applications entirely.
        const restoredInv2 = await restoredDb.invoices.get(invoice2.id);
        expect(restoredInv2).toBeDefined();
        expect(restoredInv2!.paid_paise).toBe(10_000);
        expect(restoredInv2!.balance_paise).toBe(0);
        expect(restoredInv2!.status).toBe('paid');

        // Invoice #5 (restored after delete-cascade): its allocated payment
        // came back too, so paid_paise === total_paise, status === 'paid'.
        expect(restoredInv5!.paid_paise).toBe(10_000);
        expect(restoredInv5!.balance_paise).toBe(0);
        expect(restoredInv5!.status).toBe('paid');

        // Idempotency guard: replaying the same journal a second time must
        // NOT double-apply. This catches regressions of the `already` guard
        // in the advance:update merge handler (dedup by application key).
        const report2 = await rebuildFromDrive(new LocalFolderStorageProvider(), {
          db: restoredDb,
          providerConfig: { kind: 'local-folder', rootPath: root },
        });
        expect(report2.diagnostics.ok).toBe(true);
        const twiceRestoredAdvance = await restoredDb.advances.get(advance.id);
        expect(twiceRestoredAdvance!.applications.length).toBe(1);
        const twiceRestoredInv2 = await restoredDb.invoices.get(invoice2.id);
        expect(twiceRestoredInv2!.paid_paise).toBe(10_000);
        expect(twiceRestoredInv2!.status).toBe('paid');

        // Item stock cache is derived from movements — rebuildFromDrive
        // recomputes it, so 93 units must be back.
        const restoredStock = await restoredDb.item_stock
          .where('[business_id+item_id+warehouse_id]')
          .equals([BID, item.id, warehouseId])
          .first();
        expect(restoredStock?.qty_micros).toBe(93_000_000);

        // GST totals — sum invoice.cgst + sgst.
        expect(after.cgst).toBe(before.cgst);
        expect(after.sgst).toBe(before.sgst);
        expect(after.igst).toBe(before.igst);

        // Trial balance: sum of posted journal_lines debits === credits.
        expect(after.totalDebit).toBe(after.totalCredit);
        expect(after.totalDebit).toBe(before.totalDebit);
      } finally {
        restoredDb.close();
        await restoredDb.delete().catch(() => undefined);
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// snapshotCounts — canonical projection of the DB into a shape the assertion
// block can diff. Every table the seed / services touched is counted.
// ---------------------------------------------------------------------------

interface CountSnapshot {
  counts: Record<string, number>;
  cgst: number;
  sgst: number;
  igst: number;
  totalDebit: number;
  totalCredit: number;
}

async function snapshotCounts(db: BusinessVaultDB): Promise<CountSnapshot> {
  // Derive the counted table list from the shipped snapshot schema, so that
  // adding a new persistable table to tableSchema.ts automatically extends
  // this test's coverage instead of silently drifting.
  const tables = TABLE_SPECS.map((s) => s.store);
  const counts: Record<string, number> = {};
  for (const t of tables) {
    if (t === 'businesses') {
      counts[t] = await db.businesses.toArray().then((rs) => rs.length);
    } else if (t === 'item_stock') {
      counts[t] = await db.item_stock.where('business_id').equals(BID).count();
    } else {
      counts[t] = await (db as unknown as Record<string, {
        where(k: string): { equals(v: unknown): { count(): Promise<number> } };
      }>)[t].where('business_id').equals(BID).count();
    }
  }

  const invoices = await db.invoices.where('business_id').equals(BID).toArray();
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const inv of invoices) {
    cgst += inv.cgst_paise;
    sgst += inv.sgst_paise;
    igst += inv.igst_paise;
  }

  const jEntries = await db.journal_entries.where('business_id').equals(BID).toArray();
  const jLines = await db.journal_lines.where('business_id').equals(BID).toArray();
  const postedIds = new Set(jEntries.filter((e) => e.posted === 1).map((e) => e.id));
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of jLines) {
    if (!postedIds.has(l.entry_id)) continue;
    totalDebit += l.debit_paise;
    totalCredit += l.credit_paise;
  }

  return { counts, cgst, sgst, igst, totalDebit, totalCredit };
}
