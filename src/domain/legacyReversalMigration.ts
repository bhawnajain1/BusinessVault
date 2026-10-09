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
import { appendSyncEvent } from './syncEventLog';

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

  // Older builds sometimes persisted the CN without the reversal JE metadata.
  // The generated invoice number and note still identify the edit shape. Keep
  // this fallback strict and reject any record carrying return evidence.
  const looksLikeLegacyEditCreditNote =
    !!evidence.credit_note_invoice_number && /-CN$/i.test(evidence.credit_note_invoice_number) &&
    !!evidence.notes && /reason:\s*edit\b/i.test(evidence.notes);
  if (
    looksLikeLegacyEditCreditNote &&
    stock_movement_types.every((type) => type !== 'sale_return') &&
    !journal_narration?.trim().startsWith('Sales return for ')
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

export interface InvoiceEditRepairCandidate {
  creditNote: Invoice;
  original: Invoice;
  latestInvoice: Invoice;
  reversalJournal: JournalEntry | null;
  reversalStockMovementCount: number;
}

export interface InvoiceEditRepairResult {
  examined: number;
  repaired: number;
  skipped: number;
  candidates: InvoiceEditRepairCandidate[];
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

/**
 * Finds old edit-generated CN rows without changing data. Only rows with the
 * same deterministic evidence used by the legacy classifier are returned.
 */
export async function findInvoiceEditRepairCandidates(
  db: BusinessVaultDB,
  businessId: string,
): Promise<InvoiceEditRepairCandidate[]> {
  const invoices = await db.invoices.where('business_id').equals(businessId).toArray();
  const candidates: InvoiceEditRepairCandidate[] = [];
  for (const creditNote of invoices.filter((row) => row.reverses_invoice_id != null)) {
    const original = await db.invoices.get(creditNote.reverses_invoice_id!);
    if (!original) continue;
    const evidence = await gatherEvidence(db, creditNote, original.id);
    if (classify(evidence) !== 'EDIT_REVERSAL') continue;
    const successors = invoices.filter(
      (row) =>
        row.id !== creditNote.id &&
        row.id !== original.id &&
        row.invoice_number === original.invoice_number &&
        row.created_at > original.created_at &&
        row.reverses_invoice_id == null,
    );
    successors.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (successors.length === 0) continue;
    const reversalJournal = creditNote.journal_entry_id
      ? (await db.journal_entries.get(creditNote.journal_entry_id)) ?? null
      : null;
    const reversalStockMovementCount = await db.stock_movements
      .where('[business_id+ref_type+ref_id]')
      .equals([businessId, 'reversal', creditNote.id])
      .count();
    candidates.push({
      creditNote,
      original,
      latestInvoice: successors[0],
      reversalJournal,
      reversalStockMovementCount,
    });
  }
  return candidates.sort((a, b) => a.creditNote.created_at.localeCompare(b.creditNote.created_at));
}

/**
 * Removes only obsolete edit-generated invoice/CN headers and lines. Journal
 * and stock reversal rows remain immutable, so the old posting stays exactly
 * cancelled and the latest edited invoice remains the active bill.
 */
export async function repairInvoiceEditCreditNotes(
  db: BusinessVaultDB,
  businessId: string,
  deviceId: string,
): Promise<InvoiceEditRepairResult> {
  const candidates = await findInvoiceEditRepairCandidates(db, businessId);
  const repairedAuditRows = await db.audit_log
    .where('business_id')
    .equals(businessId)
    .filter((row) => row.action === 'invoice.edit_credit_note_repaired')
    .toArray();
  const previouslyRepairedIds = new Set(
    repairedAuditRows
      .map((row) => (row.before as { credit_note_invoice_id?: unknown })?.credit_note_invoice_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const repairedRows = await db.invoices
    .where('business_id')
    .equals(businessId)
    .filter((invoice) => previouslyRepairedIds.has(invoice.id))
    .toArray();
  for (const repairedRow of repairedRows) {
    await db.invoice_lines.where('invoice_id').equals(repairedRow.id).delete();
    await db.invoices.delete(repairedRow.id);
  }
  let repaired = 0;
  for (const candidate of candidates) {
    await db.transaction(
      'rw',
      [db.invoices, db.invoice_lines, db.journal_entries, db.audit_log, db.sync_events],
      async () => {
        const currentCn = await db.invoices.get(candidate.creditNote.id);
        if (!currentCn || currentCn.reverses_invoice_id == null) return;
        const journalIdsToExclude = [
          currentCn.journal_entry_id,
          candidate.latestInvoice.journal_entry_id !== candidate.original.journal_entry_id
            ? candidate.reversalJournal?.reverses_id ?? candidate.original.journal_entry_id
            : null,
        ].filter((id): id is string => !!id);
        for (const journalId of journalIdsToExclude) {
          const journal = await db.journal_entries.get(journalId);
          if (!journal || journal.posted !== 1) continue;
          const updatedJournal = {
            ...journal,
            posted: 0,
            updated_at: new Date().toISOString(),
            entity_version: journal.entity_version + 1,
          };
          await db.journal_entries.put(updatedJournal);
          await appendSyncEvent(db, {
            businessId,
            deviceId,
            entityType: 'journal_entry',
            entityId: journalId,
            operation: 'updated',
            payload: updatedJournal,
            timestamp: updatedJournal.updated_at,
          });
        }
        await db.invoice_lines.where('invoice_id').equals(currentCn.id).delete();
        await db.invoices.delete(currentCn.id);
        await db.invoices.update(candidate.original.id, {
          reversed_by_invoice_id: candidate.latestInvoice.id,
          updated_at: new Date().toISOString(),
          entity_version: candidate.original.entity_version + 1,
        });
        await appendSyncEvent(db, {
          businessId,
          deviceId,
          entityType: 'invoice',
          entityId: candidate.original.id,
          operation: 'updated',
          payload: {
            id: candidate.original.id,
            reversed_by_invoice_id: candidate.latestInvoice.id,
            updated_at: new Date().toISOString(),
            entity_version: candidate.original.entity_version + 1,
          },
          timestamp: new Date().toISOString(),
        });
        await db.audit_log.add({
          id: ulid(),
          business_id: businessId,
          device_id: deviceId,
          actor: 'invoice-edit-repair',
          action: 'invoice.edit_credit_note_repaired',
          entity_type: 'invoice',
          entity_id: candidate.original.id,
          before: {
            credit_note_invoice_id: currentCn.id,
            credit_note_invoice_number: currentCn.invoice_number,
            original_invoice_id: candidate.original.id,
          },
          after: {
            retained_original_invoice_id: candidate.original.id,
            retained_latest_invoice_id: candidate.latestInvoice.id,
            retained_reversal_journal_id: currentCn.journal_entry_id,
            retained_reversal_stock_movement_count: candidate.reversalStockMovementCount,
          },
          at: new Date().toISOString(),
        });
        await appendSyncEvent(db, {
          businessId,
          deviceId,
          entityType: 'invoice',
          entityId: currentCn.id,
          operation: 'deleted',
          payload: { id: currentCn.id, repaired_edit_credit_note: true },
          timestamp: new Date().toISOString(),
        });
        repaired++;
      },
    );
  }
  return { examined: candidates.length, repaired, skipped: 0, candidates };
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
    notes: cn.notes,
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
      uqc_code: cnLine.uqc_code ?? orig.uqc_code ?? null,
      goods_or_service: cnLine.goods_or_service ?? orig.goods_or_service ?? null,
      taxability: cnLine.taxability ?? orig.taxability ?? null,
      cess_rate_bps: cnLine.cess_rate_bps ?? orig.cess_rate_bps ?? null,
      snapshot_source: 'LEGACY_INFERRED',
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
    // Legacy CNs predate v6's round_off_mode split. Their round_off was
    // either 0 (bookkeeping-side) or auto-derived by POS in older builds;
    // classifying migrated legacy rows as 'auto' matches the historical
    // behaviour and keeps pre_round + round_off == total invariant.
    round_off_mode: 'auto',
    pre_round_total_paise: Math.abs(cn.total_paise) - Math.abs(cn.round_off_paise),
    total_paise: Math.abs(cn.total_paise),
    // Legacy CN reversals had no advance-credit concept — the full amount
    // reduced the invoice's balance. Preserve that on the header so a future
    // cancel path reconstructs the correct split.
    apply_to_balance_paise: Math.abs(cn.total_paise),
    customer_credit_paise: 0,
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
