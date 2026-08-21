/**
 * LocalFolderStorageProvider — spec §32 "future providers".
 *
 * Writes the BusinessVault folder layout to a real folder on disk:
 *   - Browser: File System Access API (window.showDirectoryPicker), handle
 *     persisted in IndexedDB under 'local-folder-handle'.
 *   - Node (tests only): node:fs/promises rooted at rootPath from the config,
 *     enabled when window.showDirectoryPicker is undefined and NODE_ENV==='test'.
 *
 * Same folder layout as the Google Drive provider:
 *   BusinessVault/<BusinessName>/
 *     README.txt
 *     metadata/{manifest.json, schema.json, sync-state.json, checksums.json}
 *     current/*.csv
 *     journal/YYYY/YYYY-MM.events.jsonl
 *     invoices/  attachments/  reports/
 *     snapshots/{daily,monthly,annual,ondemand}/<asOf>/
 *     .staging/   (transient, used for atomic snapshot writes)
 */

import type {
  ChangesPage,
  ConnectionStatus,
  CustomerStorageProvider,
  DownloadAttachmentInput,
  ExternalChange,
  InitResult,
  InitializeBusinessInput,
  IntegrityReport,
  IntegrityIssue,
  ProviderConfig,
  ReadJournalOpts,
  RestoreDescriptor,
  SnapshotCsvFile,
  SnapshotData,
  SnapshotHandle,
  SnapshotIndex,
  SnapshotKind,
  SyncEvent,
  UploadAttachmentInput,
  UploadAttachmentResult,
  WriteJournalResult,
  WriteSnapshotInput,
} from './CustomerStorageProvider';

// ---------------------------------------------------------------------------
// Tiny FS abstraction — one implementation over FileSystemDirectoryHandle,
// another over node:fs/promises. Both speak "posix-ish" relative paths.
// ---------------------------------------------------------------------------

interface FsBackend {
  readonly kind: 'fsapi' | 'node';
  readonly rootLabel: string; // for logging / folderPath
  readFile(path: string): Promise<Uint8Array>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  appendFile(path: string, data: Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  list(path: string): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: string }>;
}

// ------------------------------- Node backend ------------------------------

function makeNodeBackend(rootPath: string): FsBackend {
  // Lazy-require so browser bundles don't pull node built-ins.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require('node:path') as typeof import('node:path');

  const abs = (p: string): string => nodePath.join(rootPath, p);

  return {
    kind: 'node',
    rootLabel: rootPath,

    async readFile(p) {
      const buf = await fsp.readFile(abs(p));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async readFileText(p) {
      return await fsp.readFile(abs(p), 'utf8');
    },
    async writeFile(p, data) {
      await fsp.mkdir(nodePath.dirname(abs(p)), { recursive: true });
      const payload = typeof data === 'string' ? data : Buffer.from(data);
      await fsp.writeFile(abs(p), payload);
    },
    async appendFile(p, data) {
      await fsp.mkdir(nodePath.dirname(abs(p)), { recursive: true });
      const payload = typeof data === 'string' ? data : Buffer.from(data);
      await fsp.appendFile(abs(p), payload);
    },
    async exists(p) {
      try {
        await fsp.stat(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      await fsp.mkdir(abs(p), { recursive: true });
    },
    async list(p) {
      const entries = await fsp.readdir(abs(p), { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        kind: e.isDirectory() ? ('directory' as const) : ('file' as const),
      }));
    },
    async rename(from, to) {
      await fsp.mkdir(nodePath.dirname(abs(to)), { recursive: true });
      await fsp.rename(abs(from), abs(to));
    },
    async remove(p) {
      await fsp.rm(abs(p), { recursive: true, force: true });
    },
    async stat(p) {
      const s = await fsp.stat(abs(p));
      return { size: s.size, mtime: s.mtime.toISOString() };
    },
  };
}

// ----------------------------- FS Access backend --------------------------

type DirHandle = FileSystemDirectoryHandle;

function makeFsApiBackend(root: DirHandle): FsBackend {
  async function resolveDir(path: string, create: boolean): Promise<DirHandle> {
    if (path === '' || path === '.') return root;
    const parts = path.split('/').filter(Boolean);
    let cur: DirHandle = root;
    for (const part of parts) {
      cur = await cur.getDirectoryHandle(part, { create });
    }
    return cur;
  }

  function splitParent(path: string): { dir: string; name: string } {
    const idx = path.lastIndexOf('/');
    if (idx < 0) return { dir: '', name: path };
    return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
  }

  async function getFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const { dir, name } = splitParent(path);
    const d = await resolveDir(dir, create);
    return await d.getFileHandle(name, { create });
  }

  return {
    kind: 'fsapi',
    rootLabel: root.name,

    async readFile(p) {
      const fh = await getFile(p, false);
      const f = await fh.getFile();
      return new Uint8Array(await f.arrayBuffer());
    },
    async readFileText(p) {
      const fh = await getFile(p, false);
      const f = await fh.getFile();
      return await f.text();
    },
    async writeFile(p, data) {
      const fh = await getFile(p, true);
      const w = await fh.createWritable({ keepExistingData: false });
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      await w.write(bytes.slice().buffer as ArrayBuffer);
      await w.close();
    },
    async appendFile(p, data) {
      const fh = await getFile(p, true);
      const f = await fh.getFile();
      const size = f.size;
      // keepExistingData:true + seek(size) is the FSA-blessed append.
      const w = await fh.createWritable({ keepExistingData: true });
      await w.seek(size);
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      await w.write(bytes.slice().buffer as ArrayBuffer);
      await w.close();
    },
    async exists(p) {
      try {
        const { dir, name } = splitParent(p);
        const d = await resolveDir(dir, false);
        try {
          await d.getFileHandle(name);
          return true;
        } catch {
          try {
            await d.getDirectoryHandle(name);
            return true;
          } catch {
            return false;
          }
        }
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      await resolveDir(p, true);
    },
    async list(p) {
      const d = await resolveDir(p, false);
      const out: Array<{ name: string; kind: 'file' | 'directory' }> = [];
      // Iterator API on FileSystemDirectoryHandle.
      const anyD = d as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      for await (const [name, handle] of anyD.entries()) {
        out.push({ name, kind: handle.kind === 'directory' ? 'directory' : 'file' });
      }
      return out;
    },
    async rename(from, to) {
      // FSA has no rename. Copy + delete.
      const bytes = await (async () => {
        const fh = await getFile(from, false);
        const f = await fh.getFile();
        return new Uint8Array(await f.arrayBuffer());
      })();
      const toFh = await getFile(to, true);
      const w = await toFh.createWritable({ keepExistingData: false });
      await w.write(bytes);
      await w.close();
      const { dir, name } = splitParent(from);
      const d = await resolveDir(dir, false);
      await d.removeEntry(name);
    },
    async remove(p) {
      const { dir, name } = splitParent(p);
      const d = await resolveDir(dir, false);
      await d.removeEntry(name, { recursive: true });
    },
    async stat(p) {
      const fh = await getFile(p, false);
      const f = await fh.getFile();
      return { size: f.size, mtime: new Date(f.lastModified).toISOString() };
    },
  };
}

// ---------------------------------------------------------------------------
// Handle persistence (browser only). Test bundles never touch this.
// ---------------------------------------------------------------------------

const HANDLE_DB = 'businessvault-local-folder';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'local-folder-handle';

function isBrowserWithFsApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === 'function'
  );
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle: DirHandle): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function peekSavedHandle(): Promise<DirHandle | null> {
  if (!isBrowserWithFsApi()) return null;
  try {
    return await loadSavedHandle();
  } catch {
    return null;
  }
}

export async function queryHandlePermission(
  handle: DirHandle,
): Promise<PermissionState> {
  const anyH = handle as unknown as {
    queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  if (!anyH.queryPermission) return 'granted';
  return await anyH.queryPermission({ mode: 'readwrite' });
}

async function loadSavedHandle(): Promise<DirHandle | null> {
  const db = await openHandleDb();
  const h = await new Promise<DirHandle | null>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
    req.onsuccess = () => resolve((req.result as DirHandle | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return h;
}

async function reRequestPermission(handle: DirHandle): Promise<boolean> {
  const anyH = handle as unknown as {
    queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  if (!anyH.queryPermission || !anyH.requestPermission) return true;
  const q = await anyH.queryPermission({ mode: 'readwrite' });
  if (q === 'granted') return true;
  const r = await anyH.requestPermission({ mode: 'readwrite' });
  return r === 'granted';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function safeBusinessSlug(name: string): string {
  // Keep it human-readable but filesystem-safe.
  return name.trim().replace(/[/\\:*?"<>|]/g, '_');
}

function journalPathFor(businessFolder: string, ts: string): {
  year: number;
  month: number;
  path: string;
} {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const mm = month < 10 ? '0' + month : String(month);
  return {
    year,
    month,
    path: `${businessFolder}/journal/${year}/${year}-${mm}.events.jsonl`,
  };
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  // jsdom < 21 lacks Blob.prototype.arrayBuffer / .stream. Fall back to
  // FileReader, then to reading .parts via a Response, then error.
  if (typeof (blob as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof Response !== 'undefined') {
    const ab = await new Response(blob).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error('blobToBytes: no way to read Blob in this environment');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('SubtleCrypto unavailable');
  // Copy into a plain ArrayBuffer to satisfy the DOM lib type (TS 5.9 tightened
  // Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer>).
  const abuf = bytes.slice().buffer as ArrayBuffer;
  const buf = await subtle.digest('SHA-256', abuf);
  const view = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

const README_TEMPLATE = (businessName: string) =>
  `BusinessVault backup folder — ${businessName}

This folder is the customer-owned durable store for BusinessVault.
Layout:
  metadata/     manifest.json, schema.json, sync-state.json, checksums.json
  current/      Latest snapshot CSVs (portable, human-readable)
  journal/      Immutable event log — the source of truth for sync
  invoices/     Generated PDFs
  attachments/  Uploaded documents
  reports/      Exported reports
  snapshots/    Daily / monthly / annual point-in-time snapshots

Do NOT edit files here by hand — the event journal is authoritative and
CSVs will be regenerated on the next sync.
`;

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

interface BusinessLocation {
  businessId: string;
  businessName: string;
  folderPath: string; // e.g. 'BusinessVault/Acme Traders'
}

export class LocalFolderStorageProvider implements CustomerStorageProvider {
  private fs: FsBackend | null = null;
  private config: ProviderConfig | null = null;
  private connected = false;
  private business: BusinessLocation | null = null;
  private connectError: string | undefined;
  private injectedHandle: DirHandle | null = null;

  /** Pre-seed the folder handle from a click-gesture call, bypassing the
   *  saved-handle silent-reuse path. connect() will use this handle instead
   *  of calling showDirectoryPicker() itself. */
  setDirectoryHandle(handle: DirHandle): void {
    this.injectedHandle = handle;
  }

  /** Which business this provider is currently bound to after
   *  initializeBusiness(). Null before initializeBusiness runs, and null again
   *  after disconnect(). Used by bootProvider to detect when the active
   *  business has changed and the running sync worker must be restarted
   *  against a fresh provider — otherwise every flush fails with a
   *  businessId mismatch (see W-restore-data-loss note). */
  getBoundBusinessId(): string | null {
    return this.business?.businessId ?? null;
  }

  async connect(config: ProviderConfig): Promise<void> {
    if (config.kind !== 'local-folder') {
      throw new Error(
        `LocalFolderStorageProvider: expected kind 'local-folder', got '${config.kind}'`,
      );
    }
    this.config = config;

    try {
      if (isBrowserWithFsApi()) {
        let handle: DirHandle | null = this.injectedHandle;
        if (!handle) {
          handle = await loadSavedHandle();
          if (handle) {
            const ok = await reRequestPermission(handle);
            if (!ok) throw new Error('Permission to the saved folder was denied');
          } else {
            const picker = (window as unknown as {
              showDirectoryPicker: (o?: {
                mode?: 'readwrite';
              }) => Promise<DirHandle>;
            }).showDirectoryPicker;
            handle = await picker({ mode: 'readwrite' });
          }
        }
        await saveHandle(handle);
        this.fs = makeFsApiBackend(handle);
      } else if (
        typeof window === 'undefined' ||
        // Vitest sets NODE_ENV to 'test' by default.
        (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test')
      ) {
        // Node fallback for tests / SSR.
        if (!config.rootPath) {
          throw new Error('rootPath is required for local-folder outside the browser');
        }
        this.fs = makeNodeBackend(config.rootPath);
        await this.fs.mkdirp('');
      } else {
        throw new Error('showDirectoryPicker is unavailable in this browser');
      }

      // Ensure top-level BusinessVault/ exists — but only if the picked root
      // doesn't already look like the BusinessVault folder itself. Detect the
      // latter by scanning for any child whose metadata/manifest.json exists.
      const rootEntries = await this.fs.list('');
      let rootIsBusinessVault = false;
      for (const e of rootEntries) {
        if (e.kind !== 'directory') continue;
        if (await this.fs.exists(`${e.name}/metadata/manifest.json`)) {
          rootIsBusinessVault = true;
          break;
        }
      }
      if (!rootIsBusinessVault) {
        await this.fs.mkdirp('BusinessVault');
      }
      this.connected = true;
      this.connectError = undefined;
    } catch (err) {
      this.connected = false;
      this.connectError = (err as Error).message;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.fs = null;
    this.connected = false;
    this.business = null;
    this.config = null;
  }

  async connectionStatus(): Promise<ConnectionStatus> {
    if (this.connectError) {
      return { state: 'ERROR', error: this.connectError };
    }
    if (!this.connected || !this.fs) {
      return { state: 'DISCONNECTED' };
    }
    return {
      state: 'CONNECTED',
      account: this.fs.rootLabel,
      folderPath: this.business?.folderPath,
    };
  }

  async initializeBusiness(input: InitializeBusinessInput): Promise<InitResult> {
    const fs = this.requireFs();
    const slug = safeBusinessSlug(input.businessName);
    // Two supported layouts:
    //   (a) canonical: <root>/BusinessVault/<slug>/…    (new installs, and
    //       what we create when nothing exists yet)
    //   (b) rooted:    <root>/<slug>/…                  (user picked the
    //       BusinessVault folder itself in the OS picker)
    // Reuse whichever already has data; otherwise create (a).
    const canonicalPath = `BusinessVault/${slug}`;
    const rootedPath = slug;
    let folderPath: string;
    if (await fs.exists(`${rootedPath}/metadata/manifest.json`)) {
      folderPath = rootedPath;
    } else {
      folderPath = canonicalPath;
    }

    const reused = await fs.exists(folderPath);

    // Full folder tree.
    const dirs = [
      folderPath,
      `${folderPath}/metadata`,
      `${folderPath}/current`,
      `${folderPath}/journal`,
      `${folderPath}/invoices`,
      `${folderPath}/attachments`,
      `${folderPath}/reports`,
      `${folderPath}/snapshots`,
      `${folderPath}/snapshots/daily`,
      `${folderPath}/snapshots/monthly`,
      `${folderPath}/snapshots/annual`,
      `${folderPath}/snapshots/ondemand`,
      `${folderPath}/.staging`,
    ];
    for (const d of dirs) await fs.mkdirp(d);

    // README + metadata seeds (don't clobber existing manifest).
    const readmePath = `${folderPath}/README.txt`;
    if (!(await fs.exists(readmePath))) {
      await fs.writeFile(readmePath, README_TEMPLATE(input.businessName));
    }

    const manifestPath = `${folderPath}/metadata/manifest.json`;
    const createdAt = new Date().toISOString();
    if (!(await fs.exists(manifestPath))) {
      const manifest = {
        businessId: input.businessId,
        businessName: input.businessName,
        schemaVersion: 1,
        createdAt,
        provider: 'local-folder',
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }

    const schemaPath = `${folderPath}/metadata/schema.json`;
    if (!(await fs.exists(schemaPath))) {
      await fs.writeFile(
        schemaPath,
        JSON.stringify({ schemaVersion: 1, entities: [] }, null, 2),
      );
    }

    const syncStatePath = `${folderPath}/metadata/sync-state.json`;
    if (!(await fs.exists(syncStatePath))) {
      await fs.writeFile(
        syncStatePath,
        JSON.stringify(
          { lastSyncedEventId: null, lastSyncAt: null, deviceIds: [] },
          null,
          2,
        ),
      );
    }

    const checksumsPath = `${folderPath}/metadata/checksums.json`;
    if (!(await fs.exists(checksumsPath))) {
      await fs.writeFile(checksumsPath, JSON.stringify({}, null, 2));
    }

    this.business = {
      businessId: input.businessId,
      businessName: input.businessName,
      folderPath,
    };

    return {
      businessId: input.businessId,
      folderPath,
      providerFolderId: folderPath, // local-folder has no separate id
      reused,
      createdAt,
    };
  }

  async writeJournalEvents(events: SyncEvent[]): Promise<WriteJournalResult> {
    const fs = this.requireFs();
    if (events.length === 0) {
      return { written: 0, duplicates: [], journalPath: '' };
    }
    const business = this.requireBusiness(events[0].business_id);

    // Bucket events by YYYY-MM.
    const buckets = new Map<string, { path: string; events: SyncEvent[] }>();
    for (const e of events) {
      if (e.business_id !== business.businessId) {
        throw new Error(
          `writeJournalEvents: mixed business_id (${e.business_id} != ${business.businessId})`,
        );
      }
      const jp = journalPathFor(business.folderPath, e.timestamp);
      const key = jp.path;
      let b = buckets.get(key);
      if (!b) {
        b = { path: key, events: [] };
        buckets.set(key, b);
      }
      b.events.push(e);
    }

    let written = 0;
    const duplicates: string[] = [];
    let lastPath = '';
    for (const { path, events: bucketEvents } of buckets.values()) {
      // Idempotency: read existing event_ids in this file.
      const seen = new Set<string>();
      if (await fs.exists(path)) {
        const existing = await fs.readFileText(path);
        for (const line of existing.split('\n')) {
          if (!line) continue;
          const idx = line.indexOf('"event_id"');
          if (idx < 0) continue;
          try {
            const parsed = JSON.parse(line) as { event_id?: string };
            if (parsed.event_id) seen.add(parsed.event_id);
          } catch {
            // skip malformed
          }
        }
      }

      const toAppend: string[] = [];
      for (const e of bucketEvents) {
        if (seen.has(e.event_id)) {
          duplicates.push(e.event_id);
          continue;
        }
        seen.add(e.event_id);
        toAppend.push(JSON.stringify(e));
      }
      if (toAppend.length > 0) {
        await fs.appendFile(path, toAppend.join('\n') + '\n');
        written += toAppend.length;
      }
      lastPath = path;
    }

    return { written, duplicates, journalPath: lastPath };
  }

  // Append durable log lines to logs/YYYY-MM-DD.jsonl inside the business
  // folder. Used by src/lib/log.ts to mirror the IndexedDB debug_logs table
  // to disk so a user can zip and share their diagnostic bundle. Best-effort:
  // if this throws, the log module swallows and keeps the Dexie copy.
  async appendLogLines(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const fs = this.requireFs();
    // The business context is set at initializeBusiness time. If it's not
    // set yet (worker hasn't adopted the provider), silently drop — we're
    // pre-provider, before there's a customer folder to write into.
    if (!this.business) return;
    const today = new Date().toISOString().slice(0, 10);
    const path = `${this.business.folderPath}/logs/${today}.jsonl`;
    await fs.appendFile(path, lines.join('\n') + '\n');
  }

  async readJournalEvents(opts: ReadJournalOpts): Promise<SyncEvent[]> {
    const fs = this.requireFs();
    const business = this.requireBusiness(opts.businessId);

    const files: string[] = [];
    if (opts.year != null && opts.month != null) {
      const mm = opts.month < 10 ? '0' + opts.month : String(opts.month);
      files.push(`${business.folderPath}/journal/${opts.year}/${opts.year}-${mm}.events.jsonl`);
    } else {
      const journalRoot = `${business.folderPath}/journal`;
      if (!(await fs.exists(journalRoot))) return [];
      const years = await fs.list(journalRoot);
      for (const y of years) {
        if (y.kind !== 'directory') continue;
        const months = await fs.list(`${journalRoot}/${y.name}`);
        for (const m of months) {
          if (m.kind === 'file' && m.name.endsWith('.events.jsonl')) {
            files.push(`${journalRoot}/${y.name}/${m.name}`);
          }
        }
      }
      files.sort();
    }

    const out: SyncEvent[] = [];
    for (const f of files) {
      if (!(await fs.exists(f))) continue;
      const text = await fs.readFileText(f);
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as SyncEvent;
          if (opts.sinceEventId && evt.event_id <= opts.sinceEventId) continue;
          out.push(evt);
        } catch {
          // skip malformed line — verifyIntegrity will flag it
        }
      }
    }
    return out;
  }

  async writeSnapshot(input: WriteSnapshotInput): Promise<SnapshotHandle> {
    const fs = this.requireFs();
    const business = this.requireBusiness(input.businessId);

    const finalDir = `${business.folderPath}/snapshots/${input.kind}/${input.asOf}`;
    // If the target already has a fully verified snapshot with the same asOf,
    // regenerate in a fresh staging area and swap. NEVER destroy the last good
    // until the new one is verified.
    const stagingId = `${input.kind}-${input.asOf}-${Date.now()}`;
    const stagingDir = `${business.folderPath}/.staging/${stagingId}`;
    await fs.mkdirp(stagingDir);

    // 1. Write CSVs into staging, computing checksums.
    const checksums: Record<string, string> = {};
    let totalRows = 0;
    for (const file of input.files) {
      const bytes = await blobToBytes(file.content);
      const actualHash = await sha256Hex(bytes);
      if (actualHash !== file.sha256) {
        // Reject early: caller's declared hash disagrees with content.
        await fs.remove(stagingDir).catch(() => undefined);
        throw new Error(
          `writeSnapshot: sha256 mismatch for ${file.name} (declared ${file.sha256}, actual ${actualHash})`,
        );
      }
      await fs.writeFile(`${stagingDir}/${file.name}`, bytes);
      checksums[file.name] = actualHash;
      totalRows += file.rowCount;
    }

    // 2. Write checksums.json and manifest.json into staging.
    await fs.writeFile(
      `${stagingDir}/checksums.json`,
      JSON.stringify(checksums, null, 2),
    );
    const createdAt = new Date().toISOString();
    const manifest = {
      ...input.manifest,
      businessId: input.businessId,
      kind: input.kind,
      asOf: input.asOf,
      createdAt,
      totalRows,
      fileCount: input.files.length,
    };
    await fs.writeFile(
      `${stagingDir}/manifest.json`,
      JSON.stringify(manifest, null, 2),
    );

    // 3. Verify staging against declared checksums BEFORE swapping.
    for (const [name, expected] of Object.entries(checksums)) {
      const bytes = await fs.readFile(`${stagingDir}/${name}`);
      const actual = await sha256Hex(bytes);
      if (actual !== expected) {
        await fs.remove(stagingDir).catch(() => undefined);
        throw new Error(`writeSnapshot: post-write hash mismatch for ${name}`);
      }
    }

    // 4. Atomic swap. Rename staging → final. If a previous snapshot exists at
    //    the same asOf, move it aside first so we can restore on failure.
    let backupDir: string | null = null;
    if (await fs.exists(finalDir)) {
      backupDir = `${business.folderPath}/.staging/prev-${stagingId}`;
      await fs.rename(finalDir, backupDir);
    }
    try {
      await fs.rename(stagingDir, finalDir);
    } catch (err) {
      // Roll back.
      if (backupDir) {
        await fs.rename(backupDir, finalDir).catch(() => undefined);
      }
      throw err;
    }
    if (backupDir) {
      await fs.remove(backupDir).catch(() => undefined);
    }

    // 5. Update global checksums.json to include this snapshot's files.
    await this.mergeChecksums(business.folderPath, `snapshots/${input.kind}/${input.asOf}`, checksums);

    return {
      businessId: input.businessId,
      kind: input.kind,
      path: `snapshots/${input.kind}/${input.asOf}`,
      providerFolderId: finalDir,
      asOf: input.asOf,
      createdAt,
    };
  }

  async readSnapshot(handle: SnapshotHandle): Promise<SnapshotData> {
    const fs = this.requireFs();
    const business = this.requireBusiness(handle.businessId);
    const dir = `${business.folderPath}/${handle.path}`;
    if (!(await fs.exists(dir))) {
      throw new Error(`readSnapshot: not found at ${dir}`);
    }

    const manifest = JSON.parse(await fs.readFileText(`${dir}/manifest.json`)) as Record<
      string,
      unknown
    >;
    let checksums: Record<string, string> = {};
    if (await fs.exists(`${dir}/checksums.json`)) {
      checksums = JSON.parse(await fs.readFileText(`${dir}/checksums.json`));
    }

    const entries = await fs.list(dir);
    const files: SnapshotCsvFile[] = [];
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.csv')) continue;
      const bytes = await fs.readFile(`${dir}/${e.name}`);
      const sha256 = await sha256Hex(bytes);
      const text = new TextDecoder('utf-8').decode(bytes);
      // Row count = lines minus header. Rough — snapshot manifest is truth.
      const rowCount = Math.max(0, text.split('\n').filter((l) => l.length > 0).length - 1);
      files.push({
        name: e.name,
        content: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/csv' }),
        rowCount,
        sha256,
      });
    }

    return { handle, files, manifest, checksums };
  }

  async listSnapshots(opts: { kind: SnapshotKind }): Promise<SnapshotIndex[]> {
    const fs = this.requireFs();
    if (!this.business) return [];
    const dir = `${this.business.folderPath}/snapshots/${opts.kind}`;
    if (!(await fs.exists(dir))) return [];

    const entries = await fs.list(dir);
    const out: SnapshotIndex[] = [];
    for (const e of entries) {
      if (e.kind !== 'directory') continue;
      const snapDir = `${dir}/${e.name}`;
      const files = await fs.list(snapDir);
      let sizeBytes = 0;
      let fileCount = 0;
      let verified = false;
      for (const f of files) {
        if (f.kind !== 'file') continue;
        fileCount++;
        const s = await fs.stat(`${snapDir}/${f.name}`);
        sizeBytes += s.size;
      }
      // Verified iff checksums.json + manifest.json both present and all
      // declared files exist. Deep check is verifyIntegrity's job.
      if (await fs.exists(`${snapDir}/manifest.json`) && await fs.exists(`${snapDir}/checksums.json`)) {
        verified = true;
      }
      out.push({
        handle: {
          businessId: this.business.businessId,
          kind: opts.kind,
          path: `snapshots/${opts.kind}/${e.name}`,
          providerFolderId: snapDir,
          asOf: e.name,
          createdAt: '',
        },
        sizeBytes,
        fileCount,
        verified,
      });
    }
    out.sort((a, b) => a.handle.asOf.localeCompare(b.handle.asOf));
    return out;
  }

  async uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult> {
    const fs = this.requireFs();
    const business = this.requireBusinessOrFail();
    const bytes = await blobToBytes(input.blob);
    const path = `${business.folderPath}/${input.path}`;
    await fs.writeFile(path, bytes);
    return { providerFileId: path };
  }

  async downloadAttachment(input: DownloadAttachmentInput): Promise<Blob> {
    const fs = this.requireFs();
    const business = this.requireBusinessOrFail();
    const path = `${business.folderPath}/${input.path}`;
    const bytes = await fs.readFile(path);
    return new Blob([bytes.slice().buffer as ArrayBuffer]);
  }

  async verifyIntegrity(): Promise<IntegrityReport> {
    const fs = this.requireFs();
    const business = this.requireBusinessOrFail();
    const issues: IntegrityIssue[] = [];
    let filesChecked = 0;

    // Verify each snapshot against its own checksums.json.
    for (const kind of ['daily', 'monthly', 'annual', 'ondemand'] as SnapshotKind[]) {
      const kindDir = `${business.folderPath}/snapshots/${kind}`;
      if (!(await fs.exists(kindDir))) continue;
      const entries = await fs.list(kindDir);
      for (const e of entries) {
        if (e.kind !== 'directory') continue;
        const snapDir = `${kindDir}/${e.name}`;
        const checksumsPath = `${snapDir}/checksums.json`;
        if (!(await fs.exists(checksumsPath))) {
          issues.push({
            severity: 'error',
            code: 'MISSING_CHECKSUMS',
            path: `snapshots/${kind}/${e.name}`,
            detail: 'checksums.json missing',
          });
          continue;
        }
        let declared: Record<string, string>;
        try {
          declared = JSON.parse(await fs.readFileText(checksumsPath));
        } catch (err) {
          issues.push({
            severity: 'error',
            code: 'CORRUPT_CHECKSUMS',
            path: `snapshots/${kind}/${e.name}/checksums.json`,
            detail: (err as Error).message,
          });
          continue;
        }
        for (const [name, expected] of Object.entries(declared)) {
          const filePath = `${snapDir}/${name}`;
          filesChecked++;
          if (!(await fs.exists(filePath))) {
            issues.push({
              severity: 'error',
              code: 'MISSING_FILE',
              path: `snapshots/${kind}/${e.name}/${name}`,
              detail: 'declared in checksums.json but missing on disk',
            });
            continue;
          }
          const bytes = await fs.readFile(filePath);
          const actual = await sha256Hex(bytes);
          if (actual !== expected) {
            issues.push({
              severity: 'error',
              code: 'HASH_MISMATCH',
              path: `snapshots/${kind}/${e.name}/${name}`,
              detail: `expected ${expected}, got ${actual}`,
            });
          }
        }
      }
    }

    // Verify journal files parse line-by-line.
    const journalRoot = `${business.folderPath}/journal`;
    if (await fs.exists(journalRoot)) {
      const years = await fs.list(journalRoot);
      for (const y of years) {
        if (y.kind !== 'directory') continue;
        const months = await fs.list(`${journalRoot}/${y.name}`);
        for (const m of months) {
          if (m.kind !== 'file' || !m.name.endsWith('.events.jsonl')) continue;
          filesChecked++;
          const text = await fs.readFileText(`${journalRoot}/${y.name}/${m.name}`);
          let lineNo = 0;
          for (const line of text.split('\n')) {
            lineNo++;
            if (!line) continue;
            try {
              JSON.parse(line);
            } catch (err) {
              issues.push({
                severity: 'error',
                code: 'CORRUPT_JOURNAL_LINE',
                path: `journal/${y.name}/${m.name}:${lineNo}`,
                detail: (err as Error).message,
              });
            }
          }
        }
      }
    }

    return {
      businessId: business.businessId,
      checkedAt: new Date().toISOString(),
      ok: issues.filter((i) => i.severity === 'error').length === 0,
      filesChecked,
      issues,
    };
  }

  async getChanges(sinceToken?: string): Promise<ChangesPage> {
    // Local folder: we don't watch for external edits (spec §32 stub). Return
    // an empty page and echo the token so callers can be resumable.
    const changes: ExternalChange[] = [];
    return { changes, nextToken: sinceToken ?? '' };
  }

  async restoreBusiness(opts?: {
    snapshotHandle?: SnapshotHandle;
  }): Promise<RestoreDescriptor> {
    const fs = this.requireFs();
    const business = this.requireBusinessOrFail();

    const journalFiles: RestoreDescriptor['journalFiles'] = [];
    const journalRoot = `${business.folderPath}/journal`;
    if (await fs.exists(journalRoot)) {
      const years = await fs.list(journalRoot);
      for (const y of years) {
        if (y.kind !== 'directory') continue;
        const months = await fs.list(`${journalRoot}/${y.name}`);
        for (const m of months) {
          if (m.kind !== 'file' || !m.name.endsWith('.events.jsonl')) continue;
          const rel = `journal/${y.name}/${m.name}`;
          const bytes = await fs.readFile(`${journalRoot}/${y.name}/${m.name}`);
          const sha256 = await sha256Hex(bytes);
          const text = new TextDecoder('utf-8').decode(bytes);
          const eventCount = text.split('\n').filter((l) => l.length > 0).length;
          const yearNum = parseInt(y.name, 10);
          const monthMatch = /(\d{4})-(\d{2})\.events\.jsonl$/.exec(m.name);
          const monthNum = monthMatch ? parseInt(monthMatch[2], 10) : 0;
          journalFiles.push({ path: rel, year: yearNum, month: monthNum, sha256, eventCount });
        }
      }
      journalFiles.sort((a, b) => a.path.localeCompare(b.path));
    }

    const attachmentIndex: RestoreDescriptor['attachmentIndex'] = [];
    const attRoot = `${business.folderPath}/attachments`;
    if (await fs.exists(attRoot)) {
      for (const e of await fs.list(attRoot)) {
        if (e.kind !== 'file') continue;
        const rel = `attachments/${e.name}`;
        attachmentIndex.push({ path: rel, providerFileId: `${business.folderPath}/${rel}` });
      }
    }

    return {
      businessId: business.businessId,
      baseSnapshot: opts?.snapshotHandle,
      journalFiles,
      attachmentIndex,
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Test-only helpers (do not export from the barrel).
  // -------------------------------------------------------------------------

  /** @internal */
  _fsForTests(): FsBackend {
    return this.requireFs();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireFs(): FsBackend {
    if (!this.fs) throw new Error('LocalFolderStorageProvider: not connected');
    return this.fs;
  }

  private requireBusiness(businessId: string): BusinessLocation {
    if (!this.business) {
      throw new Error('LocalFolderStorageProvider: initializeBusiness must run first');
    }
    if (this.business.businessId !== businessId) {
      throw new Error(
        `LocalFolderStorageProvider: businessId mismatch (active=${this.business.businessId}, got=${businessId})`,
      );
    }
    return this.business;
  }

  private requireBusinessOrFail(): BusinessLocation {
    if (!this.business) {
      throw new Error('LocalFolderStorageProvider: initializeBusiness must run first');
    }
    return this.business;
  }

  private async mergeChecksums(
    folderPath: string,
    prefix: string,
    additions: Record<string, string>,
  ): Promise<void> {
    const fs = this.requireFs();
    const path = `${folderPath}/metadata/checksums.json`;
    let existing: Record<string, string> = {};
    if (await fs.exists(path)) {
      try {
        existing = JSON.parse(await fs.readFileText(path));
      } catch {
        existing = {};
      }
    }
    for (const [name, hash] of Object.entries(additions)) {
      existing[`${prefix}/${name}`] = hash;
    }
    await fs.writeFile(path, JSON.stringify(existing, null, 2));
  }
}
