import type { BusinessVaultDB } from '../db';
import { log } from '../lib/log';

// Feedback §3 / §4: invoice-number lifecycle.
//
// §3 — the Edit Invoice screen must allow changing the invoice number. Uniqueness
// is validated within (business, prefix/series, financial_year). Numbers are
// text labels only — foreign-key relationships never reference the number, so
// renaming is safe.
//
// §4 — a number belonging to a recycled invoice (deleted_at != null) is
// considered released back into the pool. The next auto-allocated number will
// pick the lowest released gap (`prefix-seq`) before falling back to
// `invoice_next_seq`. Restore-conflict handling is in InvoiceService.restoreInvoice.
//
// A "released" number is one where every invoice bearing it has `deleted_at`
// set. Any live (deleted_at == null) invoice keeps the number locked.

const MAX_SCAN = 10_000;
const NUMBER_PATTERN = /^([A-Za-z0-9_\-\/]+)-(\d+)$/;

function pad(seq: number): string {
  return String(seq).padStart(6, '0');
}

/**
 * Format sanity check for a proposed invoice number.
 *
 * Enforces the same shape as auto-allocation (`PREFIX-\d+`) so party ledgers,
 * search, and financial-year sort remain stable. Format-only — does NOT hit
 * the DB. Combine with `isInvoiceNumberAvailable` for the full uniqueness
 * check.
 */
export function validateInvoiceNumber(
  invoiceNumber: string,
  expectedPrefix?: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = (invoiceNumber ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Invoice number is required.' };
  if (trimmed.length > 40) {
    return { ok: false, error: 'Invoice number is too long (max 40 characters).' };
  }
  const m = NUMBER_PATTERN.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      error: 'Invoice number must be "PREFIX-<digits>" (e.g. INV-000123).',
    };
  }
  if (expectedPrefix && m[1] !== expectedPrefix) {
    return {
      ok: false,
      error: `Invoice number must start with the "${expectedPrefix}-" series.`,
    };
  }
  return { ok: true };
}

/**
 * True iff no LIVE invoice in this business currently uses `invoiceNumber`.
 *
 * A recycled invoice (deleted_at != null) does NOT count — its number is
 * released back into the pool per §4. If `excludeInvoiceId` is set, that row
 * is also ignored (used by updateInvoice when the user re-saves without
 * changing the number).
 */
export async function isInvoiceNumberAvailable(
  db: BusinessVaultDB,
  businessId: string,
  invoiceNumber: string,
  excludeInvoiceId?: string,
): Promise<boolean> {
  const rows = await db.invoices
    .where('[business_id+invoice_number]')
    .equals([businessId, invoiceNumber])
    .toArray();
  for (const row of rows) {
    if (excludeInvoiceId && row.id === excludeInvoiceId) continue;
    if (row.reversed_by_invoice_id) continue; // superseded by an edit; the reissue owns the number
    if (row.deleted_at) continue; // §4: recycled ⇒ released
    return false;
  }
  return true;
}

/**
 * Compute the next auto-allocation candidate WITHOUT bumping the counter.
 *
 * Scans for the lowest recycled-gap number (a `prefix-N` where every row
 * bearing it is deleted_at != null) below `invoice_next_seq`, then falls
 * back to `invoice_next_seq` if no gap is reusable. Read-only — used by the
 * form to preview the number before save.
 */
export async function getNextAvailableInvoiceNumber(
  db: BusinessVaultDB,
  businessId: string,
): Promise<string> {
  const biz = await db.businesses.get(businessId);
  if (!biz) throw new Error('Business not found');
  const prefix = biz.invoice_prefix || 'INV';
  const nextSeq = biz.invoice_next_seq;

  // Pull every invoice for this business that matches the prefix. Volumes are
  // small enough (per-business, single-tenant PWA) that a full scan is
  // cheaper than N point-lookups; a business with tens of thousands of rows
  // still costs O(rows) here, not O(seq).
  const all = await db.invoices.where('business_id').equals(businessId).toArray();
  const byNumber = new Map<string, { anyLive: boolean }>();
  for (const inv of all) {
    if (!inv.invoice_number.startsWith(`${prefix}-`)) continue;
    const entry = byNumber.get(inv.invoice_number) ?? { anyLive: false };
    const live = !inv.deleted_at && !inv.reversed_by_invoice_id;
    if (live) entry.anyLive = true;
    byNumber.set(inv.invoice_number, entry);
  }

  // Scan seq 1..(nextSeq-1) for the lowest number that either doesn't exist
  // or exists only as recycled/superseded rows.
  for (let seq = 1; seq < nextSeq; seq++) {
    const candidate = `${prefix}-${pad(seq)}`;
    const entry = byNumber.get(candidate);
    if (!entry || !entry.anyLive) {
      log.info('invoice_numbering', 'reusing recycled gap', {
        businessId,
        candidate,
        nextSeq,
        rowsAtCandidate: entry ? 1 : 0,
      });
      return candidate;
    }
  }
  return `${prefix}-${pad(nextSeq)}`;
}

// Allocate an invoice number and reserve it (bumps `invoice_next_seq` if the
// number is at or past the current counter).
//
// Prefers the lowest recycled-gap slot (§4). If a gap is used, the counter is
// left untouched — a subsequent allocation will still walk to `invoice_next_seq`.
// If the counter itself is taken (drift after restore), scan forward until a
// slot is free, bounded by MAX_SCAN.
//
// Runs one Dexie rw tx spanning `businesses` + `invoices` so the seq bump and
// the collision scan are atomic together.
export async function allocateInvoiceNumber(
  db: BusinessVaultDB,
  businessId: string,
): Promise<string> {
  return db.transaction('rw', [db.businesses, db.invoices], async () => {
    const biz = await db.businesses.get(businessId);
    if (!biz) throw new Error('Business not found');
    const prefix = biz.invoice_prefix || 'INV';
    const nextSeq = biz.invoice_next_seq;

    // Preferred path: reuse a recycled-gap slot below the counter.
    const all = await db.invoices
      .where('business_id')
      .equals(businessId)
      .toArray();
    const byNumber = new Map<string, { anyLive: boolean }>();
    for (const inv of all) {
      if (!inv.invoice_number.startsWith(`${prefix}-`)) continue;
      const entry = byNumber.get(inv.invoice_number) ?? { anyLive: false };
      const live = !inv.deleted_at && !inv.reversed_by_invoice_id;
      if (live) entry.anyLive = true;
      byNumber.set(inv.invoice_number, entry);
    }
    for (let seq = 1; seq < nextSeq; seq++) {
      const candidate = `${prefix}-${pad(seq)}`;
      const entry = byNumber.get(candidate);
      if (!entry || !entry.anyLive) {
        log.info('invoice_numbering', 'allocated from recycled gap', {
          businessId,
          candidate,
          nextSeq,
        });
        // Counter is untouched: the gap is below it. No update needed.
        return candidate;
      }
    }

    // Fallback: walk forward from invoice_next_seq past any drift-collisions.
    let seq = nextSeq;
    for (let i = 0; i < MAX_SCAN; i++) {
      const candidate = `${prefix}-${pad(seq)}`;
      const entry = byNumber.get(candidate);
      if (!entry || !entry.anyLive) {
        await db.businesses.update(businessId, {
          invoice_next_seq: seq + 1,
          updated_at: new Date().toISOString(),
        });
        log.info('invoice_numbering', 'allocated from counter', {
          businessId,
          candidate,
          previousNextSeq: nextSeq,
          newNextSeq: seq + 1,
        });
        return candidate;
      }
      seq++;
    }
    throw new Error(
      `Could not allocate an unused invoice number after ${MAX_SCAN} attempts.`,
    );
  });
}
