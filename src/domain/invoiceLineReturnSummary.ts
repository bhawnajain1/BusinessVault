import type { BusinessVaultDB } from '../db';
import type {
  InvoiceLineReturnSummary,
  SalesReturn,
  SalesReturnItem,
} from '../db/types';

// Authoritative returned-quantity per invoice line lives in
// sales_return_items — this table (invoice_line_return_summary) is only a
// cache to avoid re-summing on every eligibility check. Anything that writes
// sales_return_items MUST also update the corresponding summary row within
// the same tx (see SalesReturnService, forthcoming in PR2).
//
// Rebuild callers today:
//   - Legacy-reversal migration (PR1) after backfilling historical returns.
//   - Google Drive restore (PR3) after restoring sales_return_items from
//     CSV — we recompute rather than trust an exported summary.
//   - Tests: reconciliation invariant (summary === SUM(active items)).
//
// A return is "financially active" when the parent SalesReturn has
// status='posted' AND deleted_at IS NULL. Cancelled or soft-deleted returns
// must not reduce available_to_return. The union of those two filters is
// applied here (single source of truth for what counts).

function isActiveReturn(sr: SalesReturn | undefined): boolean {
  if (!sr) return false;
  if (sr.status !== 'posted') return false;
  if (sr.deleted_at != null) return false;
  return true;
}

// Rebuild the summary for a single invoice, OR (invoiceId omitted) for every
// invoice in the given business. Idempotent — replaces the cache with fresh
// values computed from sales_return_items.
export async function rebuildInvoiceLineReturnSummary(
  db: BusinessVaultDB,
  businessId: string,
  invoiceId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(
    'rw',
    [
      db.sales_returns,
      db.sales_return_items,
      db.invoice_line_return_summary,
    ],
    async () => {
      // Load the SalesReturn rows we'll need to gate active-ness. Small
      // volume; single scan.
      const returns = invoiceId
        ? await db.sales_returns
            .where('[business_id+original_invoice_id]')
            .equals([businessId, invoiceId])
            .toArray()
        : await db.sales_returns
            .where('business_id')
            .equals(businessId)
            .toArray();
      const activeReturnIds = new Set<string>(
        returns.filter(isActiveReturn).map((r) => r.id),
      );

      // Fetch matching items in one pass.
      const items: SalesReturnItem[] = invoiceId
        ? await db.sales_return_items
            .where('original_invoice_id')
            .equals(invoiceId)
            .toArray()
        : await db.sales_return_items
            .where('business_id')
            .equals(businessId)
            .toArray();

      // Aggregate by original_invoice_line_id.
      const bucket = new Map<
        string,
        { invoice_id: string; total: number }
      >();
      for (const it of items) {
        if (!activeReturnIds.has(it.sales_return_id)) continue;
        const cur = bucket.get(it.original_invoice_line_id);
        if (cur) {
          cur.total += it.qty_micros;
        } else {
          bucket.set(it.original_invoice_line_id, {
            invoice_id: it.original_invoice_id,
            total: it.qty_micros,
          });
        }
      }

      // Wipe out the cache for the scope we're recomputing.
      if (invoiceId) {
        const stale = await db.invoice_line_return_summary
          .where('[business_id+invoice_id]')
          .equals([businessId, invoiceId])
          .primaryKeys();
        if (stale.length > 0) {
          await db.invoice_line_return_summary.bulkDelete(stale);
        }
      } else {
        const stale = await db.invoice_line_return_summary
          .where('business_id')
          .equals(businessId)
          .primaryKeys();
        if (stale.length > 0) {
          await db.invoice_line_return_summary.bulkDelete(stale);
        }
      }

      // Write fresh rows. We intentionally do NOT write rows for lines with
      // zero returned qty — absence == 0 is the cheap default and keeps this
      // table proportional to activity, not to invoice-line count.
      const fresh: InvoiceLineReturnSummary[] = [];
      for (const [lineId, agg] of bucket) {
        if (agg.total <= 0) continue;
        fresh.push({
          invoice_line_id: lineId,
          invoice_id: agg.invoice_id,
          business_id: businessId,
          returned_qty_micros: agg.total,
          updated_at: now,
        });
      }
      if (fresh.length > 0) {
        await db.invoice_line_return_summary.bulkAdd(fresh);
      }
    },
  );
}

// Read a single line's returned qty. Prefers the cache; if the row is
// missing that means 0 returned (see comment above). Callers that need the
// authoritative value (tests, restore verification) should compute directly
// from sales_return_items rather than reading here.
export async function getReturnedQtyMicros(
  db: BusinessVaultDB,
  invoiceLineId: string,
): Promise<number> {
  const row = await db.invoice_line_return_summary.get(invoiceLineId);
  return row?.returned_qty_micros ?? 0;
}
