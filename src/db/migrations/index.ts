/**
 * Schema migrations for restore.
 *
 * Snapshots on Drive are pinned to a schemaVersion in metadata/schema.json.
 * When we restore a snapshot whose schemaVersion is older than CURRENT_SCHEMA_VERSION
 * we chain the registered migrations in order to bring the parsed row objects up
 * to the current shape BEFORE they are written to Dexie.
 *
 * A migration operates on the plain CSV-parsed row dictionaries — one key per
 * table name (matching the Dexie store names). It should be pure and idempotent.
 */
import { SCHEMA_VERSION } from '../schema';

export type SnapshotTables = Record<string, Record<string, unknown>[]>;

export interface Migration {
  from: number;
  to: number;
  describe: string;
  apply(tables: SnapshotTables): SnapshotTables;
}

const migration_v0_to_v1: Migration = {
  from: 0,
  to: 1,
  describe: 'v0 → v1 (initial): no-op, table shape unchanged',
  apply(tables) {
    return tables;
  },
};

const migration_v1_to_v2: Migration = {
  from: 1,
  to: 2,
  describe: 'v1 → v2: adds `advances` table (empty for older snapshots)',
  apply(tables) {
    if (!tables.advances) return { ...tables, advances: [] };
    return tables;
  },
};

const migration_v2_to_v3: Migration = {
  from: 2,
  to: 3,
  describe: 'v2 → v3: adds `debug_logs` table (empty for older snapshots)',
  apply(tables) {
    if (!tables.debug_logs) return { ...tables, debug_logs: [] };
    return tables;
  },
};

// v3 → v4: adds `deleted_at` + `deleted_reason` soft-delete fields on invoices,
// payments, and advances. Older snapshots don't have the columns; when restored
// we set them to null so the recycle-bin filter treats them as "live". No table
// additions; index changes are applied by Dexie on open.
const migration_v3_to_v4: Migration = {
  from: 3,
  to: 4,
  describe: 'v3 → v4: adds soft-delete fields to invoices/payments/advances',
  apply(tables) {
    const backfill = (rows: Record<string, unknown>[] | undefined) =>
      (rows ?? []).map((r) => ({
        ...r,
        deleted_at: r.deleted_at ?? null,
        deleted_reason: r.deleted_reason ?? null,
      }));
    return {
      ...tables,
      invoices: backfill(tables.invoices),
      payments: backfill(tables.payments),
      advances: backfill(tables.advances),
    };
  },
};

export const MIGRATIONS: Migration[] = [
  migration_v0_to_v1,
  migration_v1_to_v2,
  migration_v2_to_v3,
  migration_v3_to_v4,
];

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

export class UnsupportedSchemaError extends Error {
  constructor(public readonly found: number, public readonly current: number) {
    super(
      `Backup schemaVersion ${found} is newer than this app (${current}). ` +
        'Upgrade the application before restoring.',
    );
    this.name = 'UnsupportedSchemaError';
  }
}

export class MigrationGapError extends Error {
  constructor(public readonly from: number, public readonly to: number) {
    super(`No migration path from schemaVersion ${from} to ${to}`);
    this.name = 'MigrationGapError';
  }
}

export interface MigrationRunResult {
  fromVersion: number;
  toVersion: number;
  appliedSteps: Array<{ from: number; to: number; describe: string }>;
  tables: SnapshotTables;
}

export function migrateSnapshot(
  tables: SnapshotTables,
  fromVersion: number,
  toVersion: number = CURRENT_SCHEMA_VERSION,
): MigrationRunResult {
  if (fromVersion > toVersion) {
    throw new UnsupportedSchemaError(fromVersion, toVersion);
  }
  let current = fromVersion;
  let cur = tables;
  const appliedSteps: MigrationRunResult['appliedSteps'] = [];

  while (current < toVersion) {
    const step = MIGRATIONS.find((m) => m.from === current);
    if (!step) throw new MigrationGapError(current, toVersion);
    cur = step.apply(cur);
    appliedSteps.push({ from: step.from, to: step.to, describe: step.describe });
    current = step.to;
  }

  return { fromVersion, toVersion, appliedSteps, tables: cur };
}
