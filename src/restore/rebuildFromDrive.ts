/**
 * Restore-from-Drive — spec §25, §26, §27.
 *
 * Rebuilds the entire local business (IndexedDB + derived caches) from the
 * customer's Drive folder alone. Runs entirely off `CustomerStorageProvider`
 * primitives — the same abstraction the app writes through — so any provider
 * (Google Drive, Local Folder, future OneDrive/S3) can drive it.
 *
 * Pipeline:
 *   1. connect provider (caller supplies ProviderConfig)
 *   2. locate BusinessVault → let caller pick if multiple businesses exist
 *   3. read + validate manifest.json (schemaVersion, businessId)
 *   4. verifyIntegrity — abort with "Backup integrity verification failed"
 *      on any hash/checksum mismatch (spec §7)
 *   5. load latest verified snapshot → parseCsv → migrate to current schema
 *      → bulk-insert into Dexie in ONE transaction (all-or-nothing)
 *   6. replay journal events after snapshot's checkpoint, idempotent handlers
 *   7. rebuild derived caches (item_stock qty/cost; invoice/purchase settlement)
 *   8. repair legacy journal headers + accountingSelfCheck + inventory/GST checks
 *   9. emit RECOVERY_DIAGNOSTIC_REPORT on any inconsistency — never silently
 *      modify accounting records
 */
import type { BusinessVaultDB } from '../db/database';
import type {
  CustomerStorageProvider,
  ProviderConfig,
  SnapshotHandle,
  SnapshotIndex,
  SyncEvent,
} from '../storage/CustomerStorageProvider';
import { LocalFolderStorageProvider } from '../storage/LocalFolderStorageProvider';
import { setCurrentBusinessId } from '../lib/business';
import { parseCsv } from '../csv/csvCodec';
import {
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaError,
  migrateSnapshot,
  type SnapshotTables,
} from '../db/migrations/index';
import {
  TABLE_SPECS,
  findTableSpecByFile,
  coerceRow,
  type TableSpec,
} from './tableSchema';
import { applyEvent } from './eventHandlers';
import {
  makeDiagnosticReport,
  renderDiagnosticReport,
  type DiagnosticIssue,
  type RecoveryDiagnosticReport,
} from './diagnosticReport';
import { accountingSelfCheck } from '../domain/AccountingService';
import { InventoryService } from '../domain/InventoryService';
import { rebuildInvoiceLineReturnSummary } from '../domain/invoiceLineReturnSummary';
import { log } from '../lib/log';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoveredBusiness {
  businessId: string;
  businessName: string;
  folderPath: string;
  schemaVersion: number;
  lastSnapshotAsOf?: string;
}

export interface BusinessPickerContext {
  businesses: DiscoveredBusiness[];
}

export type BusinessPicker = (
  ctx: BusinessPickerContext,
) => Promise<DiscoveredBusiness>;

export interface RebuildOptions {
  db: BusinessVaultDB;
  providerConfig: ProviderConfig;
  /**
   * Called when more than one business is found on the provider. Not
   * called when exactly one is present.
   */
  pickBusiness?: BusinessPicker;
  /** Test hook — inject a pre-connected provider instead of opening a new one. */
  preConnectedProvider?: CustomerStorageProvider;
  /** Called with the current step description for UI progress. */
  onProgress?: (step: string, pct?: number) => void;
  /**
   * Opt-in to wipe unshipped local events. When Restore finds sync_events with
   * sync_status != 'SYNCED' for the selected business, it means work was done
   * on this device that never made it to the backup folder. Wiping the DB
   * would destroy that work. Default behaviour: throw UnshippedEventsError so
   * the UI can surface a confirmation. Pass true only after the user has
   * acknowledged the loss.
   */
  confirmDataLoss?: boolean;
  /** Abort a restore before or between destructive/replay phases. */
  signal?: AbortSignal;
}

export interface RestoreReport {
  businessId: string;
  businessName: string;
  folderPath: string;
  schemaVersion: number;
  migratedFrom?: number;
  snapshotUsed?: SnapshotHandle;
  counts: Record<string, number>;
  sourceCounts: Record<string, number>;
  countReconciliation: {
    exact: boolean;
    compared: boolean;
    mismatches: Record<string, { source: number; restored: number }>;
  };
  eventsReplayed: number;
  unhandledEvents: number;
  checksumsOk: boolean;
  accountingBalanced: boolean;
  inventoryConsistent: boolean;
  gstReconciled: boolean;
  diagnostics: RecoveryDiagnosticReport;
}

export class BackupIntegrityError extends Error {
  constructor(
    message: string,
    public readonly detail: unknown,
  ) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

export interface UnshippedEventsSummary {
  businessId: string;
  businessName: string;
  total: number;
  byStatus: Record<string, number>;
  byEntityType: Record<string, number>;
}

// Thrown when Restore would wipe local events that have not yet been synced
// to the backup folder. The UI catches this, shows the counts, and only
// re-runs rebuildFromDrive with confirmDataLoss=true after the user OKs it.
export class UnshippedEventsError extends Error {
  constructor(public readonly summary: UnshippedEventsSummary) {
    super(
      `Restore would discard ${summary.total} unshipped event(s) for '${summary.businessName}' that are not on the backup folder. Reconnect the folder and let sync finish, or pass confirmDataLoss=true to overwrite.`,
    );
    this.name = 'UnshippedEventsError';
  }
}

// Thrown when the selected business folder has zero snapshots AND zero
// journal events. Without this guard, rebuildFromDrive would happily
// clear() every local table and report "Restore complete ✓ all checks OK"
// with zero rows — silently destroying whatever the user had locally. The
// user sees this happen the moment they click "overwrite anyway" past the
// unshipped-events guard on a folder that isn't actually populated.
export class EmptyBackupError extends Error {
  constructor(
    public readonly businessId: string,
    public readonly businessName: string,
    public readonly folderPath: string,
  ) {
    super(
      `No data to restore for '${businessName}' — the backup folder at '${folderPath}' contains no snapshots and no journal events. Local data has been left untouched.`,
    );
    this.name = 'EmptyBackupError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function rebuildFromDrive(
  provider: CustomerStorageProvider,
  opts: RebuildOptions,
): Promise<RestoreReport> {
  const progress = opts.onProgress ?? (() => undefined);
  const throwIfAborted = (): void => {
    if (opts.signal?.aborted) {
      const error = new Error('Restore cancelled. Local data was restored to its previous state.');
      error.name = 'AbortError';
      throw error;
    }
  };
  const restoreStartedAt = Date.now();
  log.info('restore.start', 'restore: started', {
    providerKind: opts.providerConfig.kind,
    confirmDataLoss: opts.confirmDataLoss === true,
  });

  // 1. connect
  progress('Connecting to storage provider', 5);
  throwIfAborted();
  if (!opts.preConnectedProvider) {
    await provider.connect(opts.providerConfig);
  }
  log.info('restore.provider.connected', 'restore: storage provider connected', {
    providerKind: opts.providerConfig.kind,
    durationMs: Date.now() - restoreStartedAt,
  });

  // 2. locate BusinessVault and pick a business
  progress('Locating BusinessVault folder', 10);
  throwIfAborted();
  const businesses = await discoverBusinesses(provider);
  log.info('restore.businesses.discovered', 'restore: businesses discovered', {
    count: businesses.length,
    businessIds: businesses.map((business) => business.businessId),
  });
  if (businesses.length === 0) {
    throw new Error('No BusinessVault business folder found on the provider');
  }
  let selected: DiscoveredBusiness;
  if (businesses.length === 1) {
    selected = businesses[0];
  } else {
    if (!opts.pickBusiness) {
      throw new Error(
        `Multiple businesses found (${businesses.length}); pickBusiness callback required`,
      );
    }
    selected = await opts.pickBusiness({ businesses });
  }
  if (!businesses.some((candidate) => candidate === selected || candidate.businessId === selected.businessId)) {
    throw new Error('Selected restore business is not one of the discovered backup businesses');
  }
  log.info('restore.business.selected', 'restore: business selected', {
    businessId: selected.businessId,
    schemaVersion: selected.schemaVersion,
    candidateCount: businesses.length,
  });

  // Bind the provider to the selected business so subsequent journal/snapshot
  // reads know which folder to look in.
  await provider.initializeBusiness({
    businessId: selected.businessId,
    businessName: selected.businessName,
  });

  // 3. read + validate manifest
  progress('Reading manifest', 15);
  throwIfAborted();
  const manifest = await readManifest(provider, selected);
  if (manifest.businessId && manifest.businessId !== selected.businessId) {
    throw new BackupIntegrityError('Backup manifest business identity does not match selected business', {
      expected: selected.businessId,
      actual: manifest.businessId,
    });
  }
  const foundSchema = Number(manifest.schemaVersion ?? selected.schemaVersion ?? 0);
  if (foundSchema > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(foundSchema, CURRENT_SCHEMA_VERSION);
  }

  // 4. checksum verification (spec §7)
  progress('Verifying backup integrity', 25);
  throwIfAborted();
  const integrity = await provider.verifyIntegrity();
  const checksumsOk = integrity.ok;
  if (!checksumsOk) {
    log.error('restore.integrity.failed', 'restore: backup integrity verification failed', {
      businessId: selected.businessId,
      issues: integrity.issues,
    });
    throw new BackupIntegrityError(
      'Backup integrity verification failed',
      integrity.issues,
    );
  }
  log.info('restore.integrity.passed', 'restore: backup integrity verified', {
    businessId: selected.businessId,
  });

  // 4a. Guard against destroying unshipped local work. Any sync_events row for
  // this business whose sync_status != 'SYNCED' represents user work that
  // exists on this device but has NOT yet reached the backup folder — the
  // sync worker either never ran or has been failing (folder permission
  // revoked, handle stale, offline). rebuildFromDrive is destructive: step 5
  // calls table.clear() on every domain table and sync_events. Wiping that
  // without warning is data-loss. See "restore-from-backup shows empty data"
  // regression from bhawna business (folder had only the 51 seed events).
  const unshipped = await summarizeUnshipped(opts.db, selected.businessId, selected.businessName);
  log.info('restore.preflight.unshipped', 'restore: unshipped-event preflight complete', {
    businessId: selected.businessId,
    total: unshipped.total,
    byStatus: unshipped.byStatus,
    byEntityType: unshipped.byEntityType,
    confirmed: opts.confirmDataLoss === true,
  });
  if (unshipped.total > 0 && !opts.confirmDataLoss) {
    log.warn('restore.preflight.blocked', 'restore: blocked to preserve unshipped work', {
      businessId: selected.businessId,
      total: unshipped.total,
    });
    throw new UnshippedEventsError(unshipped);
  }

  // 5. pick + load the latest verified snapshot
  progress('Loading latest backup', 40);
  throwIfAborted();
  const snapshotIndex = await pickLatestVerifiedSnapshot(provider);
  let snapshotTables: SnapshotTables = emptyTables();
  let snapshotHandle: SnapshotHandle | undefined;
  let migratedFrom: number | undefined;
  if (snapshotIndex) {
    snapshotHandle = snapshotIndex.handle;
    const snap = await provider.readSnapshot(snapshotHandle);
    // Cross-verify each CSV file's declared sha256 against the reader's
    // reported sha256. readSnapshot recomputes on read; if the manifest was
    // corrupted this would already have been caught by verifyIntegrity, but
    // belt-and-braces: any mismatch here is fatal.
    for (const f of snap.files) {
      const expected = snap.checksums[f.name];
      if (expected && expected !== f.sha256) {
        throw new BackupIntegrityError(
          'Backup integrity verification failed',
          { file: f.name, expected, actual: f.sha256 },
        );
      }
    }
    const parsedTables = await parseSnapshotFiles(snap.files);
    validateSnapshotTables(parsedTables, selected.businessId);
    const snapSchema = Number(snap.manifest.schemaVersion ?? foundSchema);
    if (snapSchema > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedSchemaError(snapSchema, CURRENT_SCHEMA_VERSION);
    }
    if (snapSchema < CURRENT_SCHEMA_VERSION) {
      const migrated = migrateSnapshot(
        parsedTables,
        snapSchema,
        CURRENT_SCHEMA_VERSION,
      );
      snapshotTables = migrated.tables;
      migratedFrom = snapSchema;
    } else {
      snapshotTables = parsedTables;
    }
    log.info('restore.snapshot.loaded', 'restore: snapshot loaded', {
      businessId: selected.businessId,
      kind: snapshotHandle.kind,
      asOf: snapshotHandle.asOf,
      fileCount: snap.files.length,
      rowCount: Object.values(snapshotTables).reduce((sum, rows) => sum + rows.length, 0),
      sourceSchemaVersion: snapSchema,
      targetSchemaVersion: CURRENT_SCHEMA_VERSION,
      migrated: migratedFrom !== undefined,
    });
  } else {
    const declaredSnapshot = manifest.currentSnapshot as
      | { path?: unknown; kind?: unknown; asOf?: unknown }
      | undefined;
    if (declaredSnapshot?.path || declaredSnapshot?.kind || declaredSnapshot?.asOf) {
      throw new BackupIntegrityError(
        'The backup declares a current snapshot, but no verified snapshot was found. Re-select the correct backup folder and try again.',
        { businessId: selected.businessId, declaredSnapshot },
      );
    }
    log.warn('restore.snapshot.missing', 'restore: no verified snapshot found; journal replay only', {
      businessId: selected.businessId,
    });
  }

  // Read the journal BEFORE clearing local state so we can bail out cleanly
  // when the backup is empty. Reading is idempotent and cheap compared to
  // wiping the DB and then discovering there was nothing to restore.
  const sinceEventId =
    (manifest.journalCheckpoint as string | undefined) ?? undefined;
  const journalEvents = await provider.readJournalEvents({
    businessId: selected.businessId,
    sinceEventId,
  });
  const snapshotAsOf = snapshotHandle
    ? normalizeSnapshotTimestamp(snapshotHandle.asOf)
    : undefined;
  const events = sinceEventId || !snapshotAsOf
    ? journalEvents
    : journalEvents.filter((event) => event.timestamp > snapshotAsOf);
  log.info('restore.journal.loaded', 'restore: journal events loaded', {
    businessId: selected.businessId,
    eventCount: events.length,
    sinceEventId: sinceEventId ?? null,
    journalEventCount: journalEvents.length,
    snapshotAsOf: snapshotAsOf ?? null,
  });

  // Zero snapshots + zero journal events = a backup folder that was never
  // populated (e.g. business onboarded to Drive but the sync worker never
  // successfully flushed). Wiping local tables and reporting "Restore
  // complete ✓" against this is silent data-loss — refuse instead.
  if (!snapshotIndex && journalEvents.length === 0) {
    throw new EmptyBackupError(
      selected.businessId,
      selected.businessName,
      selected.folderPath,
    );
  }

  // §8: suppress low-stock alerts across the entire rebuild — a snapshot
  // restore represents "loading history", not "user just sold something",
  // and every item that happens to be below reorder in the restored data
  // would otherwise pop a toast the moment the item_stock row lands. The
  // flag is checked by the Dexie item_stock hook in database.ts inside its
  // post-commit dispatcher. We restore it in a `finally` so a mid-restore
  // throw doesn't leave the flag stuck on and mute future real writes.
  const dbWithFlag = opts.db as unknown as { __bvSuppressLowStock?: boolean };
  dbWithFlag.__bvSuppressLowStock = true;
  const diagnostics: string[] = [];
  let replayed = 0;
  let unhandled = 0;
  const previousState = await captureSelectedBusinessState(opts.db, selected.businessId);
  try {
    // Replace only the selected business under one transaction. Other local
    // businesses may have independent unsynced work and must remain untouched.
    progress('Rebuilding local database', 55);
    throwIfAborted();
    await opts.db.transaction(
      'rw',
      tableNames(),
      async () => {
        for (const spec of TABLE_SPECS) {
          const table = (opts.db as unknown as Record<string, {
            delete(key: string): Promise<void>;
            where(k: string): { equals(v: unknown): { delete(): Promise<number> } };
            bulkPut(rows: unknown[]): Promise<unknown>;
          }>)[spec.store];
          if (!table) continue;
          const rows = snapshotTables[spec.store];
          let deleted: number;
          if (spec.store === 'businesses') {
            deleted = (await opts.db.businesses.get(selected.businessId)) ? 1 : 0;
            await opts.db.businesses.delete(selected.businessId);
          } else {
            deleted = await table.where('business_id').equals(selected.businessId).delete();
          }
          if (rows && rows.length > 0) {
            await table.bulkPut(rows);
          }
          log.debug('restore.snapshot.table-replaced', 'restore: selected business table replaced', {
            businessId: selected.businessId,
            store: spec.store,
            deletedRows: deleted,
            insertedRows: rows?.length ?? 0,
          });
        }
        const deletedEvents = await opts.db.sync_events
          .where('business_id')
          .equals(selected.businessId)
          .delete();
        log.info('restore.snapshot.committed', 'restore: selected business snapshot committed', {
          businessId: selected.businessId,
          deletedSyncEvents: deletedEvents,
        });
      },
    );

    // 6. replay journal events after the snapshot's checkpoint
    progress('Replaying journal events', 70);

    // Replay each event in its own short transaction. Keeping the entire
    // journal inside one transaction allows IndexedDB to commit between
    // awaited handler operations, which Dexie reports as "Transaction
    // committed too early" on larger Google Drive restores.
    for (const evt of orderReplayEvents(events)) {
      throwIfAborted();
      try {
        let wasApplied = false;
        await opts.db.transaction('rw', tableNames(), async () => {
          const result = await applyEvent(evt, {
            db: opts.db,
            businessId: selected.businessId,
            diagnostics,
          });
          wasApplied = result === 'applied';
        });
        if (wasApplied) replayed++;
        else {
          unhandled++;
          diagnostics.push(
            `event ${evt.event_id} (${evt.entity_type}:${evt.operation}) has no replay handler`,
          );
        }
      } catch (err) {
        log.warn('restore.replay.event-failed', 'restore: journal event replay failed', {
          businessId: selected.businessId,
          eventId: evt.event_id,
          entityType: evt.entity_type,
          operation: evt.operation,
          error: err,
        });
        diagnostics.push(
          `event ${evt.event_id} (${evt.entity_type}:${evt.operation}) failed: ${(err as Error).message}`,
        );
      }
    }
    if (diagnostics.length > 0) {
      throw new Error(
        `Restore replay failed for ${diagnostics.length} event(s): ${diagnostics
          .slice(0, 5)
          .join(' | ')}`,
      );
    }
    log.info('restore.replay.complete', 'restore: journal replay complete', {
      businessId: selected.businessId,
      eventCount: events.length,
      replayed,
      unhandled,
      failed: diagnostics.length,
    });

    // 7. rebuild derived caches
    progress('Rebuilding derived tables', 80);
    throwIfAborted();
    await rebuildItemStockFromMovements(opts.db, selected.businessId);
    await rebuildDocumentSettlementBalances(opts.db, selected.businessId);
    log.info('restore.derived.complete', 'restore: derived caches rebuilt', {
      businessId: selected.businessId,
    });
  } catch (err) {
    // Snapshot replacement commits before replay so large restores do not hit
    // IndexedDB's transaction lifetime limit. If replay or derived rebuild
    // fails, restore the pre-restore rows before surfacing the failure.
    await restoreSelectedBusinessState(opts.db, selected.businessId, previousState);
    throw err;
  } finally {
    dbWithFlag.__bvSuppressLowStock = false;
  }

  // 8. run validators (spec §27)
  progress('Verifying accounting and inventory', 90);
  const issues: DiagnosticIssue[] = [];
  for (const d of diagnostics) {
    issues.push({ severity: 'error', code: 'REPLAY_FAILURE', message: d });
  }

  const repairedJournalHeaders = await repairLegacyJournalHeaders(selected.businessId, opts.db);
  if (repairedJournalHeaders.length > 0) {
    issues.push({
      severity: 'info',
      code: 'LEGACY_JOURNAL_HEADER_TOTALS_REPAIRED',
      message:
        'Legacy journal header totals were normalized from their balanced journal lines.',
      detail: { entries: repairedJournalHeaders.slice(0, 20) },
    });
  }

  const acct = await accountingSelfCheck(selected.businessId, { db: opts.db });
  const accountingBalanced = acct.debitsEqCredits && acct.unbalancedEntries.length === 0;
  if (!accountingBalanced) {
    const missingJournalLines = await findPostedEntriesWithoutLines(opts.db, selected.businessId);
    issues.push({
      severity: 'error',
      code: 'ACCOUNTING_UNBALANCED',
      message:
        'SUM(debits) != SUM(credits) after restore. Never silently modify accounting records.',
      detail: {
        totalDebits: acct.totalDebits,
        totalCredits: acct.totalCredits,
        unbalancedEntries: acct.unbalancedEntries.slice(0, 20),
        missingJournalLines,
      },
    });
  }

  const inv = new InventoryService({ db: opts.db });
  const identity = await inv.verifyInventoryIdentity(selected.businessId);
  const inventoryConsistent = identity.ok;
  if (!inventoryConsistent) {
    issues.push({
      severity: 'error',
      code: 'INVENTORY_IDENTITY_BROKEN',
      message:
        'opening + purchases + sales_returns - sales - purchase_returns ± adjustments != current stock.',
      detail: { mismatches: identity.mismatches.slice(0, 20) },
    });
  }

  // §7.4: invoice_line_return_summary is a CACHE — source of truth is
  // SUM(active sales_return_items.qty_micros). A snapshot may or may not
  // carry the cache (older backups don't), and event replay writes items
  // without touching the summary. Rebuild from source once after all rows
  // are in place so the available-to-return math and any downstream
  // eligibility checks read consistent values on the very first render.
  log.info('restore', 'rebuilding invoice_line_return_summary from source', {
    businessId: selected.businessId,
  });
  await rebuildInvoiceLineReturnSummary(opts.db, selected.businessId);

  const gst = await gstReconciliation(opts.db, selected.businessId);
  const gstReconciled = gst.ok;
  if (!gstReconciled) {
    issues.push({
      severity: 'error',
      code: 'GST_MISMATCH',
      message: 'Invoice-line GST totals do not sum to invoice header GST totals.',
      detail: gst.detail,
    });
  }

  // 9. counts + report
  // A local-folder restore must not resurrect a historical Google Drive
  // connection from businesses.csv. OAuth tokens were intentionally cleared
  // during a fresh reset, so retaining the old folder id would make the next
  // boot select Drive and show a stale "Open My Google Drive Folder" link.
  if (opts.providerConfig.kind === 'local-folder') {
    await opts.db.businesses.update(selected.businessId, {
      drive_folder_id: null,
      drive_connected_email: null,
    });
  }
  const counts = await countTables(opts.db, selected.businessId);
  const sourceCounts = expectedCountsAfterJournal(snapshotTables, events);
  const countReconciliation = reconcileCounts(sourceCounts, counts);
  if (!countReconciliation.exact) {
    log.error('restore.count-mismatch', 'restore: source and local counts differ', {
      businessId: selected.businessId,
      sourceCounts,
      restoredCounts: counts,
      mismatches: countReconciliation.mismatches,
    });
    await restoreSelectedBusinessState(opts.db, selected.businessId, previousState);
    throw new BackupIntegrityError(
      'Restore count verification failed. Local data was left unchanged.',
      { sourceCounts, restoredCounts: counts, mismatches: countReconciliation.mismatches },
    );
  }
  const report = makeDiagnosticReport({
    businessId: selected.businessId,
    counts,
    issues,
  });

  // Point the meta-DB at the restored business so the app boots into it on
  // next reload. Without this, `currentBusinessId()` throws NotOnboardedError
  // and every domain page renders the onboarding wizard — exactly the state
  // testing surfaced after a successful-looking restore.
  await setCurrentBusinessId(selected.businessId);

  log.info('restore.complete', 'restore: completed', {
    businessId: selected.businessId,
    durationMs: Date.now() - restoreStartedAt,
    eventsReplayed: replayed,
    unhandledEvents: unhandled,
    checksumsOk,
    accountingBalanced,
    inventoryConsistent,
    gstReconciled,
    diagnosticIssueCount: issues.length,
    counts,
  });

  progress('Restore complete', 100);

  return {
    businessId: selected.businessId,
    businessName: selected.businessName,
    folderPath: selected.folderPath,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    migratedFrom,
    snapshotUsed: snapshotHandle,
    counts,
    sourceCounts,
    countReconciliation,
    eventsReplayed: replayed,
    unhandledEvents: unhandled,
    checksumsOk,
    accountingBalanced,
    inventoryConsistent,
    gstReconciled,
    diagnostics: report,
  };
}

/**
 * Older app versions could persist balanced journal lines with stale entry
 * header totals, especially when an invoice included round-off. The lines are
 * the accounting source of truth. Repair only headers whose lines are balanced;
 * genuinely unbalanced lines remain a restore failure below.
 */
export async function repairLegacyJournalHeaders(
  businessId: string,
  db: BusinessVaultDB,
): Promise<string[]> {
  const [entries, lines] = await Promise.all([
    db.journal_entries.where('business_id').equals(businessId).toArray(),
    db.journal_lines.where('business_id').equals(businessId).toArray(),
  ]);
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const current = totals.get(line.entry_id) ?? { debit: 0, credit: 0 };
    current.debit += line.debit_paise;
    current.credit += line.credit_paise;
    totals.set(line.entry_id, current);
  }

  const repairs = entries
    .filter((entry) => {
      if (entry.posted !== 1) return false;
      const total = totals.get(entry.id);
      return !!total &&
        total.debit === total.credit &&
        (entry.total_debit_paise !== total.debit || entry.total_credit_paise !== total.credit);
    })
    .map((entry) => {
      const total = totals.get(entry.id)!;
      return { id: entry.id, debit: total.debit, credit: total.credit };
    });

  if (repairs.length === 0) return [];

  await db.transaction('rw', db.journal_entries, async () => {
    for (const repair of repairs) {
      await db.journal_entries.update(repair.id, {
        total_debit_paise: repair.debit,
        total_credit_paise: repair.credit,
      });
    }
  });
  return repairs.map((repair) => repair.id);
}

async function findPostedEntriesWithoutLines(
  db: BusinessVaultDB,
  businessId: string,
): Promise<string[]> {
  const [entries, lines] = await Promise.all([
    db.journal_entries.where('business_id').equals(businessId).toArray(),
    db.journal_lines.where('business_id').equals(businessId).toArray(),
  ]);
  const entryIds = new Set(lines.map((line) => line.entry_id));
  return entries
    .filter((entry) => entry.posted === 1 && !entryIds.has(entry.id))
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSnapshotTimestamp(asOf: string): string {
  if (!asOf.includes('T')) return '';
  return asOf.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z$/,
    '$1T$2:$3:$4Z',
  );
}

function orderReplayEvents(events: SyncEvent[]): SyncEvent[] {
  const operationOrder: Record<string, number> = {
    create: 0,
    created: 0,
    posted: 0,
    update: 1,
    updated: 1,
    reverse: 2,
    reversed: 2,
    delete: 3,
    deleted: 3,
  };
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) =>
      a.event.timestamp.localeCompare(b.event.timestamp) ||
      (operationOrder[a.event.operation] ?? 1) - (operationOrder[b.event.operation] ?? 1) ||
      a.index - b.index,
    )
    .map(({ event }) => event);
}

function tableNames(): string[] {
  return [
    'businesses',
    'customers',
    'suppliers',
    'categories',
    'units',
    'warehouses',
    'items',
    'item_stock',
    'invoices',
    'invoice_lines',
    'invoice_line_return_summary',
    'purchases',
    'purchase_lines',
    'payments',
    'expenses',
    'stock_movements',
    'accounts',
    'journal_entries',
    'journal_lines',
    'advances',
    'customer_item_prices',
    // §20 additions.
    'sales_returns',
    'sales_return_items',
    'attachments',
    'audit_log',
    'sync_events',
  ];
}

type SelectedBusinessState = Record<string, unknown[]>;

async function captureSelectedBusinessState(
  db: BusinessVaultDB,
  businessId: string,
): Promise<SelectedBusinessState> {
  const state: SelectedBusinessState = {};
  await db.transaction('r', tableNames(), async () => {
    for (const tableName of tableNames()) {
      const table = (db as unknown as Record<string, { toArray(): Promise<unknown[]> }>)[tableName];
      if (!table) continue;
      const rows = await table.toArray();
      state[tableName] = rows.filter((row) => {
        if (tableName === 'businesses') return (row as { id?: string }).id === businessId;
        return (row as { business_id?: string }).business_id === businessId;
      });
    }
  });
  return state;
}

async function restoreSelectedBusinessState(
  db: BusinessVaultDB,
  businessId: string,
  state: SelectedBusinessState,
): Promise<void> {
  await db.transaction('rw', tableNames(), async () => {
    for (const tableName of tableNames()) {
      const table = (db as unknown as Record<string, {
        delete(key: string): Promise<void>;
        where(k: string): { equals(v: unknown): { delete(): Promise<number> } };
        bulkPut(rows: unknown[]): Promise<unknown>;
      }>)[tableName];
      if (!table) continue;
      if (tableName === 'businesses') {
        await db.businesses.delete(businessId);
      } else {
        await table.where('business_id').equals(businessId).delete();
      }
      const rows = state[tableName];
      if (rows?.length) await table.bulkPut(rows);
    }
  });
}

function emptyTables(): SnapshotTables {
  const t: SnapshotTables = {};
  for (const spec of TABLE_SPECS) t[spec.store] = [];
  return t;
}

async function parseSnapshotFiles(
  files: Array<{ name: string; content: Blob }>,
): Promise<SnapshotTables> {
  const out: SnapshotTables = emptyTables();
  for (const f of files) {
    const spec = findTableSpecByFile(f.name);
    if (!spec) continue; // unknown file — snapshot is a superset of what we import
    const text = await blobToText(f.content);
    const parsed = parseCsv(text);
    const expected = new Set(spec.columns.map((column) => column.name));
    for (const required of spec.required ?? [spec.pk]) {
      if (!parsed.headers.includes(required)) {
        throw new Error(`Snapshot ${f.name} is missing required column '${required}'`);
      }
    }
    for (const header of parsed.headers) {
      if (!expected.has(header)) {
        throw new Error(`Snapshot ${f.name} contains unknown column '${header}'`);
      }
    }
    const rows: Record<string, unknown>[] = [];
    const primaryKeys = new Set<string>();
    for (const raw of parsed.rows) {
      const row = coerceRow(raw, spec);
      const key = String(row[spec.pk] ?? '');
      if (!key) throw new Error(`Snapshot ${f.name} contains a blank primary key`);
      if (primaryKeys.has(key)) throw new Error(`Snapshot ${f.name} contains duplicate primary key '${key}'`);
      primaryKeys.add(key);
      rows.push(row);
    }
    out[spec.store] = rows;
  }
  return out;
}

function validateSnapshotTables(tables: SnapshotTables, businessId: string): void {
  for (const spec of TABLE_SPECS) {
    for (const row of tables[spec.store] ?? []) {
      if (spec.store === 'businesses') {
        if (row.id !== businessId) {
          throw new Error(`Snapshot ${spec.file} contains a different business '${String(row.id)}'`);
        }
      } else if (row.business_id !== businessId) {
        throw new Error(`Snapshot ${spec.file} contains a row for another business`);
      }
    }
  }
}

async function blobToText(blob: Blob): Promise<string> {
  const anyBlob = blob as unknown as {
    text?: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof anyBlob.text === 'function') return anyBlob.text();
  if (typeof anyBlob.arrayBuffer === 'function') {
    const ab = await anyBlob.arrayBuffer();
    return new TextDecoder('utf-8').decode(new Uint8Array(ab));
  }
  if (typeof Response !== 'undefined') {
    return await new Response(blob).text();
  }
  throw new Error('blobToText: no way to read Blob in this environment');
}

interface ManifestShape {
  businessId?: string;
  businessName?: string;
  schemaVersion?: number;
  journalCheckpoint?: string;
  [k: string]: unknown;
}

// Cache of the manifest that discoverBusinesses already parsed, so
// readManifest doesn't do a second fetch. Keyed by folderPath, which is
// unique across the picker context. Populated once per rebuildFromDrive call.
const manifestCache = new WeakMap<DiscoveredBusiness, ManifestShape>();

async function readManifest(
  _provider: CustomerStorageProvider,
  business: DiscoveredBusiness,
): Promise<ManifestShape> {
  const cached = manifestCache.get(business);
  if (cached) return cached;
  // No manifest was cached at discovery time — fall back to the discovery
  // metadata. journalCheckpoint left undefined → replay from the very first
  // event, which is correct for a first-time restore.
  return {
    businessId: business.businessId,
    businessName: business.businessName,
    schemaVersion: business.schemaVersion,
  };
}

async function discoverBusinesses(
  provider: CustomerStorageProvider,
): Promise<DiscoveredBusiness[]> {
  // Every real provider (LocalFolder, GoogleDrive) implements listBusinesses.
  // Test-only FakeProviders don't — for them, fall back to the "already bound
  // to a single business" path via connectionStatus.
  if (typeof provider.listBusinesses === 'function') {
    const rows = await provider.listBusinesses();
    const out: DiscoveredBusiness[] = rows.map((r) => ({
      businessId: r.businessId,
      businessName: r.businessName,
      folderPath: r.folderPath,
      schemaVersion: Number(r.manifest.schemaVersion ?? 1),
    }));
    // Wire each DiscoveredBusiness -> full manifest so readManifest can serve
    // it without a second Drive round-trip.
    for (let i = 0; i < out.length; i++) {
      manifestCache.set(out[i], rows[i].manifest as ManifestShape);
    }
    return out;
  }
  // No discovery hook — assume the provider was already bound to a single
  // business via connect(); ask connectionStatus.
  const s = await provider.connectionStatus();
  if (s.state === 'CONNECTED' && s.folderPath) {
    const name = s.folderPath.replace(/^BusinessVault\//, '');
    return [
      {
        businessId: name,
        businessName: name,
        folderPath: s.folderPath,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      },
    ];
  }
  return [];
}

async function pickLatestVerifiedSnapshot(
  provider: CustomerStorageProvider,
): Promise<SnapshotIndex | undefined> {
  // Prefer daily → monthly → annual → ondemand, most recent asOf wins overall.
  // (Daily snapshots are always the most recent per spec §13.)
  const kinds = ['daily', 'monthly', 'annual', 'ondemand'] as const;
  let best: SnapshotIndex | undefined;
  for (const kind of kinds) {
    const list = await provider.listSnapshots({ kind });
    for (const s of list) {
      if (!s.verified) continue;
      if (!best || s.handle.asOf > best.handle.asOf) best = s;
    }
  }
  return best;
}

async function rebuildItemStockFromMovements(
  db: BusinessVaultDB,
  businessId: string,
): Promise<void> {
  const movements = await db.stock_movements
    .filter((m) => m.business_id === businessId)
    .toArray();

  // Reapply the same moving-average rule used by PurchaseService. Outbound
  // movements change quantity only; positive purchase/opening/adjustment
  // movements add a cost layer. Reversals and returns preserve the current
  // average because their paired outbound movement already carries its cost.
  const byKey = new Map<string, {
    item_id: string;
    warehouse_id: string;
    qty_micros: number;
    avg_cost_paise: number;
  }>();
  for (const m of movements) {
    const key = `${businessId}:${m.item_id}:${m.warehouse_id}`;
    const existing = byKey.get(key);
    const cur = existing ?? {
      item_id: m.item_id,
      warehouse_id: m.warehouse_id,
      qty_micros: 0,
      avg_cost_paise: 0,
    };
    const oldQty = cur.qty_micros;
    const newQty = oldQty + m.qty_micros;
    if (!existing && m.qty_micros !== 0) {
      cur.avg_cost_paise = m.unit_cost_paise;
    }
    const addsCost =
      m.qty_micros > 0 &&
      (m.movement_type === 'purchase' ||
        m.movement_type === 'opening' ||
        m.movement_type === 'adjustment');
    if (
      addsCost &&
      newQty > 0 &&
      (oldQty > 0 || cur.avg_cost_paise === 0)
    ) {
      cur.avg_cost_paise = Math.round(
        (oldQty * cur.avg_cost_paise + m.qty_micros * m.unit_cost_paise) /
          newQty,
      );
    }
    cur.qty_micros = newQty;
    byKey.set(key, cur);
  }
  const now = new Date().toISOString();
  await db.transaction('rw', db.item_stock, async () => {
    await db.item_stock.where('business_id').equals(businessId).delete();
    for (const [key, v] of byKey.entries()) {
      await db.item_stock.put({
        id: key,
        business_id: businessId,
        item_id: v.item_id,
        warehouse_id: v.warehouse_id,
        qty_micros: v.qty_micros,
        avg_cost_paise: v.avg_cost_paise,
        updated_at: now,
      });
    }
  });
  log.info('restore.derived.inventory', 'restore: inventory cache rebuilt', {
    businessId,
    movementCount: movements.length,
    stockRowCount: byKey.size,
  });
}

async function rebuildDocumentSettlementBalances(
  db: BusinessVaultDB,
  businessId: string,
): Promise<void> {
  const invoices = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  const purchases = await db.purchases
    .where('business_id')
    .equals(businessId)
    .toArray();
  const payments = await db.payments
    .where('business_id')
    .equals(businessId)
    .toArray();
  const advances = await db.advances
    .where('business_id')
    .equals(businessId)
    .toArray();
  const salesReturns = await db.sales_returns
    .where('business_id')
    .equals(businessId)
    .toArray();

  // Sum ALL payment allocations that touch invoices, regardless of direction.
  // refundPayment creates a new payment row with direction='out' and NEGATIVE
  // allocation amounts against the same invoice — so summing across both the
  // original and its refund correctly reduces paid_paise. Filtering by
  // direction='in' would silently drop the refund and leave the invoice
  // appearing fully paid after restore.
  // Skip soft-deleted payments so a deleted payment doesn't zero out the
  // ledger; invoice:delete cascades already mark those.
  const paidByInvoice = new Map<string, number>();
  const paidByPurchase = new Map<string, number>();
  for (const p of payments) {
    if (p.deleted_at) continue;
    const allocs = Array.isArray(p.allocations) ? p.allocations : [];
    for (const a of allocs) {
      if (a.invoice_id) {
        paidByInvoice.set(
          a.invoice_id,
          (paidByInvoice.get(a.invoice_id) ?? 0) + a.amount_paise,
        );
      } else if (a.bill_id) {
        paidByPurchase.set(
          a.bill_id,
          (paidByPurchase.get(a.bill_id) ?? 0) + a.amount_paise,
        );
      }
    }
  }
  // Advance applications also count against invoice/purchase paid_paise.
  // AdvanceService.applyAdvance mutates invoice.paid_paise/balance_paise
  // /status in-DB but only emits an advance:updated event — no invoice
  // event carrying the post-apply state. Without this pass the restored
  // invoice ends up as if the advance never landed (silent data loss).
  for (const adv of advances) {
    if (adv.deleted_at) continue;
    const apps = Array.isArray(adv.applications) ? adv.applications : [];
    for (const a of apps) {
      if (a.invoice_id) {
        paidByInvoice.set(
          a.invoice_id,
          (paidByInvoice.get(a.invoice_id) ?? 0) + a.amount_paise,
        );
      } else if (a.bill_id) {
        paidByPurchase.set(
          a.bill_id,
          (paidByPurchase.get(a.bill_id) ?? 0) + a.amount_paise,
        );
      }
    }
  }

  const returnReductionByInvoice = new Map<string, number>();
  for (const salesReturn of salesReturns) {
    if (salesReturn.status !== 'posted' || salesReturn.deleted_at) continue;
    const balanceReduction =
      salesReturn.apply_to_balance_paise ??
      salesReturn.total_paise - (salesReturn.customer_credit_paise ?? 0);
    returnReductionByInvoice.set(
      salesReturn.original_invoice_id,
      (returnReductionByInvoice.get(salesReturn.original_invoice_id) ?? 0) +
        balanceReduction,
    );
  }

  await db.transaction('rw', [db.invoices, db.purchases], async () => {
    for (const inv of invoices) {
      const paid = paidByInvoice.get(inv.id) ?? 0;
      const balanceBeforeReturns = inv.total_paise - paid;
      const activeReturnReduction = returnReductionByInvoice.get(inv.id) ?? 0;
      const balance =
        inv.total_paise < 0
          ? balanceBeforeReturns
          : Math.max(0, balanceBeforeReturns - activeReturnReduction);
      let status = inv.status;
      if (status !== 'cancelled') {
        if (inv.status === 'draft') status = 'draft';
        else if (inv.total_paise < 0) status = 'issued';
        else if (balance <= 0) status = 'paid';
        else if (paid > 0) status = 'partial';
        else status = 'issued';
      }
      await db.invoices.put({
        ...inv,
        paid_paise: paid,
        balance_paise: balance,
        status,
      });
    }

    for (const purchase of purchases) {
      const paid = paidByPurchase.get(purchase.id) ?? 0;
      const balance = purchase.total_paise - paid;
      let status = purchase.status;
      if (status !== 'cancelled') {
        if (purchase.status === 'draft') status = 'draft';
        else if (purchase.total_paise < 0) status = 'received';
        else if (balance <= 0 && paid >= purchase.total_paise) status = 'paid';
        else if (paid > 0) status = 'partial';
        else status = 'received';
      }
      await db.purchases.put({
        ...purchase,
        paid_paise: paid,
        balance_paise: balance,
        status,
      });
    }
  });
  log.info('restore.derived.settlements', 'restore: settlement caches rebuilt', {
    businessId,
    invoiceCount: invoices.length,
    purchaseCount: purchases.length,
    paymentCount: payments.length,
    advanceCount: advances.length,
    activeSalesReturnCount: salesReturns.filter(
      (salesReturn) => salesReturn.status === 'posted' && !salesReturn.deleted_at,
    ).length,
    invoiceAllocationTargets: paidByInvoice.size,
    purchaseAllocationTargets: paidByPurchase.size,
  });
}

interface GstResult {
  ok: boolean;
  detail: Record<string, unknown>;
}

async function gstReconciliation(
  db: BusinessVaultDB,
  businessId: string,
): Promise<GstResult> {
  const invoices = await db.invoices
    .where('business_id')
    .equals(businessId)
    .toArray();
  const lines = await db.invoice_lines
    .where('business_id')
    .equals(businessId)
    .toArray();

  const linesByInvoice = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = linesByInvoice.get(l.invoice_id) ?? [];
    list.push(l);
    linesByInvoice.set(l.invoice_id, list);
  }

  const mismatches: Array<{
    invoice_id: string;
    field: string;
    header: number;
    lines: number;
  }> = [];

  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue;
    const l = linesByInvoice.get(inv.id) ?? [];
    const sumTaxable = l.reduce((s, x) => s + x.taxable_paise, 0);
    const sumCgst = l.reduce((s, x) => s + x.cgst_paise, 0);
    const sumSgst = l.reduce((s, x) => s + x.sgst_paise, 0);
    const sumIgst = l.reduce((s, x) => s + x.igst_paise, 0);
    if (l.length > 0) {
      if (sumTaxable !== inv.taxable_paise) {
        mismatches.push({
          invoice_id: inv.id,
          field: 'taxable_paise',
          header: inv.taxable_paise,
          lines: sumTaxable,
        });
      }
      if (sumCgst !== inv.cgst_paise) {
        mismatches.push({
          invoice_id: inv.id,
          field: 'cgst_paise',
          header: inv.cgst_paise,
          lines: sumCgst,
        });
      }
      if (sumSgst !== inv.sgst_paise) {
        mismatches.push({
          invoice_id: inv.id,
          field: 'sgst_paise',
          header: inv.sgst_paise,
          lines: sumSgst,
        });
      }
      if (sumIgst !== inv.igst_paise) {
        mismatches.push({
          invoice_id: inv.id,
          field: 'igst_paise',
          header: inv.igst_paise,
          lines: sumIgst,
        });
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    detail: { mismatches: mismatches.slice(0, 20), total: mismatches.length },
  };
}

async function summarizeUnshipped(
  db: BusinessVaultDB,
  businessId: string,
  businessName: string,
): Promise<UnshippedEventsSummary> {
  const rows = await db.sync_events
    .where('business_id')
    .equals(businessId)
    .toArray();
  const byStatus: Record<string, number> = {};
  const byEntityType: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    if (r.sync_status === 'SYNCED') continue;
    total++;
    byStatus[r.sync_status] = (byStatus[r.sync_status] ?? 0) + 1;
    byEntityType[r.entity_type] = (byEntityType[r.entity_type] ?? 0) + 1;
  }
  return { businessId, businessName, total, byStatus, byEntityType };
}

async function countTables(
  db: BusinessVaultDB,
  businessId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const spec of TABLE_SPECS) {
    const table = (db as unknown as Record<string, {
      where(k: string): { equals(v: unknown): { count(): Promise<number> } };
    }>)[spec.store];
    if (!table) {
      counts[spec.store] = 0;
      continue;
    }
    if (spec.store === 'businesses') {
      counts[spec.store] = (await db.businesses.get(businessId)) ? 1 : 0;
    } else {
      counts[spec.store] = await table
        .where('business_id')
        .equals(businessId)
        .count();
    }
  }
  return counts;
}

function countSnapshotTables(
  snapshotTables: SnapshotTables | null,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const spec of TABLE_SPECS) {
    counts[spec.store] = snapshotTables?.[spec.store]?.length ?? 0;
  }
  return counts;
}

const JOURNAL_ENTITY_STORE: Record<string, string> = {
  business: 'businesses',
  customer: 'customers',
  customer_item_price: 'customer_item_prices',
  supplier: 'suppliers',
  category: 'categories',
  unit: 'units',
  warehouse: 'warehouses',
  item: 'items',
  invoice: 'invoices',
  invoice_line: 'invoice_lines',
  purchase: 'purchases',
  purchase_line: 'purchase_lines',
  payment: 'payments',
  expense: 'expenses',
  advance: 'advances',
  stock_movement: 'stock_movements',
  account: 'accounts',
  journal_entry: 'journal_entries',
  journal_line: 'journal_lines',
  sales_return: 'sales_returns',
  sales_return_item: 'sales_return_items',
};

function expectedCountsAfterJournal(
  snapshotTables: SnapshotTables,
  events: SyncEvent[],
): Record<string, number> {
  const ids = new Map<string, Set<string>>();
  const counts = countSnapshotTables(snapshotTables);
  for (const spec of TABLE_SPECS) {
    const rows = snapshotTables[spec.store] ?? [];
    ids.set(spec.store, new Set(rows.map((row) => String(row[spec.pk]))));
  }

  for (const event of events) {
    const store = JOURNAL_ENTITY_STORE[event.entity_type];
    if (!store) continue;
    const storeIds = ids.get(store);
    if (!storeIds) continue;
    const payload = event.payload as Record<string, unknown>;
    const id = String(payload.id ?? event.entity_id ?? '');
    if (!id) continue;

    if (event.entity_type === 'invoice' && event.operation === 'delete' && payload.permanently_deleted === true) {
      if (storeIds.delete(id)) counts[store]--;
      removeRelatedJournalRows(snapshotTables, ids, counts, event, id);
      continue;
    }

    const putsOnUpdate = event.entity_type === 'invoice_line' ||
      event.entity_type === 'purchase_line' ||
      event.entity_type === 'journal_entry' ||
      event.entity_type === 'journal_line' ||
      event.entity_type === 'stock_movement';
    const addsRow = event.operation === 'create' ||
      (event.operation === 'update' && putsOnUpdate);
    if (addsRow && !storeIds.has(id) && event.entity_type !== 'invoice') {
      storeIds.add(id);
      counts[store] = (counts[store] ?? 0) + 1;
    } else if (addsRow && !storeIds.has(id) && event.entity_type === 'invoice' && payload.invoice_id === undefined) {
      storeIds.add(id);
      counts[store] = (counts[store] ?? 0) + 1;
    }
  }

  const stockKeys = new Set(
    (snapshotTables.stock_movements ?? []).map((row) =>
      `${row.item_id}:${row.warehouse_id}`,
    ),
  );
  for (const event of events) {
    if (event.entity_type !== 'stock_movement') continue;
    const row = event.payload as Record<string, unknown>;
    if (row.item_id !== undefined && row.warehouse_id !== undefined) {
      stockKeys.add(`${row.item_id}:${row.warehouse_id}`);
    }
  }
  counts.item_stock = stockKeys.size;
  return counts;
}

function removeRelatedJournalRows(
  snapshotTables: SnapshotTables,
  ids: Map<string, Set<string>>,
  counts: Record<string, number>,
  event: SyncEvent,
  invoiceId: string,
): void {
  const payload = event.payload as Record<string, unknown>;
  const remove = (store: string, rowId: string): void => {
    const storeIds = ids.get(store);
    if (storeIds?.delete(rowId)) counts[store]--;
  };
  for (const row of snapshotTables.invoice_lines ?? []) {
    if (row.invoice_id === invoiceId) remove('invoice_lines', String(row.id));
  }
  for (const key of ['cascaded_payment_ids', 'cascaded_advance_ids']) {
    const store = key === 'cascaded_payment_ids' ? 'payments' : 'advances';
    for (const id of Array.isArray(payload[key]) ? payload[key] as unknown[] : []) {
      remove(store, String(id));
    }
  }
}

function reconcileCounts(
  sourceCounts: Record<string, number>,
  restoredCounts: Record<string, number>,
): RestoreReport['countReconciliation'] {
  const mismatches: Record<string, { source: number; restored: number }> = {};
  for (const spec of TABLE_SPECS) {
    const source = sourceCounts[spec.store] ?? 0;
    const restored = restoredCounts[spec.store] ?? 0;
    if (source !== restored) mismatches[spec.store] = { source, restored };
  }
  return {
    exact: Object.keys(mismatches).length === 0,
    compared: true,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for callers
// ---------------------------------------------------------------------------

export { LocalFolderStorageProvider };
export { renderDiagnosticReport };
export type { SyncEvent, TableSpec };
