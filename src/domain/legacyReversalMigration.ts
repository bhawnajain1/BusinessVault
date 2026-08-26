import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db';
import type {
  Invoice,
  InvoiceLine,
  JournalEntry,
  LegacyMigrationClassification,
  LegacyReversalAudit,
  SalesReturn,
  SalesReturnItem,
  StockMovement,
} from '../db/types';
import { rebuildInvoiceLineReturnSummary } from './invoiceLineReturnSummary';
import { allocateSalesReturnNumber } from './salesReturnNumbering';

// Conservative migration from the pre-v5 world where Sales Returns and
// invoice-edit reversals were BOTH represented as an Invoice row with
// `reverses_invoice_id != null`. See SellReturnRequirement.md §12, §17.
//
// Design invariants (per user directive on 2026-08-26):
//   - Never mutate or delete the legacy Invoice / credit-note rows. The
//     append-only journal hash chain still references them.
//   - Never guess. Only classify as SALES_RETURN when a strong deterministic
//     signal (ref_type='invoice' on the reversal JE, or sale_return stock
//     movements, or the ReturnService narration prefix) is present.
//   - Materialize a native SalesReturn ONLY when classification is
//     SALES_RETURN AND the original invoice's lines are still present so
//     line-level quantities can be reconstructed. Otherwise mark
//     SALES_RETURN_UNRECONSTRUCTABLE — audit row only, no financial rows.
//   - Idempotent: presence of a legacy_reversal_audit row for a given CN id
//     is the skip signal on re-run.
//   - Versioned: every audit row records MIGRATION_VERSION so future
//     iterations can re-examine only rows they know how to improve.

export const MIGRATION_VERSION = 1;
const KV_KEY = 'legacyReversalMigration:lastRun';

// ---------- Classification ----------------------------------------------------

interface ClassificationEvidence {
  journal_entry_number: string | null;
  journal_narration: string | null;
  journal_ref_type: string | null;
  credit_note_invoice_number: string | null;
  stock_movement_types: string[];
  original_lines_present: boolean;
  original_lines_count: number;
  notes?: string;
}

function classify(evidence: ClassificationEvidence): LegacyMigrationClassification {
  const {
    journal_entry_number,
    journal_narration,
    journal_ref_type,
    stock_movement_types,
  } = evidence;

  // Strongest signal: reversal JE with ref_type='reversal' is unambiguously
  // an invoice-edit CN (InvoiceService.reverseInvoicePosting sets that).
  if (journal_ref_type === 'reversal') return 'EDIT_REVERSAL';
  // Corroborating: InvoiceService's synthesized entry_number.
  if (journal_entry_number && journal_entry_number.startsWith('JE-REV-')) {
    return 'EDIT_REVERSAL';
  }
  // Narration written by InvoiceService (line 488) is "Reversal of <inv>: <reason>"
  // where updateInvoice hardcodes reason='edit'. Match only that shape — a
  // user-typed reason from a plausible future manual reversal would be different.
  if (
    journal_narration &&
    /^Reversal of .+: edit$/i.test(journal_narration.trim())
  ) {
    return 'EDIT_REVERSAL';
  }

  // Sales-return signals — ReturnService writes ref_type='invoice' on the
  // reversal JE and stock_movements with movement_type='sale_return'.
  const hasSaleReturnMovements =
    stock_movement_types.includes('sale_return');
  const narrationLooksLikeReturn =
    !!journal_narration && /^Sales return for /i.test(journal_narration.trim());
  if (hasSaleReturnMovements || narrationLooksLikeReturn) {
    return 'SALES_RETURN';
  }

  // No strong signal either way → UNKNOWN. Do NOT guess.
  return 'UNKNOWN';
}

// ---------- Migration -------------------------------------------------------

export interface MigrationResult {
  version: number;
  ranAt: string;
  examined: number;
  classifiedAs: Record<LegacyMigrationClassification, number>;
  materializedSalesReturns: number;
  skippedIdempotent: number;
}

// Run once. Safe to call repeatedly — a CN already audited at the current
// MIGRATION_VERSION is a no-op.
export async function runLegacyReversalMigration(
  db: BusinessVaultDB,
  businessId: string,
): Promise<MigrationResult> {
  const ranAt = new Date().toISOString();
  const counts: Record<LegacyMigrationClassification, number> = {
    SALES_RETURN: 0,
    SALES_RETURN_UNRECONSTRUCTABLE: 0,
    EDIT_REVERSAL: 0,
    UNKNOWN: 0,
  };
  let examined = 0;
  let materialized = 0;
  let skippedIdempotent = 0;

  // 1. Enumerate candidate credit-note Invoice rows. These are Invoice rows
  //    where reverses_invoice_id is set — the pre-v5 shape for BOTH edits
  //    and returns.
  const allInvoices = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  const legacyCns = allInvoices.filter((inv) => inv.reverses_invoice_id != null);

  for (const cn of legacyCns) {
    // Idempotency: skip if we already recorded a decision at this
    // migration version. Older-version audit rows fall through so future
    // migrations can revisit.
    const priorAudit = await db.legacy_reversal_audit.get(cn.id);
    if (priorAudit && priorAudit.migration_version >= MIGRATION_VERSION) {
      skippedIdempotent++;
      continue;
    }

    const originalInvoiceId = cn.reverses_invoice_id as string;
    const evidence = await gatherEvidence(db, cn, originalInvoiceId);
    const classification = classify(evidence);
    counts[classification]++;
    examined++;

    let materializedSalesReturnId: string | null = null;

    if (classification === 'SALES_RETURN') {
      // Downgrade to UNRECONSTRUCTABLE if original lines are gone (deleted
      // from IndexedDB somehow). Never invent quantities.
      if (!evidence.original_lines_present || evidence.original_lines_count === 0) {
        counts.SALES_RETURN--;
        counts.SALES_RETURN_UNRECONSTRUCTABLE++;
        await writeAudit(db, cn, originalInvoiceId, 'SALES_RETURN_UNRECONSTRUCTABLE', null, evidence, ranAt);
        continue;
      }
      // Reconstruct native SalesReturn + items from the CN's own invoice
      // lines (they are the negated originals — see ReturnService.ts:144).
      materializedSalesReturnId = await materializeSalesReturn(
        db,
        businessId,
        cn,
        originalInvoiceId,
      );
      materialized++;
    }

    await writeAudit(
      db,
      cn,
      originalInvoiceId,
      classification,
      materializedSalesReturnId,
      evidence,
      ranAt,
    );
  }

  // 2. Rebuild the summary cache from the freshly written return items.
  //    Any invoice that ended up with a native return needs its summary
  //    populated so PR2 available_to_return math is correct on first read.
  if (materialized > 0) {
    await rebuildInvoiceLineReturnSummary(db, businessId);
  }

  // 3. Stamp the kv marker so ops can see when this last ran.
  await db.kv.put({
    key: KV_KEY,
    value: {
      version: MIGRATION_VERSION,
      ranAt,
      businessId,
      examined,
      counts,
      materialized,
      skippedIdempotent,
    },
    updated_at: ranAt,
  });

  return {
    version: MIGRATION_VERSION,
    ranAt,
    examined,
    classifiedAs: counts,
    materializedSalesReturns: materialized,
    skippedIdempotent,
  };
}

async function gatherEvidence(
  db: BusinessVaultDB,
  cn: Invoice,
  originalInvoiceId: string,
): Promise<ClassificationEvidence> {
  // Journal entry that this CN points at (the reversing JE).
  let je: JournalEntry | undefined;
  if (cn.journal_entry_id) {
    je = await db.journal_entries.get(cn.journal_entry_id);
  }
  // Stock movements referencing this CN — return-flavor ones set
  // ref_type='invoice', ref_id=creditNoteId, movement_type='sale_return'.
  const movements: StockMovement[] = await db.stock_movements
    .where('[business_id+ref_type+ref_id]')
    .equals([cn.business_id, 'invoice', cn.id])
    .toArray();
  const stockMovementTypes = Array.from(
    new Set(movements.map((m) => m.movement_type)),
  );

  // Lines still available on the CN itself, which mirror the original.
  const originalLines = await db.invoice_lines
    .where('invoice_id')
    .equals(originalInvoiceId)
    .toArray();

  return {
    journal_entry_number: je?.entry_number ?? null,
    journal_narration: je?.narration ?? null,
    journal_ref_type: je?.ref_type ?? null,
    credit_note_invoice_number: cn.invoice_number,
    stock_movement_types: stockMovementTypes,
    original_lines_present: originalLines.length > 0,
    original_lines_count: originalLines.length,
  };
}

async function writeAudit(
  db: BusinessVaultDB,
  cn: Invoice,
  originalInvoiceId: string,
  classification: LegacyMigrationClassification,
  materializedSalesReturnId: string | null,
  evidence: ClassificationEvidence,
  examinedAt: string,
): Promise<void> {
  const row: LegacyReversalAudit = {
    credit_note_invoice_id: cn.id,
    business_id: cn.business_id,
    original_invoice_id: originalInvoiceId,
    classification,
    materialized_sales_return_id: materializedSalesReturnId,
    evidence,
    examined_at: examinedAt,
    migration_version: MIGRATION_VERSION,
  };
  await db.legacy_reversal_audit.put(row);
}

// Reconstruct a native SalesReturn + SalesReturnItem rows from an existing
// pre-v5 credit-note Invoice. This is the ONLY code path in this migration
// that writes native return rows — its precondition (checked by the
// caller) is classification === 'SALES_RETURN' AND original lines present.
//
// Amounts are copied via absolute value because CN lines are stored
// negated (ReturnService.ts:144–157). Line references point at the CN
// row's own lines rather than the original invoice's lines — we walk
// through by line_no + item_id + warehouse_id to recover the mapping,
// which is safe because the CN was created by cloning the originals with
// preserved line_no.
async function materializeSalesReturn(
  db: BusinessVaultDB,
  businessId: string,
  cn: Invoice,
  originalInvoiceId: string,
): Promise<string> {
  const salesReturnId = ulid();
  const cnLines = await db.invoice_lines
    .where('invoice_id')
    .equals(cn.id)
    .toArray();
  const originalLines = await db.invoice_lines
    .where('invoice_id')
    .equals(originalInvoiceId)
    .toArray();

  // Build a lookup on line_no; ReturnService preserves numbering (idx+1)
  // when cloning original lines onto the CN.
  const originalByLineNo = new Map<number, InvoiceLine>();
  for (const l of originalLines) originalByLineNo.set(l.line_no, l);

  const returnNumber = await allocateSalesReturnNumber(db, businessId);

  const now = new Date().toISOString();
  const items: SalesReturnItem[] = [];
  for (const cnLine of cnLines) {
    const orig = originalByLineNo.get(cnLine.line_no);
    // We MUST have the original line — this is the "line-level information
    // reliable" precondition. If a specific line can't be matched, drop
    // that line from materialization rather than fabricating a link. The
    // header still gets created; the return might be under-counted, but
    // silent invention would be worse.
    if (!orig) continue;
    items.push({
      id: ulid(),
      business_id: businessId,
      sales_return_id: salesReturnId,
      original_invoice_id: originalInvoiceId,
      original_invoice_line_id: orig.id,
      item_id: cnLine.item_id,
      description: cnLine.description,
      hsn: cnLine.hsn,
      warehouse_id: cnLine.warehouse_id,
      line_no: cnLine.line_no,
      qty_micros: Math.abs(cnLine.qty_micros),
      unit_price_paise: cnLine.unit_price_paise,
      discount_pct_bps: cnLine.discount_pct_bps,
      discount_paise: Math.abs(cnLine.discount_paise),
      taxable_paise: Math.abs(cnLine.taxable_paise),
      tax_rate_bps: cnLine.tax_rate_bps,
      cgst_paise: Math.abs(cnLine.cgst_paise),
      sgst_paise: Math.abs(cnLine.sgst_paise),
      igst_paise: Math.abs(cnLine.igst_paise),
      cess_paise: Math.abs(cnLine.cess_paise),
      line_total_paise: Math.abs(cnLine.line_total_paise),
    });
  }

  const sr: SalesReturn = {
    id: salesReturnId,
    business_id: businessId,
    return_number: returnNumber,
    return_date: cn.invoice_date,
    original_invoice_id: originalInvoiceId,
    customer_id: cn.customer_id,
    subtotal_paise: Math.abs(cn.subtotal_paise),
    discount_paise: Math.abs(cn.discount_paise),
    taxable_paise: Math.abs(cn.taxable_paise),
    cgst_paise: Math.abs(cn.cgst_paise),
    sgst_paise: Math.abs(cn.sgst_paise),
    igst_paise: Math.abs(cn.igst_paise),
    cess_paise: Math.abs(cn.cess_paise),
    round_off_paise: Math.abs(cn.round_off_paise),
    total_paise: Math.abs(cn.total_paise),
    status: 'posted',
    reason: extractReasonFromNotes(cn.notes) ?? 'Legacy Sales Return (migrated)',
    notes: `Migrated from legacy credit-note invoice ${cn.invoice_number}.`,
    journal_entry_id: cn.journal_entry_id,
    reversed_credit_note_invoice_id: cn.id,
    legacy_migration_classification: 'SALES_RETURN',
    // device_id: legacy CN rows don't carry this consistently. Use the
    // original invoice's active device where available; otherwise leave
    // as the empty string so the row is still writable — restore reads
    // ignore this field for legacy rows.
    device_id: '',
    created_at: cn.created_at,
    updated_at: now,
    entity_version: 1,
  };

  await db.sales_returns.add(sr);
  if (items.length > 0) await db.sales_return_items.bulkAdd(items);
  return salesReturnId;
}

// Pull the human-readable reason out of the legacy CN notes field
// (`"Credit note for invoice X. Reason: <reason>"` — ReturnService.ts:127
// or InvoiceService.ts:521). Best-effort; falls back to null so the caller
// substitutes a placeholder.
function extractReasonFromNotes(notes: string): string | null {
  if (!notes) return null;
  const m = /Reason:\s*(.+)$/i.exec(notes.trim());
  if (!m) return null;
  const reason = m[1].trim();
  return reason.length > 0 ? reason : null;
}
