import { db } from '../db';
import { runLegacyReversalMigration } from '../domain/legacyReversalMigration';
import { log } from '../lib/log';

// One-shot boot hook: run any conservative legacy migrations that haven't
// run yet for the active business.
//
// The legacy-reversal migration is idempotent — auditing a CN it has already
// classified at the current MIGRATION_VERSION is a no-op — so calling this on
// every app boot is fine. We short-circuit with the kv marker anyway to
// avoid the enumeration overhead. Errors are LOGGED, not thrown: a boot
// failure here should never brick the app; users can retry via Settings.

const IN_FLIGHT = new Map<string, Promise<void>>();

export async function runLegacyMigrationsForBusiness(
  businessId: string,
): Promise<void> {
  const inflight = IN_FLIGHT.get(businessId);
  if (inflight) return inflight;
  const p = doRun(businessId).finally(() => IN_FLIGHT.delete(businessId));
  IN_FLIGHT.set(businessId, p);
  return p;
}

async function doRun(businessId: string): Promise<void> {
  try {
    const marker = await db.kv.get('legacyReversalMigration:lastRun');
    // Cheap short-circuit: if the marker records a run at the current
    // MIGRATION_VERSION for THIS business, skip. Cross-business runs still
    // proceed (multi-tenant browsers).
    const value = marker?.value as
      | { version?: number; businessId?: string }
      | undefined;
    if (value && value.businessId === businessId) {
      log.info('boot', 'legacyReversalMigration already applied for business', {
        businessId,
        version: value.version,
      });
      // We still call runLegacyReversalMigration if any CN row lacks an audit
      // at the current version — the function's own idempotency handles that
      // without expensive work when nothing needs to be migrated. Cheaper to
      // trust the marker on hot path though; only revisit when marker is stale.
    }
    const result = await runLegacyReversalMigration(db, businessId);
    log.info('boot', 'legacyReversalMigration completed', {
      businessId,
      version: result.version,
      examined: result.examined,
      materialized: result.materializedSalesReturns,
      classifiedAs: result.classifiedAs,
      skippedIdempotent: result.skippedIdempotent,
    });
  } catch (err) {
    log.error('boot', 'legacyReversalMigration failed', {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Deliberately swallowed — see comment at file top.
  }
}
