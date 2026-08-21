import type { BusinessVaultDB } from '../db/database';
import type {
  SnapshotCsvFile,
  SnapshotKind,
  WriteSnapshotInput,
} from '../storage/CustomerStorageProvider';
import { TABLE_SPECS } from '../restore/tableSchema';
import { writeCsv } from '../csv/csvCodec';
import { sha256Hex } from '../journal/event';
import { CURRENT_SCHEMA_VERSION } from '../db/migrations/index';

// Build a WriteSnapshotInput by dumping every domain table for `businessId` to
// CSV using the on-disk column layout in TABLE_SPECS. This is what the
// "Snapshot Now" button in BackupSettings enqueues and what the (unwired)
// snapshotScheduler is meant to hand the sync worker.
//
// Columns that don't exist on the row become empty strings via writeCsv's
// sanitize step. The two JSON-serialized fields (payment.allocations,
// advance.applications) need explicit adapters because the on-disk name has
// a `_json` suffix.
export async function buildSnapshotInput(
  db: BusinessVaultDB,
  businessId: string,
  businessName: string,
  kind: SnapshotKind,
  asOf: string,
): Promise<WriteSnapshotInput> {
  const files: SnapshotCsvFile[] = [];
  const counts: Record<string, number> = {};

  for (const spec of TABLE_SPECS) {
    const table = (db as unknown as Record<
      string,
      {
        where(k: string): { equals(v: unknown): { toArray(): Promise<unknown[]> } };
        toArray(): Promise<unknown[]>;
      }
    >)[spec.store];

    let rows: Record<string, unknown>[] = [];
    if (table) {
      if (spec.store === 'businesses') {
        rows = (await db.businesses.toArray()) as unknown as Record<string, unknown>[];
      } else {
        rows = (await table
          .where('business_id')
          .equals(businessId)
          .toArray()) as Record<string, unknown>[];
      }
    }

    const prepared = rows.map((r) => {
      if (spec.store === 'payments' && Array.isArray((r as { allocations?: unknown[] }).allocations)) {
        return {
          ...r,
          allocations_json: JSON.stringify((r as { allocations: unknown[] }).allocations),
        };
      }
      if (spec.store === 'advances' && Array.isArray((r as { applications?: unknown[] }).applications)) {
        return {
          ...r,
          applications_json: JSON.stringify((r as { applications: unknown[] }).applications),
        };
      }
      return r;
    });

    const cols = spec.columns.map((c) => c.name);
    const csv = writeCsv(prepared, cols);
    const bytes = new TextEncoder().encode(csv);
    files.push({
      name: spec.file,
      content: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/csv' }),
      rowCount: prepared.length,
      sha256: await sha256Hex(csv),
    });
    counts[spec.file] = prepared.length;
  }

  return {
    businessId,
    kind,
    asOf,
    files,
    manifest: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      businessId,
      businessName,
      counts,
    },
  };
}
