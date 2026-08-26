import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ulid } from 'ulid';
import { BusinessVaultDB } from '../db/database';
import type {
  Business,
  Invoice,
  InvoiceLine,
  JournalEntry,
  StockMovement,
} from '../db/types';
import {
  MIGRATION_VERSION,
  runLegacyReversalMigration,
} from './legacyReversalMigration';
import {
  getReturnedQtyMicros,
  rebuildInvoiceLineReturnSummary,
} from './invoiceLineReturnSummary';

// ------- test scaffolding -----------------------------------------------------

const BIZ = 'biz-mig';

function freshDb(): BusinessVaultDB {
  return new BusinessVaultDB('bv-mig-' + Math.random().toString(36).slice(2));
}

async function seedBusiness(db: BusinessVaultDB): Promise<void> {
  const now = new Date().toISOString();
  const biz: Business = {
    id: BIZ,
    name: 'Test Biz',
    legal_name: 'Test Biz',
    gstin: null,
    pan: null,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    state_code: '29',
    pincode: '',
    country: 'IN',
    phone: '',
    email: '',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    sales_return_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 5,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
  await db.businesses.add(biz);
}

// Build a minimal (original invoice + credit-note invoice + reversing
// journal + optional stock movements) triple that matches the pre-v5 shape
// each domain writes today. Used to fabricate legacy state without pulling
// in the full InvoiceService/ReturnService which are being changed in PR2.
interface LegacyFixture {
  origId: string;
  origLines: InvoiceLine[];
  cnId: string;
  cnLines: InvoiceLine[];
  reversalJeId: string;
}

interface FixtureOpts {
  kind: 'return' | 'edit' | 'ambiguous';
  origInvoiceNumber?: string;
  origQty?: number; // qty micros for the single line
  origUnitPricePaise?: number;
  origTaxable?: number;
}

async function seedLegacyReversal(
  db: BusinessVaultDB,
  opts: FixtureOpts,
): Promise<LegacyFixture> {
  const now = new Date().toISOString();
  const origId = ulid();
  const cnId = ulid();
  const origJeId = ulid();
  const reversalJeId = ulid();
  const origInvoiceNumber = opts.origInvoiceNumber ?? 'INV-000001';
  const origLineId = ulid();
  const cnLineId = ulid();
  const origQty = opts.origQty ?? 10_000_000; // 10 units
  const origUnitPrice = opts.origUnitPricePaise ?? 10_000; // ₹100
  const origTaxable = opts.origTaxable ?? 100_000; // ₹1000

  const origInvoice: Invoice = {
    id: origId,
    business_id: BIZ,
    invoice_number: origInvoiceNumber,
    invoice_date: '2026-08-01',
    due_date: null,
    customer_id: 'cust-1',
    customer_state_code: '29',
    place_of_supply: '29',
    is_interstate: 0,
    financial_year: '2026-27',
    subtotal_paise: origTaxable,
    discount_paise: 0,
    taxable_paise: origTaxable,
    cgst_paise: 9000,
    sgst_paise: 9000,
    igst_paise: 0,
    cess_paise: 0,
    round_off_paise: 0,
    total_paise: origTaxable + 18000,
    paid_paise: 0,
    balance_paise: origTaxable + 18000,
    status: 'issued',
    reversed_by_invoice_id: cnId,
    reverses_invoice_id: null,
    notes: '',
    terms: '',
    pdf_attachment_id: null,
    journal_entry_id: origJeId,
    created_at: now,
    updated_at: now,
    entity_version: 2,
  };

  const origLine: InvoiceLine = {
    id: origLineId,
    business_id: BIZ,
    invoice_id: origId,
    line_no: 1,
    item_id: 'item-1',
    description: 'Product A',
    hsn: '1234',
    warehouse_id: 'wh-1',
    qty_micros: origQty,
    unit_price_paise: origUnitPrice,
    discount_pct_bps: 0,
    discount_paise: 0,
    taxable_paise: origTaxable,
    tax_rate_bps: 1800,
    cgst_paise: 9000,
    sgst_paise: 9000,
    igst_paise: 0,
    cess_paise: 0,
    line_total_paise: origTaxable + 18000,
  };

  const cnInvoice: Invoice = {
    ...origInvoice,
    id: cnId,
    invoice_number:
      opts.kind === 'edit'
        ? `${origInvoiceNumber}-CN`
        : `CN-${origInvoiceNumber}`,
    subtotal_paise: -origInvoice.subtotal_paise,
    discount_paise: -origInvoice.discount_paise,
    taxable_paise: -origInvoice.taxable_paise,
    cgst_paise: -origInvoice.cgst_paise,
    sgst_paise: -origInvoice.sgst_paise,
    igst_paise: -origInvoice.igst_paise,
    cess_paise: -origInvoice.cess_paise,
    round_off_paise: -origInvoice.round_off_paise,
    total_paise: -origInvoice.total_paise,
    paid_paise: 0,
    balance_paise: -origInvoice.total_paise,
    status: 'issued',
    reversed_by_invoice_id: null,
    reverses_invoice_id: origId,
    notes:
      opts.kind === 'return'
        ? `Credit note for invoice ${origInvoiceNumber}. Reason: Defective goods`
        : opts.kind === 'edit'
          ? `Credit note for ${origInvoiceNumber}. Reason: edit`
          : '',
    journal_entry_id: reversalJeId,
    entity_version: 1,
  };
  const cnLine: InvoiceLine = {
    ...origLine,
    id: cnLineId,
    invoice_id: cnId,
    qty_micros: -origLine.qty_micros,
    discount_paise: -origLine.discount_paise,
    taxable_paise: -origLine.taxable_paise,
    cgst_paise: -origLine.cgst_paise,
    sgst_paise: -origLine.sgst_paise,
    igst_paise: -origLine.igst_paise,
    cess_paise: -origLine.cess_paise,
    line_total_paise: -origLine.line_total_paise,
  };

  const reversalJe: JournalEntry = {
    id: reversalJeId,
    business_id: BIZ,
    entry_number:
      opts.kind === 'edit'
        ? `JE-REV-${cnId}`
        : opts.kind === 'return'
          ? `JE-CN-${origInvoiceNumber}`
          : `JE-MISC-${cnId}`,
    entry_date: origInvoice.invoice_date,
    narration:
      opts.kind === 'edit'
        ? `Reversal of ${origInvoiceNumber}: edit`
        : opts.kind === 'return'
          ? `Sales return for ${origInvoiceNumber}: Defective goods`
          : `Adjustment on ${origInvoiceNumber}`,
    ref_type:
      opts.kind === 'edit'
        ? 'reversal'
        : opts.kind === 'return'
          ? 'invoice'
          : 'manual',
    ref_id: cnId,
    reversed_by_id: null,
    reverses_id: origJeId,
    total_debit_paise: origInvoice.total_paise,
    total_credit_paise: origInvoice.total_paise,
    posted: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };

  await db.invoices.bulkAdd([origInvoice, cnInvoice]);
  await db.invoice_lines.bulkAdd([origLine, cnLine]);
  await db.journal_entries.add(reversalJe);

  if (opts.kind === 'return') {
    const mv: StockMovement = {
      id: ulid(),
      business_id: BIZ,
      item_id: 'item-1',
      warehouse_id: 'wh-1',
      movement_type: 'sale_return',
      qty_micros: origQty,
      unit_cost_paise: origUnitPrice,
      ref_type: 'invoice',
      ref_id: cnId,
      occurred_at: now,
      notes: `Sales return`,
    };
    await db.stock_movements.add(mv);
  }

  return {
    origId,
    origLines: [origLine],
    cnId,
    cnLines: [cnLine],
    reversalJeId,
  };
}

// ------- tests ----------------------------------------------------------------

describe('legacyReversalMigration', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('classifies a legacy Sales Return and backfills native rows + summary', async () => {
    const db = freshDb();
    await seedBusiness(db);
    const fx = await seedLegacyReversal(db, { kind: 'return' });

    const result = await runLegacyReversalMigration(db, BIZ);

    expect(result.classifiedAs.SALES_RETURN).toBe(1);
    expect(result.materializedSalesReturns).toBe(1);

    const returns = await db.sales_returns.toArray();
    expect(returns).toHaveLength(1);
    expect(returns[0].original_invoice_id).toBe(fx.origId);
    expect(returns[0].legacy_migration_classification).toBe('SALES_RETURN');
    expect(returns[0].reversed_credit_note_invoice_id).toBe(fx.cnId);
    expect(returns[0].return_number).toMatch(/^SR-\d{6}$/);

    const items = await db.sales_return_items.toArray();
    expect(items).toHaveLength(1);
    expect(items[0].original_invoice_line_id).toBe(fx.origLines[0].id);
    expect(items[0].qty_micros).toBe(fx.origLines[0].qty_micros); // positive
    expect(items[0].taxable_paise).toBe(Math.abs(fx.cnLines[0].taxable_paise));

    const audit = await db.legacy_reversal_audit.get(fx.cnId);
    expect(audit?.classification).toBe('SALES_RETURN');
    expect(audit?.materialized_sales_return_id).toBe(returns[0].id);
    expect(audit?.migration_version).toBe(MIGRATION_VERSION);

    // Summary reflects the backfilled quantity.
    expect(await getReturnedQtyMicros(db, fx.origLines[0].id)).toBe(
      fx.origLines[0].qty_micros,
    );

    // Legacy CN row itself is preserved untouched.
    const cnStill = await db.invoices.get(fx.cnId);
    expect(cnStill).toBeDefined();
    expect(cnStill?.reverses_invoice_id).toBe(fx.origId);
  });

  it('classifies a legacy invoice-edit reversal and does NOT backfill', async () => {
    const db = freshDb();
    await seedBusiness(db);
    const fx = await seedLegacyReversal(db, { kind: 'edit' });

    const result = await runLegacyReversalMigration(db, BIZ);

    expect(result.classifiedAs.EDIT_REVERSAL).toBe(1);
    expect(result.materializedSalesReturns).toBe(0);
    expect(await db.sales_returns.count()).toBe(0);
    expect(await db.sales_return_items.count()).toBe(0);
    expect(await db.invoice_line_return_summary.count()).toBe(0);

    const audit = await db.legacy_reversal_audit.get(fx.cnId);
    expect(audit?.classification).toBe('EDIT_REVERSAL');
    expect(audit?.materialized_sales_return_id).toBeNull();
  });

  it('classifies an ambiguous reversal as UNKNOWN, preserves the row, does NOT backfill or touch summary', async () => {
    const db = freshDb();
    await seedBusiness(db);
    const fx = await seedLegacyReversal(db, { kind: 'ambiguous' });

    const result = await runLegacyReversalMigration(db, BIZ);

    expect(result.classifiedAs.UNKNOWN).toBe(1);
    expect(result.materializedSalesReturns).toBe(0);
    expect(await db.sales_returns.count()).toBe(0);
    expect(await db.invoice_line_return_summary.count()).toBe(0);

    const audit = await db.legacy_reversal_audit.get(fx.cnId);
    expect(audit?.classification).toBe('UNKNOWN');
    expect(audit?.materialized_sales_return_id).toBeNull();

    // CN row still present.
    expect(await db.invoices.get(fx.cnId)).toBeDefined();
  });

  it('marks SALES_RETURN as SALES_RETURN_UNRECONSTRUCTABLE when original lines are missing; no native rows', async () => {
    const db = freshDb();
    await seedBusiness(db);
    const fx = await seedLegacyReversal(db, { kind: 'return' });
    // Simulate the pathological state where original invoice's lines were
    // purged (e.g. corrupted restore). The CN + its journal are still
    // present so classification would say SALES_RETURN, but nothing can be
    // reconstructed at line level.
    await db.invoice_lines
      .where('invoice_id')
      .equals(fx.origId)
      .delete();

    const result = await runLegacyReversalMigration(db, BIZ);

    expect(result.classifiedAs.SALES_RETURN).toBe(0);
    expect(result.classifiedAs.SALES_RETURN_UNRECONSTRUCTABLE).toBe(1);
    expect(result.materializedSalesReturns).toBe(0);
    expect(await db.sales_returns.count()).toBe(0);
    expect(await db.sales_return_items.count()).toBe(0);
    expect(await db.invoice_line_return_summary.count()).toBe(0);

    const audit = await db.legacy_reversal_audit.get(fx.cnId);
    expect(audit?.classification).toBe('SALES_RETURN_UNRECONSTRUCTABLE');
    expect(audit?.materialized_sales_return_id).toBeNull();
  });

  it('is idempotent — running twice produces no duplicates', async () => {
    const db = freshDb();
    await seedBusiness(db);
    await seedLegacyReversal(db, {
      kind: 'return',
      origInvoiceNumber: 'INV-000001',
    });
    await seedLegacyReversal(db, {
      kind: 'edit',
      origInvoiceNumber: 'INV-000002',
    });

    await runLegacyReversalMigration(db, BIZ);
    const returnsAfterFirst = await db.sales_returns.count();
    const itemsAfterFirst = await db.sales_return_items.count();
    const auditsAfterFirst = await db.legacy_reversal_audit.count();

    const second = await runLegacyReversalMigration(db, BIZ);
    expect(second.skippedIdempotent).toBe(2);
    expect(second.examined).toBe(0);
    expect(await db.sales_returns.count()).toBe(returnsAfterFirst);
    expect(await db.sales_return_items.count()).toBe(itemsAfterFirst);
    expect(await db.legacy_reversal_audit.count()).toBe(auditsAfterFirst);
  });

  it('rebuildInvoiceLineReturnSummary reconciles cache with active sales_return_items (invariant)', async () => {
    const db = freshDb();
    await seedBusiness(db);
    await seedLegacyReversal(db, { kind: 'return' });
    await runLegacyReversalMigration(db, BIZ);

    // Wipe the cache — pretend it's stale from a restore.
    const stalePks = await db.invoice_line_return_summary.toCollection().primaryKeys();
    await db.invoice_line_return_summary.bulkDelete(stalePks);
    expect(await db.invoice_line_return_summary.count()).toBe(0);

    await rebuildInvoiceLineReturnSummary(db, BIZ);

    // Cache equals SUM(active items) grouped by original_invoice_line_id.
    const items = await db.sales_return_items.toArray();
    const activeReturnIds = new Set(
      (await db.sales_returns.toArray())
        .filter((r) => r.status === 'posted' && !r.deleted_at)
        .map((r) => r.id),
    );
    const expectedByLine = new Map<string, number>();
    for (const it of items) {
      if (!activeReturnIds.has(it.sales_return_id)) continue;
      expectedByLine.set(
        it.original_invoice_line_id,
        (expectedByLine.get(it.original_invoice_line_id) ?? 0) + it.qty_micros,
      );
    }
    for (const [lineId, expected] of expectedByLine) {
      expect(await getReturnedQtyMicros(db, lineId)).toBe(expected);
    }
    // No stray rows.
    expect(await db.invoice_line_return_summary.count()).toBe(expectedByLine.size);
  });

  it('cancelled or soft-deleted returns do NOT contribute to the summary', async () => {
    const db = freshDb();
    await seedBusiness(db);
    const fx = await seedLegacyReversal(db, { kind: 'return' });
    await runLegacyReversalMigration(db, BIZ);
    const sr = (await db.sales_returns.toArray())[0];
    expect(await getReturnedQtyMicros(db, fx.origLines[0].id)).toBe(
      fx.origLines[0].qty_micros,
    );

    // Cancel the return.
    await db.sales_returns.update(sr.id, { status: 'cancelled' });
    await rebuildInvoiceLineReturnSummary(db, BIZ);
    expect(await getReturnedQtyMicros(db, fx.origLines[0].id)).toBe(0);

    // Restore to posted, then soft-delete.
    await db.sales_returns.update(sr.id, {
      status: 'posted',
      deleted_at: new Date().toISOString(),
    });
    await rebuildInvoiceLineReturnSummary(db, BIZ);
    expect(await getReturnedQtyMicros(db, fx.origLines[0].id)).toBe(0);
  });

  it('stamps kv marker with migration version + counts', async () => {
    const db = freshDb();
    await seedBusiness(db);
    await seedLegacyReversal(db, { kind: 'return' });
    await runLegacyReversalMigration(db, BIZ);
    const marker = await db.kv.get('legacyReversalMigration:lastRun');
    expect(marker).toBeDefined();
    const value = marker!.value as {
      version: number;
      counts: Record<string, number>;
      materialized: number;
    };
    expect(value.version).toBe(MIGRATION_VERSION);
    expect(value.materialized).toBe(1);
    expect(value.counts.SALES_RETURN).toBe(1);
  });
});
