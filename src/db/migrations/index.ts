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

// v4 → v5: introduces the Sales Return domain — sales_returns,
// sales_return_items, invoice_line_return_summary, legacy_reversal_audit.
// Older snapshots pre-date all four tables; ensure they exist as empty
// arrays so downstream restore code doesn't crash on `.length` / iteration.
// The invoice_line_return_summary cache is rebuildable and will be
// recomputed post-restore rather than trusted from the (nonexistent) v4
// backup payload.
const migration_v4_to_v5: Migration = {
  from: 4,
  to: 5,
  describe:
    'v4 → v5: adds sales_returns / sales_return_items / invoice_line_return_summary / legacy_reversal_audit (empty for older snapshots)',
  apply(tables) {
    return {
      ...tables,
      sales_returns: tables.sales_returns ?? [],
      sales_return_items: tables.sales_return_items ?? [],
      invoice_line_return_summary: tables.invoice_line_return_summary ?? [],
      legacy_reversal_audit: tables.legacy_reversal_audit ?? [],
    };
  },
};

// v5 → v6: adds `round_off_mode` + `pre_round_total_paise` to invoices,
// purchases, and sales_returns headers. Older snapshots don't have these
// columns; when restored we synthesize them so the invariant
// `pre_round + round_off == total` holds and the UI's mode toggle shows
// something sensible for a legacy row. `auto` is chosen because pre-v6
// non-zero round_offs originated from POS's nearest-rupee logic, and rows
// with zero round_off render identically under any mode.
const migration_v5_to_v6: Migration = {
  from: 5,
  to: 6,
  describe:
    'v5 → v6: adds round_off_mode + pre_round_total_paise on invoices / purchases / sales_returns',
  apply(tables) {
    const backfill = (rows: Record<string, unknown>[] | undefined) =>
      (rows ?? []).map((r) => {
        const total = typeof r.total_paise === 'number' ? r.total_paise : 0;
        const roundOff = typeof r.round_off_paise === 'number' ? r.round_off_paise : 0;
        return {
          ...r,
          round_off_mode: r.round_off_mode ?? 'auto',
          pre_round_total_paise: r.pre_round_total_paise ?? total - roundOff,
        };
      });
    return {
      ...tables,
      invoices: backfill(tables.invoices),
      purchases: backfill(tables.purchases),
      sales_returns: backfill(tables.sales_returns),
    };
  },
};

// v6 → v7: feedback §9 Recycle Bin accounting fix. Older snapshots may contain
// invoices with deleted_at set but no matching reversal journal — those rows
// were "recycled" but still contribute to TB/P&L/BS/GST. We backfill by
// posting a mirror journal per stale soft-deleted invoice at snapshot-restore
// time. Idempotent: if `deletion_reversal_journal_id` is already set, we
// leave it alone. Any invoice whose original journal is missing in the
// snapshot (rare, corrupted export) is left untouched — the boot-time
// self-check will surface it.
const migration_v6_to_v7: Migration = {
  from: 6,
  to: 7,
  describe:
    'v6 → v7: recycle-bin backfill — post mirror journal for pre-existing soft-deleted invoices',
  apply(tables) {
    const invoices = (tables.invoices ?? []) as Array<Record<string, unknown>>;
    const journals = [...((tables.journal_entries ?? []) as Array<Record<string, unknown>>)];
    const lines = [...((tables.journal_lines ?? []) as Array<Record<string, unknown>>)];
    const linesByEntry = new Map<string, Array<Record<string, unknown>>>();
    for (const l of lines) {
      const eid = typeof l.entry_id === 'string' ? l.entry_id : '';
      if (!eid) continue;
      const arr = linesByEntry.get(eid) ?? [];
      arr.push(l);
      linesByEntry.set(eid, arr);
    }
    const journalById = new Map<string, Record<string, unknown>>();
    for (const j of journals) {
      const jid = typeof j.id === 'string' ? j.id : '';
      if (jid) journalById.set(jid, j);
    }

    const newJournals: Array<Record<string, unknown>> = [];
    const newLines: Array<Record<string, unknown>> = [];
    const patchedInvoices = invoices.map((r) => {
      const deleted = r.deleted_at;
      const reversalId = r.deletion_reversal_journal_id;
      if (deleted == null || reversalId != null) return r;
      const originalJournalId = typeof r.journal_entry_id === 'string' ? r.journal_entry_id : '';
      if (!originalJournalId) return r;
      const originalJ = journalById.get(originalJournalId);
      const origLines = linesByEntry.get(originalJournalId) ?? [];
      if (!originalJ || origLines.length === 0) return r;

      const invId = typeof r.id === 'string' ? r.id : '';
      const invBiz = typeof r.business_id === 'string' ? r.business_id : '';
      const invDate = typeof r.invoice_date === 'string' ? r.invoice_date : '';
      const invNum = typeof r.invoice_number === 'string' ? r.invoice_number : invId;
      const reason = typeof r.deleted_reason === 'string' ? r.deleted_reason : 'deleted';
      // Deterministic id so re-running the migration on the same snapshot
      // yields identical output (helps snapshot-diff / debugging).
      const newRevId = `mig-v7-${invId}`;
      newJournals.push({
        id: newRevId,
        business_id: invBiz,
        entry_number: `JE-DEL-${invId}`,
        entry_date: invDate,
        narration: `Recycle bin reversal (backfill v7) of ${invNum}: ${reason}`,
        ref_type: 'reversal',
        ref_id: invId,
        reversed_by_id: null,
        reverses_id: originalJournalId,
        total_debit_paise: originalJ.total_credit_paise ?? 0,
        total_credit_paise: originalJ.total_debit_paise ?? 0,
        posted: 1,
        created_at: deleted,
        updated_at: deleted,
        entity_version: 1,
      });
      for (let idx = 0; idx < origLines.length; idx++) {
        const l = origLines[idx];
        newLines.push({
          id: `mig-v7-l-${invId}-${idx + 1}`,
          business_id: l.business_id,
          entry_id: newRevId,
          line_no: idx + 1,
          account_id: l.account_id,
          debit_paise: l.credit_paise ?? 0,
          credit_paise: l.debit_paise ?? 0,
          party_type: l.party_type ?? null,
          party_id: l.party_id ?? null,
          description: `Recycle bin reversal: ${typeof l.description === 'string' ? l.description : ''}`,
        });
      }
      return { ...r, deletion_reversal_journal_id: newRevId };
    });
    return {
      ...tables,
      invoices: patchedInvoices,
      journal_entries: [...journals, ...newJournals],
      journal_lines: [...lines, ...newLines],
    };
  },
};

// v7 → v8: feedback §2 Authorised Signature. Adds `signature_ref` +
// `show_signature_on_invoice` on businesses and `signature_attachment_id` on
// invoices. Older snapshots don't carry these columns; default them to
// null/0 so the restore reads as "no signature configured". Historical
// invoices restored from a pre-v8 backup therefore land with
// signature_attachment_id=null, which InvoicePrint interprets as "render
// the plain signature block, no image" — consistent with how the PDF
// looked at the time the snapshot was taken.
const migration_v7_to_v8: Migration = {
  from: 7,
  to: 8,
  describe:
    'v7 → v8: adds signature_ref / show_signature_on_invoice on businesses, signature_attachment_id on invoices',
  apply(tables) {
    const businesses = (tables.businesses ?? []).map((r) => ({
      ...r,
      signature_ref: r.signature_ref ?? null,
      show_signature_on_invoice: r.show_signature_on_invoice ?? 0,
    }));
    const invoices = (tables.invoices ?? []).map((r) => ({
      ...r,
      signature_attachment_id: r.signature_attachment_id ?? null,
    }));
    return { ...tables, businesses, invoices };
  },
};

export const MIGRATIONS: Migration[] = [
  migration_v0_to_v1,
  migration_v1_to_v2,
  migration_v2_to_v3,
  migration_v3_to_v4,
  migration_v4_to_v5,
  migration_v5_to_v6,
  migration_v6_to_v7,
  migration_v7_to_v8,
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
