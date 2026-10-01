import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db';
import type { AuditLogEntry, Invoice, Payment, Advance, SalesReturn } from '../db/types';
import { appendSyncEvent } from './syncEventLog';

export const LEGACY_EDIT_REPAIR_VERSION = 1;
export const LEGACY_EDIT_REPAIR_REASON = 'Legacy invoice edit repair';

export interface LegacyEditRepairCandidate {
  originalInvoiceId: string;
  creditNoteInvoiceId: string;
  replacementInvoiceId: string | null;
  invoiceNumber: string;
  originalTotalPaise: number;
  replacementTotalPaise: number | null;
  confidence: 'high' | 'ambiguous' | 'unsafe' | 'missing';
  reasons: string[];
}

export interface LegacyEditRepairResult {
  version: number;
  dryRun: boolean;
  examined: number;
  repaired: number;
  skipped: number;
  candidates: LegacyEditRepairCandidate[];
}

/**
 * Repairs the pre-in-place-edit shape without rewriting accounting history.
 * Dry-run is the default. Only an unambiguous, unpaid, unreturned pair is
 * automatically repaired when apply=true.
 */
export async function repairLegacyInvoiceEdits(
  db: BusinessVaultDB,
  businessId: string,
  options: { apply?: boolean } = {},
): Promise<LegacyEditRepairResult> {
  const dryRun = options.apply !== true;
  const invoices = await db.invoices.where('business_id').equals(businessId).toArray();
  const candidates: LegacyEditRepairCandidate[] = [];
  let repaired = 0;

  for (const creditNote of invoices.filter((invoice) =>
    !invoice.deleted_at && invoice.reverses_invoice_id && invoice.invoice_number.endsWith('-CN'),
  )) {
    const original = invoices.find((invoice) => invoice.id === creditNote.reverses_invoice_id);
    if (!original) {
      candidates.push(candidateFor(creditNote, null, null, 'missing', ['Original invoice is missing.']));
      continue;
    }
    const replacementMatches = invoices.filter((invoice) =>
      invoice.id !== original.id &&
      invoice.id !== creditNote.id &&
      !invoice.reverses_invoice_id &&
      !invoice.reversed_by_invoice_id &&
      !invoice.deleted_at &&
      invoice.invoice_number === original.invoice_number &&
      invoice.customer_id === original.customer_id &&
      invoice.created_at >= creditNote.created_at,
    );
    const reasons: string[] = [];
    const reversalJournal = await db.journal_entries.get(creditNote.journal_entry_id);
    if (reversalJournal?.ref_type !== 'reversal' && !reversalJournal?.entry_number.startsWith('JE-REV-')) {
      reasons.push('Credit note is not linked to a deterministic edit-reversal journal.');
    }
    if (original.paid_paise > 0 || creditNote.paid_paise > 0) {
      reasons.push('Original or credit note has payments recorded.');
    }
    if (await hasPaymentOrAdvanceReference(db, businessId, original.id)) {
      reasons.push('A payment or advance allocation references the original invoice.');
    }
    if (await hasReturnReference(db, original.id)) {
      reasons.push('A sales return references the original invoice.');
    }
    if (replacementMatches.length === 0) {
      reasons.push('No replacement invoice with the same number and customer was found.');
    }
    if (replacementMatches.length > 1) {
      reasons.push(`Found ${replacementMatches.length} possible replacement invoices.`);
    }
    const replacement = replacementMatches.length === 1 ? replacementMatches[0] : null;
    const confidence = replacementMatches.length > 1
      ? 'ambiguous'
      : reasons.length === 0
        ? 'high'
        : 'unsafe';
    const candidate = candidateFor(creditNote, original, replacement, confidence, reasons);
    candidates.push(candidate);
    if (dryRun || confidence !== 'high' || !replacement) continue;
    await applyRepair(db, businessId, original, creditNote, replacement);
    repaired++;
  }

  return {
    version: LEGACY_EDIT_REPAIR_VERSION,
    dryRun,
    examined: candidates.length,
    repaired,
    skipped: candidates.length - repaired,
    candidates,
  };
}

function candidateFor(
  creditNote: Invoice,
  original: Invoice | null,
  replacement: Invoice | null,
  confidence: LegacyEditRepairCandidate['confidence'],
  reasons: string[],
): LegacyEditRepairCandidate {
  return {
    originalInvoiceId: original?.id ?? creditNote.reverses_invoice_id ?? '',
    creditNoteInvoiceId: creditNote.id,
    replacementInvoiceId: replacement?.id ?? null,
    invoiceNumber: original?.invoice_number ?? creditNote.invoice_number,
    originalTotalPaise: original?.total_paise ?? 0,
    replacementTotalPaise: replacement?.total_paise ?? null,
    confidence,
    reasons,
  };
}

async function hasPaymentOrAdvanceReference(
  db: BusinessVaultDB,
  businessId: string,
  invoiceId: string,
): Promise<boolean> {
  const payments = await db.payments.where('business_id').equals(businessId).toArray();
  if (payments.some((payment: Payment) => payment.allocations.some((allocation) => allocation.invoice_id === invoiceId))) return true;
  const advances = await db.advances.where('business_id').equals(businessId).toArray();
  return advances.some((advance: Advance) => advance.applications.some((application) => application.invoice_id === invoiceId));
}

async function hasReturnReference(db: BusinessVaultDB, invoiceId: string): Promise<boolean> {
  const returns = (await db.sales_returns.toArray()).filter(
    (salesReturn) => salesReturn.original_invoice_id === invoiceId,
  );
  return returns.some((salesReturn: SalesReturn) => !salesReturn.deleted_at);
}

async function applyRepair(
  db: BusinessVaultDB,
  businessId: string,
  original: Invoice,
  creditNote: Invoice,
  replacement: Invoice,
): Promise<void> {
  const now = new Date().toISOString();
  const originalAfter = { ...original, deleted_at: now, deleted_reason: LEGACY_EDIT_REPAIR_REASON, updated_at: now, entity_version: original.entity_version + 1 };
  const creditNoteAfter = { ...creditNote, deleted_at: now, deleted_reason: LEGACY_EDIT_REPAIR_REASON, updated_at: now, entity_version: creditNote.entity_version + 1 };
  await db.transaction('rw', [db.invoices, db.audit_log, db.sync_events], async () => {
    await db.invoices.put(originalAfter);
    await db.invoices.put(creditNoteAfter);
    await appendSyncEvent(db, { businessId, deviceId: 'system', entityType: 'invoice', entityId: original.id, operation: 'updated', payload: originalAfter, timestamp: now });
    await appendSyncEvent(db, { businessId, deviceId: 'system', entityType: 'invoice', entityId: creditNote.id, operation: 'updated', payload: creditNoteAfter, timestamp: now });
    const audit: AuditLogEntry = {
      id: ulid(), business_id: businessId, device_id: 'system', actor: 'system',
      action: 'legacy_invoice_edit_repair', entity_type: 'invoice', entity_id: replacement.id,
      before: { original_invoice_id: original.id, credit_note_invoice_id: creditNote.id },
      after: { replacement_invoice_id: replacement.id, original_deleted_at: now, credit_note_deleted_at: now, version: LEGACY_EDIT_REPAIR_VERSION },
      at: now,
    };
    await db.audit_log.add(audit);
  });
}
