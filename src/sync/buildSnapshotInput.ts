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
import { log } from '../lib/log';

// §20 backup-format version. Bump when the on-disk CSV shape changes in a
// way that older readers can't handle (adding a new column that older
// restores don't understand is a MINOR bump; renaming/removing a column
// is a MAJOR bump).
export const BACKUP_FORMAT_VERSION = 1;

export class BackupSourceIntegrityError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Backup source validation failed: ${issues.join('; ')}`);
    this.name = 'BackupSourceIntegrityError';
  }
}

declare const __APP_VERSION__: string;
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

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
  await validateBackupSource(db, businessId);
  const files: SnapshotCsvFile[] = [];
  const counts: Record<string, number> = {};

  // Restore uses this to avoid replaying historical events already represented
  // by the snapshot.
  const eventRows = await db.sync_events
    .where('business_id')
    .equals(businessId)
    .toArray();
  const journalCheckpoint = eventRows.reduce<string | undefined>(
    (latest, event) =>
      event.sync_status === 'SYNCED' &&
      (!latest || event.event_id > latest)
        ? event.event_id
        : latest,
    undefined,
  );

  log.info('snapshot.build.start', 'snapshot: assembling CSV files', {
    businessId,
    kind,
    asOf,
    tableCount: TABLE_SPECS.length,
  });

  for (const spec of TABLE_SPECS) {
    const tableStartedAt = Date.now();
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
        const business = await db.businesses.get(businessId);
        rows = business
          ? [business as unknown as Record<string, unknown>]
          : [];
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
      if (spec.store === 'audit_log') {
        // audit_log.before / audit_log.after are `unknown` domain objects
        // (or null). sanitizeCsvCell doesn't know how to stringify plain
        // objects (falls through to '[object Object]'), so pre-serialize
        // them here and let coerceRow's 'json' branch parse on restore.
        const row = r as { before?: unknown; after?: unknown };
        return {
          ...r,
          before: row.before == null ? '' : JSON.stringify(row.before),
          after: row.after == null ? '' : JSON.stringify(row.after),
        };
      }
      if (spec.store === 'attachments') {
        // Never embed the blob bytes in CSV — they ship out-of-band via
        // the `attachment_upload` provider job and land on the row as
        // `drive_file_id`. Drop the Blob field explicitly so it can't
        // sneak into the CSV via any stray column lookup.
        const { blob: _blob, ...rest } = r as { blob?: unknown };
        return rest;
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
    log.debug('snapshot.build.table', 'snapshot: table serialized', {
      businessId,
      store: spec.store,
      file: spec.file,
      rowCount: prepared.length,
      byteCount: bytes.byteLength,
      durationMs: Date.now() - tableStartedAt,
    });
  }

  log.info('snapshot.build.success', 'snapshot: CSV assembly complete', {
    businessId,
    fileCount: files.length,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
  });

  return {
    businessId,
    kind,
    asOf,
    files,
    manifest: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      applicationVersion: APP_VERSION,
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      businessId,
      businessName,
      counts,
      ...(journalCheckpoint ? { journalCheckpoint } : {}),
    },
  };
}

/**
 * A snapshot must never advertise a database state that cannot be replayed.
 * Older builds could leave a posted journal header without its line events;
 * fail before queueing such a backup instead of publishing an unusable one.
 */
export async function validateBackupSource(
  db: BusinessVaultDB,
  businessId: string,
): Promise<void> {
  const entries = await db.journal_entries
    .where('business_id')
    .equals(businessId)
    .toArray();
  const lines = await db.journal_lines
    .where('business_id')
    .equals(businessId)
    .toArray();
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    lineCounts.set(line.entry_id, (lineCounts.get(line.entry_id) ?? 0) + 1);
  }

  const issues: string[] = [];
  for (const entry of entries) {
    if (entry.posted !== 1) continue;
    const count = lineCounts.get(entry.id) ?? 0;
    if (count === 0) {
      issues.push(`posted journal entry ${entry.id} has no journal lines`);
      continue;
    }
    if (entry.total_debit_paise !== entry.total_credit_paise) {
      issues.push(`journal entry ${entry.id} has unequal header totals`);
    }
  }

  if (issues.length > 0) throw new BackupSourceIntegrityError(issues);
}
