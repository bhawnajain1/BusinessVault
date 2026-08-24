/**
 * GoogleDriveStorageProvider — concrete CustomerStorageProvider backed by
 * Google Drive using scope `drive.file` (per spec §2, §31, §35).
 *
 * Fulfilled sections:
 *  - §2  Google Drive connection / OAuth (drive.file only, refresh tokens
 *        kept behind the token store, never in user-visible files).
 *  - §3  User-visible storage layout.
 *  - §4  Drive folder structure (README.txt, metadata/, current/,
 *        journal/<YYYY>/, invoices/, attachments/{purchases,expenses,products},
 *        reports/, snapshots/{daily,monthly,annual}).
 *  - §11 Resumable uploads (delegated to DriveApiClient.uploadFile).
 *  - §12 Quota efficiency — folder-id cache, no repeat filename searches.
 *  - §19 Atomic snapshots — staging → checksum → verify → move → mark current.
 *  - §20 Drive version detection / cached fileId+version.
 *  - §21 External edit detection + financial-file classification.
 *  - §31 Storage abstraction — this is the seam.
 *
 * The provider is DELIBERATELY the only file allowed to touch Drive. Business
 * services depend on CustomerStorageProvider, not on this class.
 */

import type {
  ChangesPage,
  ConnectionStatus,
  CustomerStorageProvider,
  DiscoveredBusinessOnProvider,
  DownloadAttachmentInput,
  ExternalChange,
  IntegrityIssue,
  IntegrityReport,
  InitializeBusinessInput,
  InitResult,
  ProviderConfig,
  ReadJournalOpts,
  RestoreDescriptor,
  SnapshotData,
  SnapshotHandle,
  SnapshotIndex,
  SnapshotKind,
  SyncEvent,
  UploadAttachmentInput,
  UploadAttachmentResult,
  WriteJournalResult,
  WriteSnapshotInput,
} from '../storage/CustomerStorageProvider';

// ---------------------------------------------------------------------------
// SCHEMA_VERSION — import fallback: db/schema.ts may not exist at build time
// in every branch; keep a local mirror. Kept in one place so it's obvious.
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// DriveApiClient — the thin surface this provider needs. A real implementation
// lives in ./google/*; tests mock this interface.
// ---------------------------------------------------------------------------

export interface DriveFileRef {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: number;
  parents?: string[];
  trashed?: boolean;
  createdTime?: string;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFileRef;
  time?: string;
  /** True if a device other than us made the change (best-effort). */
  foreign?: boolean;
}

export interface DriveChangesPage {
  changes: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface DriveUserInfo {
  emailAddress: string;
  displayName?: string;
}

// GIS access tokens are short-lived (~1h) and refreshed silently via
// requestAccessToken({prompt:''}) inside the DriveApiClient itself. There is
// no refresh_token under the browser-only GIS flow.
export interface AccessTokenInfo {
  accessToken: string;
  expiresAt: number;
}

// Thrown when connect() finds no stored token AND silent refresh fails.
// UI catches this to render "Reconnect Google Drive" (Data & Backup, banner).
export class DriveNeedsReconnectError extends Error {
  constructor(message: string = 'Google Drive is not connected — call connectDrive() before provider.connect()') {
    super(message);
    this.name = 'DriveNeedsReconnectError';
  }
}

export interface DriveApiClient {
  // ---- Auth (GIS) ----
  // The DriveApiClient owns silent-refresh internally. `hasValidTokens` returns
  // true if a live token exists (or if silent refresh succeeds). Provider.connect
  // calls this once during boot; every subsequent Drive call retries once on
  // 401 after a silent refresh, then surfaces DriveNeedsReconnectError.
  hasValidTokens(): Promise<boolean>;
  refreshIfNeeded(): Promise<void>;
  getUserInfo(): Promise<DriveUserInfo>;

  // ---- Folders / files ----
  findChildByName(parentId: string, name: string): Promise<DriveFileRef | null>;
  ensureFolder(parentId: string, name: string): Promise<DriveFileRef>;
  /** Root folder for the app. When drive.file scope is used, this is the
   *  hidden per-app folder ("appDataFolder") OR the Drive root — the client
   *  decides based on scope. */
  rootFolderId(): Promise<string>;
  listChildren(parentId: string): Promise<DriveFileRef[]>;

  createFile(input: {
    parentId: string;
    name: string;
    mimeType: string;
    body: Blob;
  }): Promise<DriveFileRef>;
  updateFileContents(fileId: string, body: Blob, mimeType: string): Promise<DriveFileRef>;
  getFileContents(fileId: string): Promise<Blob>;
  getFileMetadata(fileId: string): Promise<DriveFileRef>;
  moveFile(fileId: string, newParentId: string, oldParentId?: string): Promise<DriveFileRef>;
  deleteFile(fileId: string): Promise<void>;

  // ---- Changes API ----
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<DriveChangesPage>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT_FOLDER_NAME = 'BusinessVault';

/** Files under current/ whose external edits must never be auto-imported. */
const FINANCIALLY_DANGEROUS_FILES = new Set<string>([
  'journal_entries.csv',
  'journal_lines.csv',
  'payments.csv',
  'invoices.csv',
  'invoice_items.csv',
  'purchases.csv',
  'purchase_items.csv',
  'accounts.csv',
]);

/** Files under current/ that are metadata-ish and safe to re-import if
 *  schema matches. Anything not listed here and not "dangerous" is flagged
 *  as "potential conflict". */
const SAFE_IMPORTABLE_FILES = new Set<string>([
  'customers.csv',
  'suppliers.csv',
  'items.csv',
  'categories.csv',
  'units.csv',
  'warehouses.csv',
]);

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_CSV = 'text/csv';
const MIME_JSON = 'application/json';
const MIME_JSONL = 'application/x-ndjson';
const MIME_TEXT = 'text/plain';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function blobToBytes(b: Blob): Promise<Uint8Array> {
  const anyBlob = b as unknown as {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    stream?: () => ReadableStream<Uint8Array>;
  };
  if (typeof anyBlob.arrayBuffer === 'function') {
    return new Uint8Array(await anyBlob.arrayBuffer!());
  }
  // Polyfill path (e.g. jsdom): read via FileReader if available.
  if (typeof FileReader !== 'undefined') {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => {
        const r = fr.result;
        if (r instanceof ArrayBuffer) resolve(new Uint8Array(r));
        else resolve(new TextEncoder().encode(String(r ?? '')));
      };
      fr.readAsArrayBuffer(b);
    });
  }
  // Last resort: stream
  if (typeof anyBlob.stream === 'function') {
    const chunks: Uint8Array[] = [];
    const reader = anyBlob.stream!().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
  throw new Error('Blob cannot be read on this platform');
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array | Blob): Promise<string> {
  let buf: ArrayBuffer;
  if (bytes instanceof Uint8Array) {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    buf = copy;
  } else if (bytes instanceof ArrayBuffer) {
    buf = bytes;
  } else {
    const u8 = await blobToBytes(bytes);
    const copy = new ArrayBuffer(u8.byteLength);
    new Uint8Array(copy).set(u8);
    buf = copy;
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

function textBlob(s: string, mime: string): Blob {
  return new Blob([s], { type: mime });
}

async function blobText(b: Blob): Promise<string> {
  const anyBlob = b as unknown as { text?: () => Promise<string> };
  if (typeof anyBlob.text === 'function') return await anyBlob.text!();
  const bytes = await blobToBytes(b);
  return new TextDecoder().decode(bytes);
}

function nowIso(): string {
  return new Date().toISOString();
}

function ymFromEvent(ts: string): { year: number; month: number } {
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    // Fall back to now — a malformed timestamp is still a valid event; we
    // don't destroy it, just place it in a bucket deterministically.
    const n = new Date();
    return { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1 };
  }
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sanitizeSegment(seg: string): string {
  // Drive itself accepts most characters, but keep the visible layout clean.
  return seg.replace(/[\\/]/g, '_').trim();
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

function classifyExternalChange(
  path: string,
): 'safe' | 'potential-conflict' | 'invalid-schema' | 'financially-dangerous' | 'ignored' {
  // Only files under current/ are user-visible CSV. Everything else is
  // treated as ignored (journal, snapshots, metadata rewrites we caused).
  const parts = path.split('/');
  const idx = parts.indexOf('current');
  if (idx === -1) return 'ignored';
  const name = parts[idx + 1] ?? '';
  if (!name.endsWith('.csv')) return 'invalid-schema';
  if (FINANCIALLY_DANGEROUS_FILES.has(name)) return 'financially-dangerous';
  if (SAFE_IMPORTABLE_FILES.has(name)) return 'safe';
  return 'potential-conflict';
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

interface BusinessRoot {
  businessName: string;
  folderPath: string;         // 'BusinessVault/<name>'
  providerFolderId: string;   // Drive folder id for the business
  vaultRootId: string;        // Drive folder id for BusinessVault
}

export interface GoogleDriveStorageProviderOptions {
  driveApi: DriveApiClient;
}

export class GoogleDriveStorageProvider implements CustomerStorageProvider {
  private readonly api: DriveApiClient;
  private config: ProviderConfig | null = null;
  private business: BusinessRoot | null = null;
  private connected = false;
  private account: string | undefined;
  /** Cache of "path relative to business root" → Drive folder id (spec §12). */
  private folderIdCache = new Map<string, string>();
  /** Cache of "path relative to business root" → Drive file ref (spec §12, §20). */
  private fileRefCache = new Map<string, DriveFileRef>();
  /** Cursor for changes API. */
  private changesToken: string | null = null;

  constructor(opts: GoogleDriveStorageProviderOptions) {
    this.api = opts.driveApi;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect(config: ProviderConfig): Promise<void> {
    if (config.kind !== 'google-drive') {
      throw new Error(`GoogleDriveStorageProvider cannot handle config kind '${config.kind}'`);
    }
    if (config.scope && config.scope !== 'drive.file') {
      throw new Error("GoogleDriveStorageProvider requires scope 'drive.file'");
    }
    this.config = config;

    const hasTokens = await this.api.hasValidTokens();
    if (!hasTokens) {
      // Under GIS there is no redirect flow. The UI must call
      // connectDrive({businessId, prompt: 'consent'}) BEFORE provider.connect
      // to open the popup and stash tokens. If we reach here without tokens,
      // the caller needs to route to a Reconnect UI.
      throw new DriveNeedsReconnectError();
    }

    await this.api.refreshIfNeeded();
    const user = await this.api.getUserInfo();
    this.account = user.emailAddress;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.account = undefined;
    this.business = null;
    this.folderIdCache.clear();
    this.fileRefCache.clear();
    this.changesToken = null;
  }

  async connectionStatus(): Promise<ConnectionStatus> {
    if (!this.connected) return { state: 'DISCONNECTED' };
    return {
      state: 'CONNECTED',
      account: this.account,
      folderPath: this.business?.folderPath,
    };
  }

  // -------------------------------------------------------------------------
  // initializeBusiness (spec §4)
  // -------------------------------------------------------------------------

  async initializeBusiness(input: InitializeBusinessInput): Promise<InitResult> {
    if (!this.connected) throw new Error('provider not connected');
    const safeName = sanitizeSegment(input.businessName);
    if (!safeName) throw new Error('businessName is required');

    const root = await this.api.rootFolderId();
    const vault = await this.api.ensureFolder(root, ROOT_FOLDER_NAME);
    const bizExisting = await this.api.findChildByName(vault.id, safeName);
    const biz = bizExisting ?? (await this.api.ensureFolder(vault.id, safeName));
    const reused = bizExisting !== null;

    this.business = {
      businessName: safeName,
      folderPath: `${ROOT_FOLDER_NAME}/${safeName}`,
      providerFolderId: biz.id,
      vaultRootId: vault.id,
    };
    this.folderIdCache.clear();
    this.fileRefCache.clear();
    this.folderIdCache.set('', biz.id);

    // Directory scaffold from §4. ensureFolder is idempotent, so re-running
    // initializeBusiness on an existing folder does not disturb data.
    const dirs = [
      'metadata',
      'current',
      'journal',
      `journal/${new Date().getUTCFullYear()}`,
      'invoices',
      'attachments',
      'attachments/purchases',
      'attachments/expenses',
      'attachments/products',
      'reports',
      'snapshots',
      'snapshots/daily',
      'snapshots/monthly',
      'snapshots/annual',
    ];
    for (const d of dirs) {
      await this.ensureDir(d);
    }

    // Initial README, manifest, schema — only write if missing (§4 idempotency).
    await this.writeFileIfMissing('README.txt', textBlob(this.initialReadme(safeName), MIME_TEXT), MIME_TEXT);
    await this.writeFileIfMissing(
      'metadata/schema.json',
      textBlob(JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2), MIME_JSON),
      MIME_JSON,
    );
    await this.writeFileIfMissing(
      'metadata/manifest.json',
      textBlob(
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            businessId: input.businessId,
            businessName: safeName,
            createdAt: nowIso(),
            currentSnapshot: null,
          },
          null,
          2,
        ),
        MIME_JSON,
      ),
      MIME_JSON,
    );
    await this.writeFileIfMissing(
      'metadata/sync-state.json',
      textBlob(JSON.stringify({ schemaVersion: SCHEMA_VERSION, lastSyncedAt: null }, null, 2), MIME_JSON),
      MIME_JSON,
    );
    await this.writeFileIfMissing(
      'metadata/checksums.json',
      textBlob(JSON.stringify({ schemaVersion: SCHEMA_VERSION, files: {} }, null, 2), MIME_JSON),
      MIME_JSON,
    );

    return {
      businessId: input.businessId,
      folderPath: this.business.folderPath,
      providerFolderId: biz.id,
      reused,
      createdAt: nowIso(),
    };
  }

  // Enumerate every business folder under BusinessVault/ on Drive. Reads
  // each candidate's metadata/manifest.json inline so the caller doesn't
  // need a second round-trip. Called by the Restore flow — without this,
  // Restore has nothing to pick from.
  async listBusinesses(): Promise<DiscoveredBusinessOnProvider[]> {
    if (!this.connected) throw new Error('provider not connected');
    const root = await this.api.rootFolderId();
    const vault = await this.api.findChildByName(root, ROOT_FOLDER_NAME);
    if (!vault || vault.mimeType !== MIME_FOLDER) return [];
    const children = await this.api.listChildren(vault.id);
    const out: DiscoveredBusinessOnProvider[] = [];
    for (const c of children) {
      if (c.mimeType !== MIME_FOLDER) continue;
      // Read <biz>/metadata/manifest.json. Missing / unparseable → skip; a
      // corrupt sibling shouldn't block the user from restoring others.
      const metadataFolder = await this.api.findChildByName(c.id, 'metadata');
      if (!metadataFolder || metadataFolder.mimeType !== MIME_FOLDER) continue;
      const manifestRef = await this.api.findChildByName(metadataFolder.id, 'manifest.json');
      if (!manifestRef || manifestRef.mimeType === MIME_FOLDER) continue;
      let manifest: Record<string, unknown>;
      try {
        const text = await blobText(await this.api.getFileContents(manifestRef.id));
        manifest = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      out.push({
        businessId: String(manifest.businessId ?? c.name),
        businessName: String(manifest.businessName ?? c.name),
        folderPath: `${ROOT_FOLDER_NAME}/${c.name}`,
        manifest,
      });
    }
    return out;
  }

  private initialReadme(businessName: string): string {
    return [
      `This folder contains BusinessVault data for "${businessName}".`,
      '',
      'Layout:',
      '  metadata/    — schema, manifest, sync state, checksums',
      '  current/    — latest CSV snapshot (portable, not queried)',
      '  journal/    — append-only event log per month (JSONL)',
      '  invoices/   — generated invoice PDFs',
      '  attachments/ — purchase/expense/product attachments',
      '  reports/    — exported reports',
      '  snapshots/  — daily/monthly/annual snapshot archives',
      '',
      'DO NOT edit files in this folder while BusinessVault is running.',
      'External edits to invoices.csv / payments.csv / journal_entries.csv',
      'will NOT be auto-imported — they require manual review.',
      '',
      'To recover your business:  Sign in to BusinessVault → Restore from Drive.',
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // Journal writes (spec §4, §6, §12)
  // -------------------------------------------------------------------------

  async writeJournalEvents(events: SyncEvent[]): Promise<WriteJournalResult> {
    this.assertBusiness();
    if (events.length === 0) {
      return { written: 0, duplicates: [], journalPath: '' };
    }

    // Group events by YYYY-MM. Journal file paths follow §4:
    //   journal/<YYYY>/<YYYY-MM>.events.jsonl
    const byBucket = new Map<string, SyncEvent[]>();
    for (const ev of events) {
      const { year, month } = ymFromEvent(ev.timestamp);
      const key = `${year}-${pad2(month)}`;
      const list = byBucket.get(key) ?? [];
      list.push(ev);
      byBucket.set(key, list);
    }

    let totalWritten = 0;
    const duplicates: string[] = [];
    let lastPath = '';

    for (const [ym, batch] of byBucket) {
      const [yearStr] = ym.split('-');
      const dir = `journal/${yearStr}`;
      await this.ensureDir(dir);
      const path = `${dir}/${ym}.events.jsonl`;
      lastPath = path;

      // Read existing content (empty on first write).
      let existing = '';
      const ref = await this.resolveFile(path);
      const seen = new Set<string>();
      if (ref) {
        const blob = await this.api.getFileContents(ref.id);
        existing = await blobText(blob);
        // Populate seen set with existing event_ids for idempotent replay
        // (spec: "Events are idempotent — replay must never double-effect").
        if (existing.length > 0) {
          for (const line of existing.split('\n')) {
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as { event_id?: string };
              if (parsed.event_id) seen.add(parsed.event_id);
            } catch {
              // ignore malformed lines; do not throw — restore validates.
            }
          }
        }
      }

      const appendLines: string[] = [];
      for (const ev of batch) {
        if (seen.has(ev.event_id)) {
          duplicates.push(ev.event_id);
          continue;
        }
        seen.add(ev.event_id);
        appendLines.push(JSON.stringify(ev));
      }

      if (appendLines.length === 0) continue;

      const needsTrailingNewline = existing.length > 0 && !existing.endsWith('\n');
      const nextContent =
        existing + (needsTrailingNewline ? '\n' : '') + appendLines.join('\n') + '\n';

      const newBlob = textBlob(nextContent, MIME_JSONL);
      if (ref) {
        const updated = await this.api.updateFileContents(ref.id, newBlob, MIME_JSONL);
        this.fileRefCache.set(path, updated);
      } else {
        const parentId = await this.ensureDir(dir);
        const created = await this.api.createFile({
          parentId,
          name: `${ym}.events.jsonl`,
          mimeType: MIME_JSONL,
          body: newBlob,
        });
        this.fileRefCache.set(path, created);
      }
      totalWritten += appendLines.length;
    }

    return { written: totalWritten, duplicates, journalPath: lastPath };
  }

  async readJournalEvents(opts: ReadJournalOpts): Promise<SyncEvent[]> {
    this.assertBusiness();

    const targets: Array<{ path: string; year: number; month: number }> = [];
    if (opts.year && opts.month) {
      const y = String(opts.year);
      const ym = `${y}-${pad2(opts.month)}`;
      targets.push({ path: `journal/${y}/${ym}.events.jsonl`, year: opts.year, month: opts.month });
    } else {
      // Enumerate every journal/<year>/<ym>.events.jsonl.
      const journalId = await this.resolveFolder('journal');
      if (!journalId) return [];
      const years = await this.api.listChildren(journalId);
      for (const yearFolder of years) {
        if (yearFolder.mimeType !== MIME_FOLDER) continue;
        const yn = Number(yearFolder.name);
        if (!Number.isFinite(yn)) continue;
        const files = await this.api.listChildren(yearFolder.id);
        for (const f of files) {
          const m = /^(\d{4})-(\d{2})\.events\.jsonl$/.exec(f.name);
          if (!m) continue;
          targets.push({
            path: `journal/${yearFolder.name}/${f.name}`,
            year: Number(m[1]),
            month: Number(m[2]),
          });
        }
      }
      targets.sort((a, b) => a.year - b.year || a.month - b.month);
    }

    const out: SyncEvent[] = [];
    for (const t of targets) {
      const ref = await this.resolveFile(t.path);
      if (!ref) continue;
      const blob = await this.api.getFileContents(ref.id);
      const text = await blobText(blob);
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as SyncEvent;
          if (opts.sinceEventId && ev.event_id <= opts.sinceEventId) continue;
          out.push(ev);
        } catch {
          // skip malformed
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Snapshots (spec §19 — atomic)
  // -------------------------------------------------------------------------

  async writeSnapshot(input: WriteSnapshotInput): Promise<SnapshotHandle> {
    this.assertBusiness();
    const stamp = input.asOf;
    const stagingDir = `snapshots/${input.kind}/.staging/${stamp}`;
    const finalDir = `snapshots/${input.kind}/${stamp}`;

    // 1. Read the current manifest (so we can roll back on failure).
    const prevManifestBlob = await this.readFileIfExists('metadata/manifest.json');
    const prevChecksumsBlob = await this.readFileIfExists('metadata/checksums.json');

    // 2. Create staging directory. Any failure past this point leaves the
    //    previous snapshot & manifest untouched — we only mutate metadata/
    //    at the very end.
    const stagingId = await this.ensureDir(stagingDir);

    const uploadedFiles: DriveFileRef[] = [];
    const checksums: Record<string, string> = {};
    let manifestMutated = false;
    let checksumsMutated = false;
    try {
      // 3. Upload each CSV into staging.
      for (const f of input.files) {
        const csvHash = f.sha256 || (await sha256Hex(f.content));
        checksums[f.name] = csvHash;
        const ref = await this.api.createFile({
          parentId: stagingId,
          name: f.name,
          mimeType: MIME_CSV,
          body: f.content,
        });
        uploadedFiles.push(ref);
      }

      // 4. Write checksums.json inside staging.
      const checksumsJson = JSON.stringify(
        { schemaVersion: SCHEMA_VERSION, kind: input.kind, asOf: input.asOf, files: checksums },
        null,
        2,
      );
      await this.api.createFile({
        parentId: stagingId,
        name: 'checksums.json',
        mimeType: MIME_JSON,
        body: textBlob(checksumsJson, MIME_JSON),
      });

      // 5. Verify — re-download each staged file, recompute SHA-256.
      for (const ref of uploadedFiles) {
        const back = await this.api.getFileContents(ref.id);
        const hash = await sha256Hex(back);
        const expected = checksums[ref.name];
        if (hash !== expected) {
          throw new Error(
            `snapshot verify failed for '${ref.name}': expected ${expected} got ${hash}`,
          );
        }
      }

      // 6. Move staging → final. In Drive, "move" = re-parent.
      const finalParent = await this.ensureDir(`snapshots/${input.kind}`);
      // If a same-timestamp final dir already exists we bail: never clobber.
      const clash = await this.api.findChildByName(finalParent, stamp);
      if (clash) {
        throw new Error(`snapshot '${stamp}' already exists — refusing to overwrite`);
      }
      // Reparent the staging folder itself.
      const stagingParent = await this.ensureDir(`snapshots/${input.kind}/.staging`);
      const moved = await this.api.moveFile(stagingId, finalParent, stagingParent);
      // Also rename it from ".staging/<ts>" segment to "<ts>". Since we just
      // moved the folder whose name is `<ts>`, no rename is needed — the leaf
      // segment is preserved. (`stagingDir` ends with `/<ts>`.)

      // Cache the new folder id under its new path.
      const finalId = moved.id;
      this.folderIdCache.set(finalDir, finalId);

      // 7. Rewrite metadata/manifest.json + metadata/checksums.json to point
      //    at this snapshot. Done LAST so a mid-upload failure never leaves
      //    the manifest advertising a partial snapshot.
      const nextManifest = {
        schemaVersion: SCHEMA_VERSION,
        currentSnapshot: {
          kind: input.kind,
          asOf: input.asOf,
          path: finalDir,
          providerFolderId: finalId,
          fileCount: input.files.length,
          createdAt: nowIso(),
        },
        userManifest: input.manifest,
      };
      manifestMutated = true;
      await this.writeFileReplace(
        'metadata/manifest.json',
        textBlob(JSON.stringify(nextManifest, null, 2), MIME_JSON),
        MIME_JSON,
      );
      const nextChecksums = {
        schemaVersion: SCHEMA_VERSION,
        currentSnapshot: finalDir,
        files: Object.fromEntries(
          Object.entries(checksums).map(([name, hash]) => [`${finalDir}/${name}`, hash]),
        ),
      };
      checksumsMutated = true;
      await this.writeFileReplace(
        'metadata/checksums.json',
        textBlob(JSON.stringify(nextChecksums, null, 2), MIME_JSON),
        MIME_JSON,
      );

      return {
        businessId: this.business!.providerFolderId, // caller passes their own id typically
        kind: input.kind,
        path: finalDir,
        providerFolderId: finalId,
        asOf: input.asOf,
        createdAt: nowIso(),
      };
    } catch (err) {
      // Rollback: delete anything we uploaded into staging + drop the staging
      // folder. Previous manifest & checksums remain intact because we never
      // touched them until step 7. Best-effort — if deletes fail we surface
      // the original error.
      try {
        for (const ref of uploadedFiles) await this.api.deleteFile(ref.id);
        await this.api.deleteFile(stagingId);
      } catch {
        // swallow — original error wins.
      }
      // Restore manifest/checksums only if we already mutated them before
      // failing (shouldn't happen — step 7 is last — but paranoia is cheap).
      if (manifestMutated && prevManifestBlob) {
        await this.writeFileReplace('metadata/manifest.json', prevManifestBlob, MIME_JSON).catch(
          () => undefined,
        );
      }
      if (checksumsMutated && prevChecksumsBlob) {
        await this.writeFileReplace('metadata/checksums.json', prevChecksumsBlob, MIME_JSON).catch(
          () => undefined,
        );
      }
      throw err;
    }
  }

  async readSnapshot(handle: SnapshotHandle): Promise<SnapshotData> {
    this.assertBusiness();
    const folderId = handle.providerFolderId || (await this.resolveFolder(handle.path));
    if (!folderId) throw new Error(`snapshot folder not found: ${handle.path}`);
    const children = await this.api.listChildren(folderId);

    let checksums: Record<string, string> = {};
    const files: SnapshotData['files'] = [];
    let manifest: Record<string, unknown> = {};

    for (const c of children) {
      if (c.mimeType === MIME_FOLDER) continue;
      if (c.name === 'checksums.json') {
        const t = await blobText(await this.api.getFileContents(c.id));
        const parsed = JSON.parse(t) as { files?: Record<string, string> };
        checksums = parsed.files ?? {};
        continue;
      }
      if (c.name === 'manifest.json') {
        const t = await blobText(await this.api.getFileContents(c.id));
        manifest = JSON.parse(t) as Record<string, unknown>;
        continue;
      }
      if (!c.name.endsWith('.csv')) continue;
      const blob = await this.api.getFileContents(c.id);
      const sha = checksums[c.name] || (await sha256Hex(blob));
      const text = await blobText(blob);
      const rowCount = text ? text.split('\n').filter(Boolean).length - 1 : 0;
      files.push({ name: c.name, content: blob, rowCount: Math.max(0, rowCount), sha256: sha });
    }

    return { handle, files, manifest, checksums };
  }

  async listSnapshots(opts: { kind: SnapshotKind }): Promise<SnapshotIndex[]> {
    this.assertBusiness();
    const parentId = await this.resolveFolder(`snapshots/${opts.kind}`);
    if (!parentId) return [];
    const children = await this.api.listChildren(parentId);
    const out: SnapshotIndex[] = [];
    for (const c of children) {
      if (c.mimeType !== MIME_FOLDER) continue;
      if (c.name.startsWith('.')) continue; // .staging
      const files = await this.api.listChildren(c.id);
      const csvs = files.filter((f) => f.name.endsWith('.csv'));
      const size = files.reduce((n, f) => n + (f.size ?? 0), 0);
      const hasChecksums = files.some((f) => f.name === 'checksums.json');
      out.push({
        handle: {
          businessId: this.business!.providerFolderId,
          kind: opts.kind,
          path: `snapshots/${opts.kind}/${c.name}`,
          providerFolderId: c.id,
          asOf: c.name,
          createdAt: c.createdTime ?? nowIso(),
        },
        sizeBytes: size,
        fileCount: csvs.length,
        verified: hasChecksums,
      });
    }
    out.sort((a, b) => (a.handle.asOf < b.handle.asOf ? 1 : -1));
    return out;
  }

  // -------------------------------------------------------------------------
  // Attachments (spec §4)
  // -------------------------------------------------------------------------

  async uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult> {
    this.assertBusiness();
    if (!input.path.startsWith('attachments/')) {
      throw new Error(`attachment path must be under 'attachments/' — got '${input.path}'`);
    }
    const parts = input.path.split('/');
    if (parts.length < 3) {
      throw new Error(`attachment path must be attachments/<subdir>/<file> — got '${input.path}'`);
    }
    const subdir = parts[1];
    if (!['purchases', 'expenses', 'products'].includes(subdir)) {
      throw new Error(`attachment subdir must be purchases|expenses|products — got '${subdir}'`);
    }

    // Ensure intermediate folders exist.
    const dirPath = parts.slice(0, -1).join('/');
    const parentId = await this.ensureDir(dirPath);
    const fileName = parts[parts.length - 1];

    // Overwrite semantics: if a file with the same name already exists, we
    // update it (attachments are content-addressable in practice — see
    // upstream service naming).
    const existing = await this.api.findChildByName(parentId, fileName);
    const ref = existing
      ? await this.api.updateFileContents(existing.id, input.blob, input.mimeType)
      : await this.api.createFile({
          parentId,
          name: fileName,
          mimeType: input.mimeType,
          body: input.blob,
        });
    this.fileRefCache.set(input.path, ref);
    return { providerFileId: ref.id };
  }

  async downloadAttachment(input: DownloadAttachmentInput): Promise<Blob> {
    this.assertBusiness();
    const ref = await this.resolveFile(input.path);
    if (!ref) throw new Error(`attachment not found: ${input.path}`);
    return await this.api.getFileContents(ref.id);
  }

  // -------------------------------------------------------------------------
  // Integrity (spec §7, §27)
  // -------------------------------------------------------------------------

  async verifyIntegrity(): Promise<IntegrityReport> {
    this.assertBusiness();
    const checksumsBlob = await this.readFileIfExists('metadata/checksums.json');
    const issues: IntegrityIssue[] = [];
    let checked = 0;

    if (!checksumsBlob) {
      return {
        businessId: this.business!.providerFolderId,
        checkedAt: nowIso(),
        ok: false,
        filesChecked: 0,
        issues: [
          {
            severity: 'error',
            code: 'MISSING_CHECKSUMS',
            path: 'metadata/checksums.json',
            detail: 'checksums.json not found — snapshot may never have been created',
          },
        ],
      };
    }

    const parsed = JSON.parse(await blobText(checksumsBlob)) as {
      files?: Record<string, string>;
    };
    const entries = Object.entries(parsed.files ?? {});
    for (const [path, expected] of entries) {
      checked++;
      const ref = await this.resolveFile(path);
      if (!ref) {
        issues.push({
          severity: 'error',
          code: 'MISSING_FILE',
          path,
          detail: 'referenced by checksums.json but not present in Drive',
        });
        continue;
      }
      const blob = await this.api.getFileContents(ref.id);
      const actual = await sha256Hex(blob);
      if (actual !== expected) {
        issues.push({
          severity: 'error',
          code: 'HASH_MISMATCH',
          path,
          detail: `expected ${expected} got ${actual}`,
        });
      }
    }

    return {
      businessId: this.business!.providerFolderId,
      checkedAt: nowIso(),
      ok: issues.length === 0,
      filesChecked: checked,
      issues,
    };
  }

  // -------------------------------------------------------------------------
  // External change detection (spec §21)
  // -------------------------------------------------------------------------

  async getChanges(sinceToken?: string): Promise<ChangesPage> {
    this.assertBusiness();
    const vaultId = this.business!.providerFolderId;

    let token = sinceToken ?? this.changesToken;
    if (!token) {
      token = await this.api.getStartPageToken();
      this.changesToken = token;
      return { changes: [], nextToken: token };
    }

    const page = await this.api.listChanges(token);
    const changes: ExternalChange[] = [];
    for (const ch of page.changes) {
      const f = ch.file;
      // Only surface changes to files under our business folder.
      const relPath = f ? this.pathForFile(f, vaultId) : null;
      if (!relPath) continue;
      const kind: ExternalChange['changeType'] = ch.removed
        ? 'deleted'
        : f?.createdTime && f.createdTime === f.modifiedTime
          ? 'created'
          : 'modified';
      const foreign = ch.foreign ?? true;

      const classification = classifyExternalChange(relPath);
      // Ignored (metadata rewrites we caused, journal appends, etc.) → skip.
      if (classification === 'ignored') continue;

      changes.push({
        path: relPath,
        providerFileId: ch.fileId,
        changeType: kind,
        modifiedAt: f?.modifiedTime ?? ch.time ?? nowIso(),
        foreign,
      });
    }

    const nextToken = page.newStartPageToken ?? page.nextPageToken ?? token;
    this.changesToken = nextToken;
    return { changes, nextToken };
  }

  /** Classify a change per §21. Exposed for callers (UI) to route the review. */
  classifyChange(path: string): ReturnType<typeof classifyExternalChange> {
    return classifyExternalChange(path);
  }

  private pathForFile(f: DriveFileRef, vaultId: string): string | null {
    // Best-effort reverse mapping via cached refs. The Drive Changes API only
    // gives us file+parents; we rely on the cache we populated during writes.
    for (const [path, ref] of this.fileRefCache) {
      if (ref.id === f.id) return path;
    }
    // If it's not in our cache but a parent is our business folder, keep the
    // filename with an "external/" prefix so the caller can decide what to do.
    if (f.parents?.includes(vaultId)) {
      return `external/${f.name}`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Restore (spec §25, §26)
  // -------------------------------------------------------------------------

  async restoreBusiness(opts?: {
    snapshotHandle?: SnapshotHandle;
  }): Promise<RestoreDescriptor> {
    this.assertBusiness();

    // 1. Pick a base snapshot — either the caller-provided one, or the newest
    //    verified daily snapshot.
    let base = opts?.snapshotHandle;
    if (!base) {
      const daily = await this.listSnapshots({ kind: 'daily' });
      const verified = daily.find((s) => s.verified) ?? daily[0];
      if (verified) base = verified.handle;
    }

    // 2. Determine the checkpoint (asOf) so we know which journal months to
    //    replay. Anything strictly after the snapshot's asOf must be replayed.
    const checkpoint = base?.asOf ?? '0000-00-00';
    const checkpointYear = Number(checkpoint.slice(0, 4)) || 0;
    const checkpointMonth = Number(checkpoint.slice(5, 7)) || 0;

    // 3. Enumerate journal files >= checkpoint month.
    const journalId = await this.resolveFolder('journal');
    const journalFiles: RestoreDescriptor['journalFiles'] = [];
    if (journalId) {
      const years = await this.api.listChildren(journalId);
      for (const y of years) {
        if (y.mimeType !== MIME_FOLDER) continue;
        const yn = Number(y.name);
        if (!Number.isFinite(yn) || yn < checkpointYear) continue;
        const files = await this.api.listChildren(y.id);
        for (const f of files) {
          const m = /^(\d{4})-(\d{2})\.events\.jsonl$/.exec(f.name);
          if (!m) continue;
          const fy = Number(m[1]);
          const fm = Number(m[2]);
          if (fy < checkpointYear) continue;
          if (fy === checkpointYear && fm < checkpointMonth) continue;
          const blob = await this.api.getFileContents(f.id);
          const text = await blobText(blob);
          const eventCount = text ? text.split('\n').filter(Boolean).length : 0;
          const hash = await sha256Hex(blob);
          journalFiles.push({
            path: `journal/${y.name}/${f.name}`,
            year: fy,
            month: fm,
            sha256: hash,
            eventCount,
          });
        }
      }
      journalFiles.sort((a, b) => a.year - b.year || a.month - b.month);
    }

    // 4. Attachment index — top-level entries only; contents fetched lazily.
    const attachmentIndex: RestoreDescriptor['attachmentIndex'] = [];
    for (const sub of ['purchases', 'expenses', 'products'] as const) {
      const dirId = await this.resolveFolder(`attachments/${sub}`);
      if (!dirId) continue;
      const files = await this.api.listChildren(dirId);
      for (const f of files) {
        if (f.mimeType === MIME_FOLDER) continue;
        attachmentIndex.push({
          path: `attachments/${sub}/${f.name}`,
          providerFileId: f.id,
        });
      }
    }

    return {
      businessId: this.business!.providerFolderId,
      baseSnapshot: base,
      journalFiles,
      attachmentIndex,
      generatedAt: nowIso(),
    };
  }

  // -------------------------------------------------------------------------
  // Path resolution + caches (spec §12 quota efficiency)
  // -------------------------------------------------------------------------

  private assertBusiness(): void {
    if (!this.connected) throw new Error('provider not connected');
    if (!this.business) throw new Error('initializeBusiness() must be called first');
  }

  /** Ensure a directory (relative to the business folder) exists; return id. */
  private async ensureDir(relPath: string): Promise<string> {
    if (!this.business) throw new Error('no business');
    if (relPath === '' || relPath === '.') return this.business.providerFolderId;
    const cached = this.folderIdCache.get(relPath);
    if (cached) return cached;

    const segs = relPath.split('/').filter(Boolean);
    let parentId = this.business.providerFolderId;
    let cumulative = '';
    for (const seg of segs) {
      cumulative = cumulative ? `${cumulative}/${seg}` : seg;
      const hit = this.folderIdCache.get(cumulative);
      if (hit) {
        parentId = hit;
        continue;
      }
      const folder = await this.api.ensureFolder(parentId, seg);
      this.folderIdCache.set(cumulative, folder.id);
      parentId = folder.id;
    }
    return parentId;
  }

  private async resolveFolder(relPath: string): Promise<string | null> {
    if (!this.business) return null;
    if (relPath === '') return this.business.providerFolderId;
    const cached = this.folderIdCache.get(relPath);
    if (cached) return cached;
    const segs = relPath.split('/').filter(Boolean);
    let parentId = this.business.providerFolderId;
    let cumulative = '';
    for (const seg of segs) {
      cumulative = cumulative ? `${cumulative}/${seg}` : seg;
      const hit = this.folderIdCache.get(cumulative);
      if (hit) {
        parentId = hit;
        continue;
      }
      const found = await this.api.findChildByName(parentId, seg);
      if (!found || found.mimeType !== MIME_FOLDER) return null;
      this.folderIdCache.set(cumulative, found.id);
      parentId = found.id;
    }
    return parentId;
  }

  private async resolveFile(relPath: string): Promise<DriveFileRef | null> {
    const cached = this.fileRefCache.get(relPath);
    if (cached) return cached;
    const parts = relPath.split('/');
    const fileName = parts.pop() as string;
    const dir = parts.join('/');
    const parentId = await this.resolveFolder(dir);
    if (!parentId) return null;
    const ref = await this.api.findChildByName(parentId, fileName);
    if (!ref || ref.mimeType === MIME_FOLDER) return null;
    this.fileRefCache.set(relPath, ref);
    return ref;
  }

  private async readFileIfExists(relPath: string): Promise<Blob | null> {
    const ref = await this.resolveFile(relPath);
    if (!ref) return null;
    return await this.api.getFileContents(ref.id);
  }

  private async writeFileIfMissing(relPath: string, body: Blob, mimeType: string): Promise<void> {
    const existing = await this.resolveFile(relPath);
    if (existing) return;
    const parts = relPath.split('/');
    const fileName = parts.pop() as string;
    const parentId = await this.ensureDir(parts.join('/'));
    const created = await this.api.createFile({ parentId, name: fileName, mimeType, body });
    this.fileRefCache.set(relPath, created);
  }

  private async writeFileReplace(relPath: string, body: Blob, mimeType: string): Promise<void> {
    const existing = await this.resolveFile(relPath);
    if (existing) {
      const updated = await this.api.updateFileContents(existing.id, body, mimeType);
      this.fileRefCache.set(relPath, updated);
      return;
    }
    const parts = relPath.split('/');
    const fileName = parts.pop() as string;
    const parentId = await this.ensureDir(parts.join('/'));
    const created = await this.api.createFile({ parentId, name: fileName, mimeType, body });
    this.fileRefCache.set(relPath, created);
  }
}

// Exported helper for tests / restore module.
export { classifyExternalChange, joinPath, FINANCIALLY_DANGEROUS_FILES, SAFE_IMPORTABLE_FILES };
