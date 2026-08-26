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
 *   7. rebuild derived caches (item_stock qty; invoice paid/balance)
 *   8. accountingSelfCheck + verifyInventoryIdentity + GST reconciliation
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
   * Called when more than one business is found under BusinessVault/. Not
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
}

export interface RestoreReport {
  businessId: string;
  businessName: string;
  folderPath: string;
  schemaVersion: number;
  migratedFrom?: number;
  snapshotUsed?: SnapshotHandle;
  counts: Record<string, number>;
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

  // 1. connect
  progress('Connecting to storage provider', 5);
  if (!opts.preConnectedProvider) {
    await provider.connect(opts.providerConfig);
  }

  // 2. locate BusinessVault and pick a business
  progress('Locating BusinessVault folder', 10);
  const businesses = await discoverBusinesses(provider);
  if (businesses.length === 0) {
    throw new Error('No BusinessVault/<business> folder found on the provider');
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

  // Bind the provider to the selected business so subsequent journal/snapshot
  // reads know which folder to look in.
  await provider.initializeBusiness({
    businessId: selected.businessId,
    businessName: selected.businessName,
  });

  // 3. read + validate manifest
  progress('Reading manifest', 15);
  const manifest = await readManifest(provider, selected);
  const foundSchema = Number(manifest.schemaVersion ?? selected.schemaVersion ?? 0);
  if (foundSchema > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(foundSchema, CURRENT_SCHEMA_VERSION);
  }

  // 4. checksum verification (spec §7)
  progress('Verifying backup integrity', 25);
  const integrity = await provider.verifyIntegrity();
  const checksumsOk = integrity.ok;
  if (!checksumsOk) {
    throw new BackupIntegrityError(
      'Backup integrity verification failed',
      integrity.issues,
    );
  }

  // 4a. Guard against destroying unshipped local work. Any sync_events row for
  // this business whose sync_status != 'SYNCED' represents user work that
  // exists on this device but has NOT yet reached the backup folder — the
  // sync worker either never ran or has been failing (folder permission
  // revoked, handle stale, offline). rebuildFromDrive is destructive: step 5
  // calls table.clear() on every domain table and sync_events. Wiping that
  // without warning is data-loss. See "restore-from-backup shows empty data"
  // regression from bhawna business (folder had only the 51 seed events).
  const unshipped = await summarizeUnshipped(opts.db, selected.businessId, selected.businessName);
  if (unshipped.total > 0 && !opts.confirmDataLoss) {
    throw new UnshippedEventsError(unshipped);
  }

  // 5. pick + load the latest verified snapshot
  progress('Loading latest backup', 40);
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
  }

  // Read the journal BEFORE clearing local state so we can bail out cleanly
  // when the backup is empty. Reading is idempotent and cheap compared to
  // wiping the DB and then discovering there was nothing to restore.
  const sinceEventId =
    (manifest.journalCheckpoint as string | undefined) ?? undefined;
  const events = await provider.readJournalEvents({
    businessId: selected.businessId,
    sinceEventId,
  });

  // Zero snapshots + zero journal events = a backup folder that was never
  // populated (e.g. business onboarded to Drive but the sync worker never
  // successfully flushed). Wiping local tables and reporting "Restore
  // complete ✓" against this is silent data-loss — refuse instead.
  if (!snapshotIndex && events.length === 0) {
    throw new EmptyBackupError(
      selected.businessId,
      selected.businessName,
      selected.folderPath,
    );
  }

  // Bulk-insert snapshot into Dexie under ONE transaction. If anything throws,
  // Dexie rolls back leaving the database in its pre-restore state (which
  // rebuildFromDrive already cleared at the head of the transaction — so on
  // failure the DB is empty and the caller can retry).
  progress('Rebuilding local database', 55);
  await opts.db.transaction(
    'rw',
    tableNames(),
    async () => {
      for (const spec of TABLE_SPECS) {
        // Clear + repopulate each table. Even if the snapshot lacks the file
        // we clear — restore is a full replacement.
        const table = (opts.db as unknown as Record<string, {
          clear(): Promise<void>;
          bulkPut(rows: unknown[]): Promise<unknown>;
        }>)[spec.store];
        if (!table) continue;
        await table.clear();
        const rows = snapshotTables[spec.store];
        if (rows && rows.length > 0) {
          await table.bulkPut(rows);
        }
      }
      // Truncate the sync_events store too — restore starts a fresh journal.
      await opts.db.sync_events.clear();
    },
  );

  // 6. replay journal events after the snapshot's checkpoint
  progress('Replaying journal events', 70);

  const diagnostics: string[] = [];
  let replayed = 0;
  let unhandled = 0;

  await opts.db.transaction(
    'rw',
    tableNames(),
    async () => {
      for (const evt of events) {
        try {
          const result = await applyEvent(evt, {
            db: opts.db,
            businessId: selected.businessId,
            diagnostics,
          });
          if (result === 'applied') replayed++;
          else unhandled++;
        } catch (err) {
          diagnostics.push(
            `event ${evt.event_id} (${evt.entity_type}:${evt.operation}) failed: ${(err as Error).message}`,
          );
        }
      }
    },
  );

  // 7. rebuild derived caches
  progress('Rebuilding derived tables', 80);
  await rebuildItemStockFromMovements(opts.db, selected.businessId);
  await rebuildInvoicePaidBalance(opts.db, selected.businessId);

  // 8. run validators (spec §27)
  progress('Verifying accounting and inventory', 90);
  const issues: DiagnosticIssue[] = [];
  for (const d of diagnostics) {
    issues.push({ severity: 'warning', code: 'REPLAY_WARNING', message: d });
  }

  const acct = await accountingSelfCheck(selected.businessId, { db: opts.db });
  const accountingBalanced = acct.debitsEqCredits && acct.unbalancedEntries.length === 0;
  if (!accountingBalanced) {
    issues.push({
      severity: 'error',
      code: 'ACCOUNTING_UNBALANCED',
      message:
        'SUM(debits) != SUM(credits) after restore. Never silently modify accounting records.',
      detail: {
        totalDebits: acct.totalDebits,
        totalCredits: acct.totalCredits,
        unbalancedEntries: acct.unbalancedEntries.slice(0, 20),
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
  const counts = await countTables(opts.db, selected.businessId);
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

  progress('Restore complete', 100);

  return {
    businessId: selected.businessId,
    businessName: selected.businessName,
    folderPath: selected.folderPath,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    migratedFrom,
    snapshotUsed: snapshotHandle,
    counts,
    eventsReplayed: replayed,
    unhandledEvents: unhandled,
    checksumsOk,
    accountingBalanced,
    inventoryConsistent,
    gstReconciled,
    diagnostics: report,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    'purchases',
    'purchase_lines',
    'payments',
    'expenses',
    'stock_movements',
    'accounts',
    'journal_entries',
    'journal_lines',
    'advances',
    'sync_events',
  ];
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
    const rows: Record<string, unknown>[] = [];
    for (const raw of parsed.rows) {
      rows.push(coerceRow(raw, spec));
    }
    out[spec.store] = rows;
  }
  return out;
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
  // Sum qty per (item, warehouse). Cost = last non-zero unit_cost_paise seen.
  const byKey = new Map<string, {
    item_id: string;
    warehouse_id: string;
    qty_micros: number;
    avg_cost_paise: number;
  }>();
  for (const m of movements) {
    const key = `${businessId}:${m.item_id}:${m.warehouse_id}`;
    const cur = byKey.get(key) ?? {
      item_id: m.item_id,
      warehouse_id: m.warehouse_id,
      qty_micros: 0,
      avg_cost_paise: 0,
    };
    cur.qty_micros += m.qty_micros;
    if (m.unit_cost_paise > 0) cur.avg_cost_paise = m.unit_cost_paise;
    byKey.set(key, cur);
  }
  const now = new Date().toISOString();
  await db.transaction('rw', db.item_stock, async () => {
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
}

async function rebuildInvoicePaidBalance(
  db: BusinessVaultDB,
  businessId: string,
): Promise<void> {
  const invoices = await db.invoices
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

  // Sum ALL payment allocations that touch invoices, regardless of direction.
  // refundPayment creates a new payment row with direction='out' and NEGATIVE
  // allocation amounts against the same invoice — so summing across both the
  // original and its refund correctly reduces paid_paise. Filtering by
  // direction='in' would silently drop the refund and leave the invoice
  // appearing fully paid after restore.
  // Skip soft-deleted payments so a deleted payment doesn't zero out the
  // ledger; invoice:delete cascades already mark those.
  const paidByInvoice = new Map<string, number>();
  for (const p of payments) {
    if (p.deleted_at) continue;
    const allocs = Array.isArray(p.allocations) ? p.allocations : [];
    for (const a of allocs) {
      if (!a.invoice_id) continue;
      paidByInvoice.set(
        a.invoice_id,
        (paidByInvoice.get(a.invoice_id) ?? 0) + a.amount_paise,
      );
    }
  }
  // Advance applications also count against invoice paid_paise.
  // AdvanceService.applyAdvance mutates invoice.paid_paise/balance_paise
  // /status in-DB but only emits an advance:updated event — no invoice
  // event carrying the post-apply state. Without this pass the restored
  // invoice ends up as if the advance never landed (silent data loss).
  for (const adv of advances) {
    if (adv.deleted_at) continue;
    const apps = Array.isArray(adv.applications) ? adv.applications : [];
    for (const a of apps) {
      if (!a.invoice_id) continue;
      paidByInvoice.set(
        a.invoice_id,
        (paidByInvoice.get(a.invoice_id) ?? 0) + a.amount_paise,
      );
    }
  }

  await db.transaction('rw', db.invoices, async () => {
    for (const inv of invoices) {
      const paid = paidByInvoice.get(inv.id) ?? 0;
      const balance = inv.total_paise - paid;
      let status = inv.status;
      if (status !== 'cancelled') {
        if (paid <= 0) status = 'issued';
        else if (paid >= inv.total_paise) status = 'paid';
        else status = 'partial';
      }
      await db.invoices.put({
        ...inv,
        paid_paise: paid,
        balance_paise: balance,
        status,
      });
    }
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
      counts[spec.store] = await db.businesses.count();
    } else {
      counts[spec.store] = await table
        .where('business_id')
        .equals(businessId)
        .count();
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Re-exports for callers
// ---------------------------------------------------------------------------

export { LocalFolderStorageProvider };
export { renderDiagnosticReport };
export type { SyncEvent, TableSpec };
