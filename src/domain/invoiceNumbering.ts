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
// Invoice numbers are user-facing labels. They may be numeric (7652),
// prefixed numeric (INV-7652), or alphanumeric (SI7652).
const NUMBER_PATTERN = /^([A-Za-z][A-Za-z0-9_\/\-]*?)(?:-)?(\d+)$/;

function formatSequence(sequence: number, width: number): string {
  return String(sequence).padStart(width, '0');
}

export function parseInvoiceNumber(
  invoiceNumber: string,
): { prefix: string; sequence: number } | null {
  const trimmed = invoiceNumber.trim();
  if (/^\d+$/.test(trimmed)) {
    const sequence = Number(trimmed);
    return Number.isSafeInteger(sequence) ? { prefix: '', sequence } : null;
  }
  const match = NUMBER_PATTERN.exec(trimmed);
  if (!match) return null;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) ? { prefix: match[1], sequence } : null;
}

function formatInvoiceNumber(prefix: string, sequence: number, width = 3): string {
  return `${prefix}${formatSequence(sequence, width)}`;
}

function legacyFormatInvoiceNumber(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(6, '0')}`;
}

function parsedPrefixForSeries(prefix: string): string {
  return prefix.endsWith('-') ? prefix.slice(0, -1) : prefix;
}

function seriesFormat(
  rows: Array<{ invoice_number: string; created_at?: string }>,
  prefix: string,
): { legacy: boolean; prefix: string; width: number } {
  const normalizedPrefix = parsedPrefixForSeries(prefix);
  const seriesRows = rows
    .map((row) => ({ row, parsed: parseInvoiceNumber(row.invoice_number) }))
    .filter(
      ({ parsed }) => parsed?.prefix === normalizedPrefix,
    )
    .sort((a, b) => {
      const createdDelta = (b.row.created_at ?? '').localeCompare(a.row.created_at ?? '');
      if (createdDelta !== 0) return createdDelta;
      return (b.parsed?.sequence ?? 0) - (a.parsed?.sequence ?? 0);
    });
  if (seriesRows.length === 0) {
    return { legacy: false, prefix, width: 3 };
  }
  const number = seriesRows[0].row.invoice_number.trim();
  const match = number.match(/(\d+)$/);
  const digits = match?.[1] ?? '';
  const parsed = seriesRows[0].parsed!;
  const separator = number.slice(parsed.prefix.length, number.length - digits.length);
  const formattedPrefix = `${parsed.prefix}${separator}`;
  return {
    legacy: separator === '-' && digits.length >= 6,
    prefix: formattedPrefix,
    width: digits.length || 3,
  };
}

function nextSequenceForFormat(
  rows: Array<{ invoice_number: string }>,
  format: { prefix: string; width: number },
  fallback: number,
): number {
  let highest = 0;
  let matchingRows = 0;
  for (const row of rows) {
    const parsed = parseInvoiceNumber(row.invoice_number);
    if (!parsed || parsed.prefix !== parsedPrefixForSeries(format.prefix)) continue;
    const digits = row.invoice_number.trim().match(/(\d+)$/)?.[1] ?? '';
    const separator = row.invoice_number.trim().slice(
      parsed.prefix.length,
      row.invoice_number.trim().length - digits.length,
    );
    if (`${parsed.prefix}${separator}` !== format.prefix || digits.length !== format.width) {
      continue;
    }
    matchingRows++;
    highest = Math.max(highest, parsed.sequence);
  }
  return matchingRows === 0 ? fallback : highest + 1;
}

/**
 * Format sanity check for a proposed invoice number.
 *
   * Enforces the same shape as auto-allocation (`PREFIX\d+`) so party ledgers,
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
  const parsed = parseInvoiceNumber(trimmed);
  if (!parsed && !/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Invoice number must be numeric or alphanumeric (e.g. 7652 or INV-7652).',
    };
  }
  if (expectedPrefix && parsed && parsed.prefix !== expectedPrefix && parsed.prefix !== `${expectedPrefix}-`) {
    return {
      ok: false,
      error: `Invoice number must start with the "${expectedPrefix}" series.`,
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

function latestInvoiceFormat(
  rows: Array<{ invoice_number: string; created_at?: string }>,
  fallbackPrefix: string,
  fallbackSequence: number,
): { prefix: string; width: number; sequence: number } {
  const latest = [...rows]
    .map((row) => ({ row, parsed: parseInvoiceNumber(row.invoice_number) }))
    .filter(({ parsed }) => parsed !== null)
    .sort((a, b) => (b.row.created_at ?? '').localeCompare(a.row.created_at ?? ''))[0];
  if (!latest?.parsed) {
    return { prefix: fallbackPrefix, width: 3, sequence: fallbackSequence };
  }
  const number = latest.row.invoice_number.trim();
  const digits = number.match(/(\d+)$/)?.[1] ?? '';
  const separator = number.slice(
    latest.parsed.prefix.length,
    number.length - digits.length,
  );
  return {
    prefix: `${latest.parsed.prefix}${separator}`,
    width: digits.length || 3,
    sequence: latest.parsed.sequence,
  };
}

/** Compute the next number from the most recently entered invoice number. */
export async function getNextAvailableInvoiceNumber(
  db: BusinessVaultDB,
  businessId: string,
): Promise<string> {
  const biz = await db.businesses.get(businessId);
  if (!biz) throw new Error('Business not found');
  const prefix = biz.invoice_prefix ?? 'INV';
  const nextSeq = biz.invoice_next_seq;

  // Pull every invoice for this business that matches the prefix. Volumes are
  // small enough (per-business, single-tenant PWA) that a full scan is
  // cheaper than N point-lookups; a business with tens of thousands of rows
  // still costs O(rows) here, not O(seq).
  const all = await db.invoices.where('business_id').equals(businessId).toArray();
  const latest = latestInvoiceFormat(all, prefix, nextSeq - 1);
  const seriesNextSeq = latest.sequence + 1;
  log.info('invoice_numbering', 'previewing next number', {
    businessId,
    seriesPrefix: latest.prefix,
    digitWidth: latest.width,
    nextSeq: seriesNextSeq,
  });
  return formatInvoiceNumber(latest.prefix, seriesNextSeq, latest.width);
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
    const prefix = biz.invoice_prefix ?? 'INV';
    const nextSeq = biz.invoice_next_seq;

    // Preferred path: reuse a recycled-gap slot below the counter.
    const all = await db.invoices
      .where('business_id')
      .equals(businessId)
      .toArray();
    const latest = latestInvoiceFormat(all, prefix, nextSeq - 1);
    const seriesNextSeq = latest.sequence + 1;
    log.info('invoice_numbering', 'allocating number', {
      businessId,
      seriesPrefix: latest.prefix,
      digitWidth: latest.width,
      nextSeq: seriesNextSeq,
    });
    const byNumber = new Map<string, { anyLive: boolean }>();
    for (const inv of all) {
      const parsed = parseInvoiceNumber(inv.invoice_number);
      if (!parsed) continue;
      const entry = byNumber.get(inv.invoice_number) ?? { anyLive: false };
      const live = !inv.deleted_at && !inv.reversed_by_invoice_id;
      if (live) entry.anyLive = true;
      byNumber.set(inv.invoice_number, entry);
    }
    let seq = seriesNextSeq;
    for (let i = 0; i < MAX_SCAN; i++) {
      const candidate = formatInvoiceNumber(latest.prefix, seq, latest.width);
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
