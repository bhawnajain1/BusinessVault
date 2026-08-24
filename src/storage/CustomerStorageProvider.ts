/**
 * CustomerStorageProvider — spec §31.
 *
 * The single seam between BusinessVault's local-first core (IndexedDB + event
 * journal) and whatever cloud/local destination the customer owns
 * (Google Drive today; OneDrive / Dropbox / S3 / Local-Folder later — §32).
 *
 * Rules baked in here:
 *   - No business service (Invoice/Accounting/Inventory/POS) may import a
 *     concrete provider. They depend only on this interface.
 *   - CSV is a *portable snapshot*, never a query surface — see writeSnapshot
 *     / readSnapshot / listSnapshots.
 *   - The event journal is the source of truth for sync; snapshots are
 *     regenerated periodically and verified before overwriting the last-good.
 *   - Recovery from the provider alone (no BusinessVault servers) must be
 *     possible — see restoreBusiness.
 */

// ---------------------------------------------------------------------------
// Journal event shape (mirrors src/events/types.ts once populated; declared
// locally so this file compiles standalone and other modules can widen it).
// ---------------------------------------------------------------------------

export type SyncOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'void'
  | 'adjust'
  | 'reverse';

export type SyncStatus =
  | 'LOCAL_ONLY'
  | 'QUEUED'
  | 'SYNCING'
  | 'SYNCED'
  | 'CONFLICT'
  | 'FAILED';

export interface SyncEvent {
  event_id: string;              // ULID
  business_id: string;
  device_id: string;
  entity_type: string;           // e.g. 'invoice', 'ledger_entry', 'stock_move'
  entity_id: string;
  operation: SyncOperation;
  entity_version: number;        // monotonic per (business_id, entity_id)
  timestamp: string;             // ISO 8601 UTC
  payload: Readonly<Record<string, unknown>>;
  payload_hash: string;          // hex SHA-256 of canonical payload
  previous_hash: string | null;  // hash of previous event for this business_id
  sync_status: SyncStatus;
}

// ---------------------------------------------------------------------------
// Provider config (discriminated union). Only google-drive + local-folder are
// implemented in this milestone; onedrive is reserved for §32.
// ---------------------------------------------------------------------------

export interface GoogleDriveProviderConfig {
  kind: 'google-drive';
  clientId: string;
  /** Legacy — server-flow only. Not used under GIS; kept optional for old callers. */
  clientSecret?: string;
  /** Legacy — server-flow only. Not used under GIS; kept optional for old callers. */
  redirectUri?: string;
  /** OAuth scope override. Defaults to 'drive.file' per spec — do NOT widen. */
  scope?: 'drive.file';
}

export interface LocalFolderProviderConfig {
  kind: 'local-folder';
  rootPath: string;
}

export interface OneDriveProviderConfig {
  kind: 'onedrive';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant?: string;
}

export type ProviderConfig =
  | GoogleDriveProviderConfig
  | LocalFolderProviderConfig
  | OneDriveProviderConfig;

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ERROR';

export interface ConnectionStatus {
  state: ConnectionState;
  /** Provider-side account identifier, e.g. Drive email. */
  account?: string;
  /** e.g. 'BusinessVault/Acme Traders/' */
  folderPath?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// initializeBusiness
// ---------------------------------------------------------------------------

export interface InitializeBusinessInput {
  businessId: string;
  businessName: string;
}

export interface InitResult {
  businessId: string;
  /** Absolute-ish path inside the provider, e.g. 'BusinessVault/Acme Traders'. */
  folderPath: string;
  /** Provider-native id for the business folder (Drive fileId, etc.). */
  providerFolderId: string;
  /** True if the folder already existed and was reused. */
  reused: boolean;
  createdAt: string; // ISO 8601 UTC
}

// ---------------------------------------------------------------------------
// Journal read/write
// ---------------------------------------------------------------------------

export interface WriteJournalResult {
  written: number;
  /** event_ids the provider considered duplicates (idempotent replay). */
  duplicates: string[];
  /** Path to the appended monthly file (journal/YYYY/YYYY-MM.events.jsonl). */
  journalPath: string;
}
// Alias kept for parity with the task's `WriteResult` name.
export type WriteResult = WriteJournalResult;

export interface ReadJournalOpts {
  businessId: string;
  /** Return events with event_id strictly greater than this ULID. */
  sinceEventId?: string;
  /** Restrict to a single YYYY-MM file if provided. */
  year?: number;
  month?: number;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export type SnapshotKind = 'daily' | 'monthly' | 'annual' | 'ondemand';

export interface SnapshotCsvFile {
  /** Relative to current/, e.g. 'invoices.csv'. */
  name: string;
  /** UTF-8 encoded CSV bytes (already sanitized for formula injection). */
  content: Blob;
  rowCount: number;
  sha256: string;
}

export interface WriteSnapshotInput {
  businessId: string;
  kind: SnapshotKind;
  /** ISO date the snapshot describes, e.g. '2026-08-19'. */
  asOf: string;
  files: SnapshotCsvFile[];
  /** Manifest describing the snapshot (schema version, row counts, …). */
  manifest: Readonly<Record<string, unknown>>;
}

export interface SnapshotHandle {
  businessId: string;
  kind: SnapshotKind;
  /** Path under snapshots/{kind}/, e.g. 'snapshots/daily/2026-08-19'. */
  path: string;
  /** Provider-native id for the snapshot folder. */
  providerFolderId: string;
  asOf: string;
  createdAt: string;
}

export interface SnapshotData {
  handle: SnapshotHandle;
  files: SnapshotCsvFile[];
  manifest: Readonly<Record<string, unknown>>;
  checksums: Readonly<Record<string, string>>;
}

export interface SnapshotIndex {
  handle: SnapshotHandle;
  sizeBytes: number;
  fileCount: number;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface UploadAttachmentInput {
  /** Relative path under the business folder, e.g. 'attachments/inv-123.pdf'. */
  path: string;
  blob: Blob;
  mimeType: string;
}

export interface UploadAttachmentResult {
  providerFileId: string;
  url?: string;
}

export interface DownloadAttachmentInput {
  path: string;
}

// ---------------------------------------------------------------------------
// Integrity + external-change polling
// ---------------------------------------------------------------------------

export interface IntegrityIssue {
  severity: 'warn' | 'error';
  code: string;                  // e.g. 'HASH_MISMATCH', 'MISSING_SNAPSHOT'
  path: string;
  detail: string;
}

export interface IntegrityReport {
  businessId: string;
  checkedAt: string;
  ok: boolean;
  filesChecked: number;
  issues: IntegrityIssue[];
}

export interface ExternalChange {
  path: string;
  providerFileId: string;
  changeType: 'created' | 'modified' | 'deleted';
  modifiedAt: string;
  /** True if changed by someone/something other than this device. */
  foreign: boolean;
}

export interface ChangesPage {
  changes: ExternalChange[];
  /** Opaque cursor to pass back on next call. */
  nextToken: string;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreDescriptor {
  businessId: string;
  /** Snapshot used as the base state, if any. */
  baseSnapshot?: SnapshotHandle;
  /** Journal files that must be replayed on top of the base snapshot. */
  journalFiles: Array<{
    path: string;      // e.g. 'journal/2026/2026-08.events.jsonl'
    year: number;
    month: number;
    sha256: string;
    eventCount: number;
  }>;
  /** Attachment paths to lazy-fetch on demand. */
  attachmentIndex: Array<{ path: string; providerFileId: string }>;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

// One entry per business folder found under BusinessVault/. Populated by
// listBusinesses() and consumed by the Restore flow to let the user pick
// which business to restore (and to read journalCheckpoint / schemaVersion
// off the manifest without a second round-trip).
export interface DiscoveredBusinessOnProvider {
  businessId: string;
  businessName: string;
  /** e.g. 'BusinessVault/Acme Traders'. */
  folderPath: string;
  /** Parsed metadata/manifest.json — the ManifestShape restore expects. */
  manifest: Readonly<{
    businessId?: string;
    businessName?: string;
    schemaVersion?: number;
    journalCheckpoint?: string;
    [k: string]: unknown;
  }>;
}

export interface CustomerStorageProvider {
  connect(config: ProviderConfig): Promise<void>;
  disconnect(): Promise<void>;
  connectionStatus(): Promise<ConnectionStatus>;

  initializeBusiness(input: InitializeBusinessInput): Promise<InitResult>;

  // Enumerate every business folder under BusinessVault/ on this provider.
  // Optional: FakeProviders in the test suite don't implement it. Real
  // providers (LocalFolder, GoogleDrive) do, and the Restore flow requires
  // it to work — without it, Restore has nothing to enumerate.
  listBusinesses?(): Promise<DiscoveredBusinessOnProvider[]>;

  writeJournalEvents(events: SyncEvent[]): Promise<WriteResult>;
  readJournalEvents(opts: ReadJournalOpts): Promise<SyncEvent[]>;

  writeSnapshot(input: WriteSnapshotInput): Promise<SnapshotHandle>;
  readSnapshot(handle: SnapshotHandle): Promise<SnapshotData>;
  listSnapshots(opts: { kind: SnapshotKind }): Promise<SnapshotIndex[]>;

  uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult>;
  downloadAttachment(input: DownloadAttachmentInput): Promise<Blob>;

  verifyIntegrity(): Promise<IntegrityReport>;
  getChanges(sinceToken?: string): Promise<ChangesPage>;

  restoreBusiness(opts?: { snapshotHandle?: SnapshotHandle }): Promise<RestoreDescriptor>;
}
