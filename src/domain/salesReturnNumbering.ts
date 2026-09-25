import type { BusinessVaultDB } from '../db';

// Allocate the next Sales Return number for a business.
//
// Format: `SR-000001`, `SR-000002`, ... business-wide sequential (NOT
// per-invoice), matching the SellReturnRequirement.md decision. Mirrors
// allocateInvoiceNumber's structure so it inherits the same duplicate-safety
// guarantees under Dexie:
//
//   - Reads businesses.sales_return_next_seq (defaults to 1 if the row
//     predates v5).
//   - Scans forward past any sales_returns row that already carries the
//     candidate number in this business (drift after restore-from-drive or
//     manual seed data is expected — gaps are safe, duplicates are not).
//   - Bumps sales_return_next_seq past the returned value atomically with
//     the collision scan.
//
// SR_PREFIX is a hardcoded constant because the requirement is prescriptive.
// If a future business wants a custom prefix (`SRT-` etc), promote this to
// a Business field the way invoice_prefix works.
const SR_PREFIX = 'SR';
const MAX_SCAN = 10_000;

export async function allocateSalesReturnNumber(
  db: BusinessVaultDB,
  businessId: string,
): Promise<string> {
  return db.transaction(
    'rw',
    [db.businesses, db.sales_returns],
    async () => {
      const biz = await db.businesses.get(businessId);
      if (!biz) throw new Error('Business not found');
      let seq = biz.sales_return_next_seq ?? 1;
      for (let i = 0; i < MAX_SCAN; i++) {
        const candidate = `${SR_PREFIX}-${String(seq).padStart(6, '0')}`;
        const exists = await db.sales_returns
          .where('[business_id+return_number]')
          .equals([businessId, candidate])
          .first();
        if (!exists) {
          await db.businesses.update(businessId, {
            sales_return_next_seq: seq + 1,
            updated_at: new Date().toISOString(),
          });
          return candidate;
        }
        seq++;
      }
      throw new Error(
        `Could not allocate an unused Sales Return number after ${MAX_SCAN} attempts.`,
      );
    },
  );
}
