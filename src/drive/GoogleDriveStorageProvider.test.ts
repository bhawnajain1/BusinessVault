import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GoogleDriveStorageProvider,
  DriveNeedsReconnectError,
  type DriveApiClient,
  type DriveFileRef,
} from './GoogleDriveStorageProvider';
import type {
  SyncEvent,
  GoogleDriveProviderConfig,
} from '../storage/CustomerStorageProvider';

// ---------------------------------------------------------------------------
// jsdom's Blob polyfill lacks .arrayBuffer(). Use FileReader as a fallback
// so tests run in the default vitest jsdom environment.
async function blobBytes(b: Blob): Promise<Uint8Array> {
  if (typeof (b as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    return new Uint8Array(await (b as Blob).arrayBuffer());
  }
  // Fallback: read as text; only used for text payloads in tests.
  const text = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.readAsText(b);
  });
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// In-memory DriveApiClient mock. Simulates folder tree, file contents,
// version counter. Enough surface for the provider to exercise its atomic
// snapshot + integrity code paths deterministically.
// ---------------------------------------------------------------------------

interface Node {
  id: string;
  name: string;
  mimeType: string;
  parent: string | null;
  content?: Uint8Array;
  version: number;
  createdTime: string;
  modifiedTime: string;
}

const MIME_FOLDER = 'application/vnd.google-apps.folder';

class FakeDrive implements DriveApiClient {
  private idSeq = 0;
  nodes = new Map<string, Node>();
  private tokens: { accessToken: string; expiresAt: number } | null = null;
  private user = { emailAddress: 'owner@example.com', displayName: 'Owner' };
  private startToken = '1';
  private changes: Array<{ fileId: string; time: string; removed?: boolean; foreign?: boolean }> = [];
  /** Fail policy hooks — set to make a specific createFile / update fail. */
  failNextCreate: string[] = [];
  failVerifyFile: string | null = null;

  constructor() {
    const rootId = this.mint();
    this.nodes.set(rootId, {
      id: rootId,
      name: '__root__',
      mimeType: MIME_FOLDER,
      parent: null,
      version: 1,
      createdTime: '2026-01-01T00:00:00.000Z',
      modifiedTime: '2026-01-01T00:00:00.000Z',
    });
    this.rootId = rootId;
  }
  private rootId: string;

  private mint(): string {
    return `id-${++this.idSeq}`;
  }

  private ref(n: Node): DriveFileRef {
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      version: String(n.version),
      modifiedTime: n.modifiedTime,
      createdTime: n.createdTime,
      size: n.content?.byteLength,
      parents: n.parent ? [n.parent] : [],
    };
  }

  // Token management (GIS — no refresh token in the browser).
  async hasValidTokens(): Promise<boolean> {
    return this.tokens !== null;
  }
  async refreshIfNeeded(): Promise<void> {
    if (!this.tokens) throw new DriveNeedsReconnectError();
  }
  async getUserInfo() {
    if (!this.tokens) throw new DriveNeedsReconnectError();
    return this.user;
  }
  seedTokens() {
    this.tokens = { accessToken: 'AT', expiresAt: Date.now() + 3600_000 };
  }

  // Folder ops
  async rootFolderId(): Promise<string> {
    return this.rootId;
  }
  async findChildByName(parentId: string, name: string): Promise<DriveFileRef | null> {
    for (const n of this.nodes.values()) {
      if (n.parent === parentId && n.name === name) return this.ref(n);
    }
    return null;
  }
  async ensureFolder(parentId: string, name: string): Promise<DriveFileRef> {
    const existing = await this.findChildByName(parentId, name);
    if (existing) return existing;
    const id = this.mint();
    const now = new Date().toISOString();
    const n: Node = {
      id,
      name,
      mimeType: MIME_FOLDER,
      parent: parentId,
      version: 1,
      createdTime: now,
      modifiedTime: now,
    };
    this.nodes.set(id, n);
    return this.ref(n);
  }
  async listChildren(parentId: string): Promise<DriveFileRef[]> {
    const out: DriveFileRef[] = [];
    for (const n of this.nodes.values()) {
      if (n.parent === parentId) out.push(this.ref(n));
    }
    return out;
  }
  async createFile(input: {
    parentId: string;
    name: string;
    mimeType: string;
    body: Blob;
  }): Promise<DriveFileRef> {
    if (this.failNextCreate.includes(input.name)) {
      this.failNextCreate = this.failNextCreate.filter((n) => n !== input.name);
      throw new Error(`simulated createFile failure for ${input.name}`);
    }
    const id = this.mint();
    const now = new Date().toISOString();
    const bytes = await blobBytes(input.body);
    const n: Node = {
      id,
      name: input.name,
      mimeType: input.mimeType,
      parent: input.parentId,
      content: bytes,
      version: 1,
      createdTime: now,
      modifiedTime: now,
    };
    this.nodes.set(id, n);
    this.changes.push({ fileId: id, time: now });
    return this.ref(n);
  }
  async updateFileContents(fileId: string, body: Blob, mimeType: string): Promise<DriveFileRef> {
    const n = this.nodes.get(fileId);
    if (!n) throw new Error('not found');
    n.content = await blobBytes(body);
    n.mimeType = mimeType;
    n.version += 1;
    n.modifiedTime = new Date().toISOString();
    this.changes.push({ fileId, time: n.modifiedTime });
    return this.ref(n);
  }
  async getFileContents(fileId: string): Promise<Blob> {
    const n = this.nodes.get(fileId);
    if (!n) throw new Error('not found');
    if (this.failVerifyFile === n.name) {
      // Simulate silent corruption — return different bytes than were written.
      return new Blob([new Uint8Array([0xff, 0xff, 0xff]).buffer]);
    }
    const bytes = n.content ?? new Uint8Array(0);
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Blob([ab], { type: n.mimeType });
  }
  async getFileMetadata(fileId: string): Promise<DriveFileRef> {
    const n = this.nodes.get(fileId);
    if (!n) throw new Error('not found');
    return this.ref(n);
  }
  async moveFile(
    fileId: string,
    newParentId: string,
    _oldParentId?: string,
  ): Promise<DriveFileRef> {
    const n = this.nodes.get(fileId);
    if (!n) throw new Error('not found');
    n.parent = newParentId;
    n.modifiedTime = new Date().toISOString();
    return this.ref(n);
  }
  async deleteFile(fileId: string): Promise<void> {
    this.nodes.delete(fileId);
  }

  // Changes
  async getStartPageToken(): Promise<string> {
    return this.startToken;
  }
  async listChanges(pageToken: string) {
    // Return everything at once for the test. Provider only reads one page.
    const changes = this.changes.map((c) => {
      const n = this.nodes.get(c.fileId);
      return {
        fileId: c.fileId,
        removed: !!c.removed,
        file: n ? this.ref(n) : undefined,
        time: c.time,
        foreign: c.foreign,
      };
    });
    void pageToken;
    return { changes, newStartPageToken: String(Number(this.startToken) + 1) };
  }

  // Test-only helpers
  pathTo(fileId: string): string {
    const parts: string[] = [];
    let cur = this.nodes.get(fileId);
    while (cur && cur.parent !== null && cur.name !== '__root__') {
      parts.unshift(cur.name);
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    return parts.join('/');
  }

  simulateExternalEdit(fileId: string, newContent: string, foreign = true): void {
    const n = this.nodes.get(fileId);
    if (!n) throw new Error('not found');
    n.content = new TextEncoder().encode(newContent);
    n.version += 1;
    n.modifiedTime = new Date().toISOString();
    this.changes.push({ fileId, time: n.modifiedTime, foreign });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: GoogleDriveProviderConfig = {
  kind: 'google-drive',
  clientId: 'CID',
};

function mkEvent(id: string, entityId: string, ts = '2026-08-19T10:00:00.000Z'): SyncEvent {
  return {
    event_id: id,
    business_id: 'BIZ1',
    device_id: 'DEV-A',
    entity_type: 'invoice',
    entity_id: entityId,
    operation: 'create',
    entity_version: 1,
    timestamp: ts,
    payload: { total: 100 },
    payload_hash: 'aa'.repeat(32),
    previous_hash: null,
    sync_status: 'QUEUED',
  };
}

async function connected(): Promise<{
  provider: GoogleDriveStorageProvider;
  drive: FakeDrive;
}> {
  const drive = new FakeDrive();
  drive.seedTokens();
  const provider = new GoogleDriveStorageProvider({ driveApi: drive });
  await provider.connect(config);
  await provider.initializeBusiness({ businessId: 'BIZ1', businessName: 'Acme Traders' });
  return { provider, drive };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleDriveStorageProvider — connect (GIS)', () => {
  it('throws DriveNeedsReconnectError when no tokens exist', async () => {
    const drive = new FakeDrive();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await expect(provider.connect(config)).rejects.toBeInstanceOf(
      DriveNeedsReconnectError,
    );
    const status = await provider.connectionStatus();
    expect(status.state).toBe('DISCONNECTED');
  });

  it('health-checks with getUserInfo when tokens exist', async () => {
    const drive = new FakeDrive();
    drive.seedTokens();
    const spy = vi.spyOn(drive, 'getUserInfo');
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await provider.connect(config);
    expect(spy).toHaveBeenCalledOnce();
    const status = await provider.connectionStatus();
    expect(status.state).toBe('CONNECTED');
    expect(status.account).toBe('owner@example.com');
  });

  it('rejects non-google-drive configs and non-drive.file scope', async () => {
    const drive = new FakeDrive();
    drive.seedTokens();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await expect(
      provider.connect({ kind: 'onedrive', clientId: 'x', clientSecret: 'y', redirectUri: 'z' }),
    ).rejects.toThrow(/cannot handle/);
    await expect(
      provider.connect({ ...config, scope: 'https://drive' as unknown as 'drive.file' }),
    ).rejects.toThrow(/drive.file/);
  });
});

describe('GoogleDriveStorageProvider — initializeBusiness', () => {
  it('creates the §4 folder structure with README, manifest, schema, sync-state, checksums', async () => {
    const { drive, provider } = await connected();

    const status = await provider.connectionStatus();
    expect(status.folderPath).toBe('BusinessVault/Acme Traders');

    const names = [...drive.nodes.values()].map((n) => drive.pathTo(n.id)).sort();
    for (const required of [
      'BusinessVault/Acme Traders/README.txt',
      'BusinessVault/Acme Traders/metadata/manifest.json',
      'BusinessVault/Acme Traders/metadata/schema.json',
      'BusinessVault/Acme Traders/metadata/sync-state.json',
      'BusinessVault/Acme Traders/metadata/checksums.json',
      'BusinessVault/Acme Traders/current',
      'BusinessVault/Acme Traders/invoices',
      'BusinessVault/Acme Traders/attachments/purchases',
      'BusinessVault/Acme Traders/attachments/expenses',
      'BusinessVault/Acme Traders/attachments/products',
      'BusinessVault/Acme Traders/reports',
      'BusinessVault/Acme Traders/snapshots/daily',
      'BusinessVault/Acme Traders/snapshots/monthly',
      'BusinessVault/Acme Traders/snapshots/annual',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('is idempotent — running twice reuses folder and does not clobber README/manifest', async () => {
    const drive = new FakeDrive();
    drive.seedTokens();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await provider.connect(config);

    const first = await provider.initializeBusiness({ businessId: 'BIZ1', businessName: 'Acme' });
    expect(first.reused).toBe(false);

    // Manually mutate README so we can detect a clobber.
    const readmeNode = [...drive.nodes.values()].find(
      (n) => n.name === 'README.txt' && drive.pathTo(n.id) === 'BusinessVault/Acme/README.txt',
    )!;
    readmeNode.content = new TextEncoder().encode('user-customized');
    const readmeIdBefore = readmeNode.id;
    const versionBefore = readmeNode.version;

    const second = await provider.initializeBusiness({ businessId: 'BIZ1', businessName: 'Acme' });
    expect(second.reused).toBe(true);
    expect(second.providerFolderId).toBe(first.providerFolderId);

    const readmeAfter = drive.nodes.get(readmeIdBefore)!;
    expect(new TextDecoder().decode(readmeAfter.content!)).toBe('user-customized');
    expect(readmeAfter.version).toBe(versionBefore);
  });
});

describe('GoogleDriveStorageProvider — listBusinesses', () => {
  it('returns empty when no BusinessVault folder exists', async () => {
    const drive = new FakeDrive();
    drive.seedTokens();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await provider.connect(config);
    const rows = await provider.listBusinesses();
    expect(rows).toEqual([]);
  });

  it('enumerates every business under BusinessVault/ with parsed manifest', async () => {
    // Seed two businesses so we exercise the multi-result path — this is the
    // Restore-picker case, which was silently broken before because the old
    // discoverBusinesses fallback only ever returned the currently-bound one.
    const drive = new FakeDrive();
    drive.seedTokens();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await provider.connect(config);
    await provider.initializeBusiness({ businessId: 'BIZ1', businessName: 'Acme' });
    // Re-initialize with a different business to get a second folder under
    // BusinessVault/. Real users get here by onboarding a second business on
    // the same Drive account.
    await provider.initializeBusiness({ businessId: 'BIZ2', businessName: 'Beta' });

    const rows = await provider.listBusinesses();
    const names = rows.map((r) => r.businessName).sort();
    expect(names).toEqual(['Acme', 'Beta']);
    const acme = rows.find((r) => r.businessName === 'Acme')!;
    expect(acme.folderPath).toBe('BusinessVault/Acme');
    expect(acme.manifest.businessId).toBe('BIZ1');
    expect(acme.manifest.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('skips business folders whose manifest.json is missing or unparseable', async () => {
    const drive = new FakeDrive();
    drive.seedTokens();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    await provider.connect(config);
    await provider.initializeBusiness({ businessId: 'BIZ1', businessName: 'Acme' });

    // Corrupt Acme's manifest — a partial write / external edit.
    const manifest = [...drive.nodes.values()].find(
      (n) => n.name === 'manifest.json' && drive.pathTo(n.id) === 'BusinessVault/Acme/metadata/manifest.json',
    )!;
    manifest.content = new TextEncoder().encode('{not json');

    const rows = await provider.listBusinesses();
    expect(rows).toEqual([]);
  });
});

describe('GoogleDriveStorageProvider — writeJournalEvents', () => {
  it('appends JSONL to journal/YYYY/YYYY-MM.events.jsonl and dedupes on event_id', async () => {
    const { provider, drive } = await connected();

    const e1 = mkEvent('01H1', 'INV1');
    const e2 = mkEvent('01H2', 'INV2');
    const r1 = await provider.writeJournalEvents([e1, e2]);
    expect(r1.written).toBe(2);
    expect(r1.journalPath).toBe('journal/2026/2026-08.events.jsonl');

    // Second call with a duplicate + a new event.
    const e3 = mkEvent('01H3', 'INV3');
    const r2 = await provider.writeJournalEvents([e2, e3]);
    expect(r2.written).toBe(1);
    expect(r2.duplicates).toEqual(['01H2']);

    const events = await provider.readJournalEvents({ businessId: 'BIZ1' });
    expect(events.map((e) => e.event_id)).toEqual(['01H1', '01H2', '01H3']);

    // Ensure content is one JSON object per line.
    const journalNode = [...drive.nodes.values()].find(
      (n) => n.name === '2026-08.events.jsonl',
    )!;
    const text = new TextDecoder().decode(journalNode.content!);
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe('GoogleDriveStorageProvider — writeSnapshot (spec §19 atomic)', () => {
  it('rolls back cleanly when a mid-upload createFile fails; previous manifest untouched', async () => {
    const { provider, drive } = await connected();

    // Grab pre-manifest bytes to compare later.
    const manifestNode = [...drive.nodes.values()].find(
      (n) => n.name === 'manifest.json' && drive.pathTo(n.id).includes('/metadata/'),
    )!;
    const beforeBytes = new Uint8Array(manifestNode.content!);
    const beforeVersion = manifestNode.version;

    // Simulate the 2nd CSV blowing up mid-upload.
    drive.failNextCreate.push('purchases.csv');

    const files = [
      csvFile('invoices.csv', 'id,total\n1,100\n'),
      csvFile('purchases.csv', 'id,total\n1,50\n'),
    ];
    const filesResolved = await Promise.all(files);

    await expect(
      provider.writeSnapshot({
        businessId: 'BIZ1',
        kind: 'daily',
        asOf: '2026-08-19',
        files: filesResolved,
        manifest: { note: 'test' },
      }),
    ).rejects.toThrow(/simulated createFile failure/);

    // Manifest must NOT have been rewritten.
    const afterNode = drive.nodes.get(manifestNode.id)!;
    expect(afterNode.version).toBe(beforeVersion);
    expect(new Uint8Array(afterNode.content!)).toEqual(beforeBytes);

    // No final snapshot folder should exist.
    const dailyId = [...drive.nodes.values()].find(
      (n) => drive.pathTo(n.id) === 'BusinessVault/Acme Traders/snapshots/daily',
    )!.id;
    const finalChild = await drive.findChildByName(dailyId, '2026-08-19');
    expect(finalChild).toBeNull();
  });

  it('happy path: uploads, verifies, moves to final, updates manifest+checksums', async () => {
    const { provider, drive } = await connected();
    const files = await Promise.all([
      csvFile('customers.csv', 'id,name\n1,Ram\n'),
      csvFile('invoices.csv', 'id,total\n1,100\n'),
    ]);
    const handle = await provider.writeSnapshot({
      businessId: 'BIZ1',
      kind: 'daily',
      asOf: '2026-08-19',
      files,
      manifest: { note: 'ok' },
    });
    expect(handle.path).toBe('snapshots/daily/2026-08-19');

    // manifest now points at this snapshot.
    const manifestBlob = await getContent(drive, 'BusinessVault/Acme Traders/metadata/manifest.json');
    const parsed = JSON.parse(new TextDecoder().decode(manifestBlob)) as {
      currentSnapshot: { path: string };
    };
    expect(parsed.currentSnapshot.path).toBe('snapshots/daily/2026-08-19');
  });
});

describe('GoogleDriveStorageProvider — verifyIntegrity', () => {
  it('surfaces HASH_MISMATCH when a checksum-referenced file has been altered', async () => {
    const { provider, drive } = await connected();

    const files = await Promise.all([csvFile('customers.csv', 'id,name\n1,Ram\n')]);
    await provider.writeSnapshot({
      businessId: 'BIZ1',
      kind: 'daily',
      asOf: '2026-08-19',
      files,
      manifest: {},
    });

    // Silently corrupt the snapshotted CSV.
    const csvNode = [...drive.nodes.values()].find(
      (n) => n.name === 'customers.csv' && drive.pathTo(n.id).includes('snapshots/daily/2026-08-19'),
    )!;
    csvNode.content = new TextEncoder().encode('id,name\n1,Corrupted\n');

    const report = await provider.verifyIntegrity();
    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('HASH_MISMATCH');
  });

  it('returns MISSING_CHECKSUMS when no snapshot has been written yet — but manifest scaffolds a stub', async () => {
    // initializeBusiness writes an empty checksums.json ({ files: {} }), so
    // verifyIntegrity should report ok=true with 0 files.
    const { provider } = await connected();
    const report = await provider.verifyIntegrity();
    expect(report.ok).toBe(true);
    expect(report.filesChecked).toBe(0);
  });
});

describe('GoogleDriveStorageProvider — external-edit classification (spec §21)', () => {
  it('classifies journal_entries.csv / payments.csv / invoices.csv as financially-dangerous', () => {
    const drive = new FakeDrive();
    const provider = new GoogleDriveStorageProvider({ driveApi: drive });
    expect(provider.classifyChange('current/journal_entries.csv')).toBe('financially-dangerous');
    expect(provider.classifyChange('current/payments.csv')).toBe('financially-dangerous');
    expect(provider.classifyChange('current/invoices.csv')).toBe('financially-dangerous');
    expect(provider.classifyChange('current/customers.csv')).toBe('safe');
    expect(provider.classifyChange('current/random.csv')).toBe('potential-conflict');
    expect(provider.classifyChange('journal/2026/2026-08.events.jsonl')).toBe('ignored');
  });

  it('getChanges surfaces external edits to invoices.csv without importing them', async () => {
    const { provider, drive } = await connected();

    // Seed a "current/invoices.csv" so a subsequent external edit has something
    // to modify. We use uploadAttachment-style write through the cache by
    // writing a CSV directly via the drive mock and updating the provider
    // cache path manually.
    const currentId = [...drive.nodes.values()].find(
      (n) => drive.pathTo(n.id) === 'BusinessVault/Acme Traders/current',
    )!.id;
    const csvRef = await drive.createFile({
      parentId: currentId,
      name: 'invoices.csv',
      mimeType: 'text/csv',
      body: new Blob(['id,total\n1,100\n']),
    });
    // Prime the provider's fileRef cache so pathForFile can reverse-map.
    // Access private via `as any` since we're in a whitebox test.
    (provider as unknown as { fileRefCache: Map<string, DriveFileRef> }).fileRefCache.set(
      'current/invoices.csv',
      csvRef,
    );

    // Initial getChanges just seeds the cursor.
    const first = await provider.getChanges();
    expect(first.changes).toHaveLength(0);

    // Someone edits the file outside our app.
    drive.simulateExternalEdit(csvRef.id, 'id,total\n1,999\n', true);

    const second = await provider.getChanges(first.nextToken);
    const invoiceChange = second.changes.find((c) => c.path === 'current/invoices.csv');
    expect(invoiceChange).toBeDefined();
    expect(invoiceChange!.foreign).toBe(true);
    expect(provider.classifyChange(invoiceChange!.path)).toBe('financially-dangerous');
  });
});

describe('GoogleDriveStorageProvider — attachments', () => {
  it('rejects paths outside attachments/{purchases,expenses,products}', async () => {
    const { provider } = await connected();
    await expect(
      provider.uploadAttachment({
        path: 'random/foo.pdf',
        blob: new Blob(['x']),
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(/attachments\//);
    await expect(
      provider.uploadAttachment({
        path: 'attachments/other/foo.pdf',
        blob: new Blob(['x']),
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(/subdir/);
  });

  it('round-trips a purchase attachment', async () => {
    const { provider } = await connected();
    const up = await provider.uploadAttachment({
      path: 'attachments/purchases/inv-1.pdf',
      blob: new Blob(['hello']),
      mimeType: 'application/pdf',
    });
    expect(up.providerFileId).toBeTruthy();
    const back = await provider.downloadAttachment({ path: 'attachments/purchases/inv-1.pdf' });
    const bytes = await blobBytes(back);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });
});

describe('GoogleDriveStorageProvider — restoreBusiness', () => {
  it('returns a descriptor with the newest snapshot + journal files after checkpoint', async () => {
    const { provider } = await connected();

    // Write a snapshot at 2026-07-01, then some events in 2026-08.
    const files = await Promise.all([csvFile('customers.csv', 'id,name\n1,Ram\n')]);
    await provider.writeSnapshot({
      businessId: 'BIZ1',
      kind: 'daily',
      asOf: '2026-07-01',
      files,
      manifest: {},
    });
    await provider.writeJournalEvents([mkEvent('01A', 'INV1', '2026-08-05T00:00:00.000Z')]);

    const desc = await provider.restoreBusiness();
    expect(desc.baseSnapshot?.asOf).toBe('2026-07-01');
    expect(desc.journalFiles.map((j) => `${j.year}-${j.month}`)).toContain('2026-8');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function csvFile(name: string, text: string) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc.slice().buffer);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return {
    name,
    content: new Blob([text], { type: 'text/csv' }),
    rowCount: text.split('\n').filter(Boolean).length - 1,
    sha256: hex,
  };
}

async function getContent(drive: FakeDrive, path: string): Promise<Uint8Array> {
  const node = [...drive.nodes.values()].find((n) => drive.pathTo(n.id) === path);
  if (!node) throw new Error(`no node at ${path}`);
  return node.content ?? new Uint8Array(0);
}

beforeEach(() => {
  vi.restoreAllMocks();
});
