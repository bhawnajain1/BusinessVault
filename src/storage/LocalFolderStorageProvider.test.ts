import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// jsdom ships a Blob without .arrayBuffer(); force Node's implementation.
import { Blob as NodeBlob } from 'node:buffer';
import { LocalFolderStorageProvider } from './LocalFolderStorageProvider';
import type { SyncEvent } from './CustomerStorageProvider';
import { canonicalJson, GENESIS_HASH, sha256Hex } from '../journal/event';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Blob = NodeBlob;

// The Node fallback in the provider is gated on NODE_ENV === 'test'. Vitest
// sets this by default, but assert it just in case.
process.env.NODE_ENV = 'test';

async function mktmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'bv-local-folder-'));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const abuf = bytes.slice().buffer as ArrayBuffer;
  const buf = await crypto.subtle.digest('SHA-256', abuf);
  const view = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function mkEvent(over: Partial<SyncEvent>): SyncEvent {
  return {
    event_id: '01JABC0000000000000000000',
    business_id: 'biz_1',
    device_id: 'device_a',
    entity_type: 'invoice',
    entity_id: 'inv_1',
    operation: 'create',
    entity_version: 1,
    timestamp: '2026-08-19T10:00:00.000Z',
    payload: { amount: 100 },
    payload_hash: 'deadbeef',
    previous_hash: null,
    sync_status: 'LOCAL_ONLY',
    ...over,
  };
}

async function connectAndInit(root: string): Promise<LocalFolderStorageProvider> {
  const p = new LocalFolderStorageProvider();
  await p.connect({ kind: 'local-folder', rootPath: root });
  await p.initializeBusiness({ businessId: 'biz_1', businessName: 'Acme Traders' });
  return p;
}

describe('LocalFolderStorageProvider', () => {
  let root: string;

  beforeEach(async () => {
    root = await mktmp();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('initializeBusiness creates the full folder tree and seed metadata', async () => {
    await connectAndInit(root);

    const expected = [
      'BusinessVault - Acme Traders',
      'BusinessVault - Acme Traders/README.txt',
      'BusinessVault - Acme Traders/metadata/manifest.json',
      'BusinessVault - Acme Traders/metadata/schema.json',
      'BusinessVault - Acme Traders/metadata/sync-state.json',
      'BusinessVault - Acme Traders/metadata/checksums.json',
      'BusinessVault - Acme Traders/current',
      'BusinessVault - Acme Traders/journal',
      'BusinessVault - Acme Traders/invoices',
      'BusinessVault - Acme Traders/attachments',
      'BusinessVault - Acme Traders/reports',
      'BusinessVault - Acme Traders/snapshots/daily',
      'BusinessVault - Acme Traders/snapshots/monthly',
      'BusinessVault - Acme Traders/snapshots/annual',
      'BusinessVault - Acme Traders/snapshots/ondemand',
    ];
    for (const rel of expected) {
      expect(fss.existsSync(path.join(root, rel))).toBe(true);
    }

    const manifest = JSON.parse(
      await fs.readFile(
      path.join(root, 'BusinessVault - Acme Traders/metadata/manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.businessId).toBe('biz_1');
    expect(manifest.businessName).toBe('Acme Traders');
    expect(manifest.provider).toBe('local-folder');
  });

  it('initializeBusiness returns reused=true when the folder already exists', async () => {
    const p1 = new LocalFolderStorageProvider();
    await p1.connect({ kind: 'local-folder', rootPath: root });
    const r1 = await p1.initializeBusiness({ businessId: 'biz_1', businessName: 'Acme Traders' });
    expect(r1.reused).toBe(false);

    const p2 = new LocalFolderStorageProvider();
    await p2.connect({ kind: 'local-folder', rootPath: root });
    const r2 = await p2.initializeBusiness({ businessId: 'biz_1', businessName: 'Acme Traders' });
    expect(r2.reused).toBe(true);
  });

  it('rejects reuse of a folder owned by another business', async () => {
    await fs.mkdir(path.join(root, 'BusinessVault', 'Acme Traders', 'metadata'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'BusinessVault', 'Acme Traders', 'metadata', 'manifest.json'),
      JSON.stringify({ businessId: 'biz_other' }),
    );

    const provider = new LocalFolderStorageProvider();
    await provider.connect({ kind: 'local-folder', rootPath: root });
    await expect(
      provider.initializeBusiness({ businessId: 'biz_1', businessName: 'Acme Traders' }),
    ).rejects.toThrow(/different business/);
  });

  it('rejects path traversal through the node backend', async () => {
    const provider = new LocalFolderStorageProvider();
    await provider.connect({ kind: 'local-folder', rootPath: root });
    await provider.initializeBusiness({ businessId: 'biz_1', businessName: 'Acme Traders' });
    await expect(
      provider.uploadAttachment({
        path: '../outside.txt',
        blob: new Blob(['unsafe']),
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow(/traversal|relative|escapes/);
  });

  it('discovers every business when the picked folder contains multiple layouts', async () => {
    await fs.mkdir(path.join(root, 'BusinessVault', 'Real Buiness', 'metadata'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'BusinessVault', 'Real Buiness', 'metadata', 'manifest.json'),
      JSON.stringify({ businessId: 'real-1', businessName: 'Real Buiness', schemaVersion: 1 }),
    );
    await fs.mkdir(path.join(root, 'Tiger Marketing', 'metadata'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'Tiger Marketing', 'metadata', 'manifest.json'),
      JSON.stringify({ businessId: 'tiger-1', businessName: 'Tiger Marketing', schemaVersion: 1 }),
    );

    const p = new LocalFolderStorageProvider();
    await p.connect({ kind: 'local-folder', rootPath: root });
    const businesses = await p.listBusinesses();

    expect(businesses.map((business) => business.businessName)).toEqual([
      'Real Buiness',
      'Tiger Marketing',
    ]);
  });

  it('reads a snapshot that stores its manifest at the business metadata path', async () => {
    const p = await connectAndInit(root);
    const snapshotDir = path.join(
      root,
      'BusinessVault - Acme Traders/snapshots/ondemand/2026-09-24T09-26-06.407Z',
    );
    await fs.mkdir(snapshotDir, { recursive: true });
    const csv = 'id,business_id\n1,biz_1\n';
    await fs.writeFile(path.join(snapshotDir, 'businesses.csv'), csv);
    await fs.writeFile(
      path.join(snapshotDir, 'checksums.json'),
      JSON.stringify({ files: { 'businesses.csv': await sha256(new TextEncoder().encode(csv)) } }),
    );

    const snapshots = await p.listSnapshots({ kind: 'ondemand' });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].verified).toBe(true);

    const snapshot = await p.readSnapshot(snapshots[0].handle);
    expect(snapshot.manifest.businessId).toBe('biz_1');
    expect(snapshot.files).toHaveLength(1);
  });

  it('writeJournalEvents appends to YYYY-MM.events.jsonl and is idempotent', async () => {
    const p = await connectAndInit(root);

    const e1 = mkEvent({ event_id: 'evt_1', timestamp: '2026-08-19T10:00:00.000Z' });
    const e2 = mkEvent({
      event_id: 'evt_2',
      timestamp: '2026-08-19T11:00:00.000Z',
      entity_id: 'inv_2',
    });
    const e3 = mkEvent({
      event_id: 'evt_3',
      timestamp: '2026-09-01T00:00:00.000Z',
      entity_id: 'inv_3',
    });

    const r1 = await p.writeJournalEvents([e1, e2, e3]);
    expect(r1.written).toBe(3);
    expect(r1.duplicates).toEqual([]);

    const augFile = path.join(
      root,
      'BusinessVault - Acme Traders/journal/2026/2026-08.events.jsonl',
    );
    const sepFile = path.join(
      root,
      'BusinessVault - Acme Traders/journal/2026/2026-09.events.jsonl',
    );
    const augLines = (await fs.readFile(augFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(augLines).toHaveLength(2);
    const sepLines = (await fs.readFile(sepFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(sepLines).toHaveLength(1);

    // Replay same batch — no new writes.
    const r2 = await p.writeJournalEvents([e1, e2, e3]);
    expect(r2.written).toBe(0);
    expect(new Set(r2.duplicates)).toEqual(new Set(['evt_1', 'evt_2', 'evt_3']));

    // Append a new event to the same August file.
    const e4 = mkEvent({
      event_id: 'evt_4',
      timestamp: '2026-08-20T09:00:00.000Z',
      entity_id: 'inv_4',
    });
    const r3 = await p.writeJournalEvents([e4]);
    expect(r3.written).toBe(1);
    const augLines2 = (await fs.readFile(augFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(augLines2).toHaveLength(3);
  });

  it('readJournalEvents reads across months and honours sinceEventId', async () => {
    const p = await connectAndInit(root);
    const events = [
      mkEvent({ event_id: 'evt_a', timestamp: '2026-07-01T00:00:00.000Z' }),
      mkEvent({ event_id: 'evt_b', timestamp: '2026-08-01T00:00:00.000Z' }),
      mkEvent({ event_id: 'evt_c', timestamp: '2026-09-01T00:00:00.000Z' }),
    ];
    await p.writeJournalEvents(events);

    const all = await p.readJournalEvents({ businessId: 'biz_1' });
    expect(all.map((e) => e.event_id)).toEqual(['evt_a', 'evt_b', 'evt_c']);

    const since = await p.readJournalEvents({ businessId: 'biz_1', sinceEventId: 'evt_a' });
    expect(since.map((e) => e.event_id)).toEqual(['evt_b', 'evt_c']);

    const aug = await p.readJournalEvents({ businessId: 'biz_1', year: 2026, month: 8 });
    expect(aug.map((e) => e.event_id)).toEqual(['evt_b']);
  });

  it('writeSnapshot is atomic — a mid-write kill leaves the previous snapshot intact', async () => {
    const p = await connectAndInit(root);

    const bytesV1 = new TextEncoder().encode('id,name\n1,alpha\n');
    const shaV1 = await sha256(bytesV1);
    const h1 = await p.writeSnapshot({
      businessId: 'biz_1',
      kind: 'daily',
      asOf: '2026-08-19',
      files: [{ name: 'invoices.csv', content: new Blob([bytesV1]), rowCount: 1, sha256: shaV1 }],
      manifest: { schemaVersion: 1 },
    });
    expect(h1.path).toBe('snapshots/daily/2026-08-19');

    const goodFile = path.join(root, 'BusinessVault - Acme Traders', h1.path, 'invoices.csv');
    expect(fss.existsSync(goodFile)).toBe(true);
    expect(await fs.readFile(goodFile, 'utf8')).toBe('id,name\n1,alpha\n');

    // Attempt a second write where the DECLARED sha256 disagrees with content
    // — simulates a mid-write corruption / kill scenario. writeSnapshot must
    // reject BEFORE swapping so the previous snapshot survives.
    const bytesV2 = new TextEncoder().encode('id,name\n2,beta\n');
    await expect(
      p.writeSnapshot({
        businessId: 'biz_1',
        kind: 'daily',
        asOf: '2026-08-19',
        files: [
          {
            name: 'invoices.csv',
            content: new Blob([bytesV2]),
            rowCount: 1,
            sha256: 'ffff'.repeat(16), // wrong
          },
        ],
        manifest: { schemaVersion: 1 },
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    // Previous snapshot still intact.
    expect(fss.existsSync(goodFile)).toBe(true);
    expect(await fs.readFile(goodFile, 'utf8')).toBe('id,name\n1,alpha\n');

    // Staging area should be cleaned up.
    const stagingRoot = path.join(root, 'BusinessVault - Acme Traders/.staging');
    const stagingEntries = fss.existsSync(stagingRoot) ? await fs.readdir(stagingRoot) : [];
    expect(stagingEntries.filter((n) => !n.startsWith('.'))).toHaveLength(0);

    // Now a legitimate rewrite must swap cleanly.
    const shaV2 = await sha256(bytesV2);
    const h2 = await p.writeSnapshot({
      businessId: 'biz_1',
      kind: 'daily',
      asOf: '2026-08-19',
      files: [{ name: 'invoices.csv', content: new Blob([bytesV2]), rowCount: 1, sha256: shaV2 }],
      manifest: { schemaVersion: 1 },
    });
    expect(await fs.readFile(goodFile, 'utf8')).toBe('id,name\n2,beta\n');
    // Backup dir cleaned up.
    const stagingEntries2 = fss.existsSync(stagingRoot) ? await fs.readdir(stagingRoot) : [];
    expect(stagingEntries2.filter((n) => !n.startsWith('.'))).toHaveLength(0);
    expect(h2.asOf).toBe('2026-08-19');
  });

  it('verifyIntegrity detects a hand-corrupted CSV in a snapshot', async () => {
    const p = await connectAndInit(root);

    const bytes = new TextEncoder().encode('id,name\n1,alpha\n2,beta\n');
    const sha = await sha256(bytes);
    await p.writeSnapshot({
      businessId: 'biz_1',
      kind: 'daily',
      asOf: '2026-08-19',
      files: [{ name: 'invoices.csv', content: new Blob([bytes]), rowCount: 2, sha256: sha }],
      manifest: { schemaVersion: 1 },
    });

    // Clean state should pass.
    const r1 = await p.verifyIntegrity();
    expect(r1.ok).toBe(true);
    expect(r1.issues).toEqual([]);
    expect(r1.filesChecked).toBeGreaterThan(0);

    // Hand-corrupt the CSV directly on disk (simulate an external editor).
    const csvPath = path.join(
      root,
      'BusinessVault - Acme Traders/snapshots/daily/2026-08-19/invoices.csv',
    );
    await fs.writeFile(csvPath, 'id,name\n1,alpha\n2,BETA_TAMPERED\n');

    const r2 = await p.verifyIntegrity();
    expect(r2.ok).toBe(false);
    const hashMismatches = r2.issues.filter((i) => i.code === 'HASH_MISMATCH');
    expect(hashMismatches).toHaveLength(1);
    expect(hashMismatches[0].path).toBe('snapshots/daily/2026-08-19/invoices.csv');
    expect(hashMismatches[0].severity).toBe('error');
  });

  it('verifyIntegrity accepts metadata-wrapped snapshot checksums', async () => {
    const p = await connectAndInit(root);
    const snapshotDir = path.join(root, 'BusinessVault - Acme Traders', 'snapshots', 'ondemand', '2026-09-23');
    await fs.mkdir(snapshotDir, { recursive: true });
    const csv = 'id,name\n1,Acme\n';
    await fs.writeFile(path.join(snapshotDir, 'customers.csv'), csv);
    const hash = await sha256(new TextEncoder().encode(csv));
    await fs.writeFile(
      path.join(snapshotDir, 'checksums.json'),
      JSON.stringify({ schemaVersion: 1, kind: 'ondemand', asOf: '2026-09-23', files: { 'customers.csv': hash } }),
    );

    const report = await p.verifyIntegrity();
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('verifyIntegrity flags corrupt journal lines', async () => {
    const p = await connectAndInit(root);
    await p.writeJournalEvents([mkEvent({ event_id: 'evt_1' })]);

    const jp = path.join(
      root,
      'BusinessVault - Acme Traders/journal/2026/2026-08.events.jsonl',
    );
    // Append a garbage line.
    await fs.appendFile(jp, 'this is not json\n');

    const r = await p.verifyIntegrity();
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'CORRUPT_JOURNAL_LINE')).toBe(true);
  });

  it('verifyIntegrity validates cryptographic journal chains', async () => {
    const p = await connectAndInit(root);
    const payload = { amount: 100 };
    const payloadHash = await sha256Hex(canonicalJson(payload));
    await p.writeJournalEvents([
      mkEvent({ payload, payload_hash: payloadHash, previous_hash: GENESIS_HASH }),
    ]);

    const clean = await p.verifyIntegrity();
    expect(clean.ok).toBe(true);

    const journalPath = path.join(
      root,
      'BusinessVault - Acme Traders/journal/2026/2026-08.events.jsonl',
    );
    const original = await fs.readFile(journalPath, 'utf8');
    await fs.writeFile(journalPath, original.replace('"amount":100', '"amount":101'));

    const tampered = await p.verifyIntegrity();
    expect(tampered.ok).toBe(false);
    expect(tampered.issues.some((i) => i.code === 'PAYLOAD_HASH_MISMATCH')).toBe(true);
  });

  it('readSnapshot round-trips CSVs and manifest', async () => {
    const p = await connectAndInit(root);
    const bytes = new TextEncoder().encode('id,name\n1,alpha\n');
    const sha = await sha256(bytes);
    const handle = await p.writeSnapshot({
      businessId: 'biz_1',
      kind: 'monthly',
      asOf: '2026-08',
      files: [{ name: 'ledger.csv', content: new Blob([bytes]), rowCount: 1, sha256: sha }],
      manifest: { schemaVersion: 1, note: 'test' },
    });

    const data = await p.readSnapshot(handle);
    expect(data.files).toHaveLength(1);
    expect(data.files[0].name).toBe('ledger.csv');
    expect(data.manifest.note).toBe('test');
    expect(data.checksums['ledger.csv']).toBe(sha);
    const text = await data.files[0].content.text();
    expect(text).toBe('id,name\n1,alpha\n');
  });

  it('listSnapshots returns all snapshots of a kind, sorted by asOf', async () => {
    const p = await connectAndInit(root);
    for (const day of ['2026-08-17', '2026-08-18', '2026-08-19']) {
      const bytes = new TextEncoder().encode(`day\n${day}\n`);
      const sha = await sha256(bytes);
      await p.writeSnapshot({
        businessId: 'biz_1',
        kind: 'daily',
        asOf: day,
        files: [{ name: 'x.csv', content: new Blob([bytes]), rowCount: 1, sha256: sha }],
        manifest: {},
      });
    }
    const list = await p.listSnapshots({ kind: 'daily' });
    expect(list.map((s) => s.handle.asOf)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
    for (const s of list) expect(s.verified).toBe(true);
  });

  it('upload + download attachments round-trip', async () => {
    const p = await connectAndInit(root);
    const bytes = new TextEncoder().encode('hello');
    const r = await p.uploadAttachment({
      path: 'attachments/hello.txt',
      blob: new Blob([bytes]),
      mimeType: 'text/plain',
    });
    expect(r.providerFileId).toContain('attachments/hello.txt');
    const blob = await p.downloadAttachment({ path: 'attachments/hello.txt' });
    expect(await blob.text()).toBe('hello');
  });

  it('restoreBusiness enumerates journal files and attachments', async () => {
    const p = await connectAndInit(root);
    await p.writeJournalEvents([
      mkEvent({ event_id: 'evt_1', timestamp: '2026-08-19T10:00:00.000Z' }),
      mkEvent({
        event_id: 'evt_2',
        timestamp: '2026-09-01T00:00:00.000Z',
        entity_id: 'inv_2',
      }),
    ]);
    await p.uploadAttachment({
      path: 'attachments/a.txt',
      blob: new Blob([new TextEncoder().encode('A')]),
      mimeType: 'text/plain',
    });

    const desc = await p.restoreBusiness();
    expect(desc.businessId).toBe('biz_1');
    expect(desc.journalFiles.map((j) => `${j.year}-${j.month}`)).toEqual(['2026-8', '2026-9']);
    expect(desc.attachmentIndex.map((a) => a.path)).toEqual(['attachments/a.txt']);
  });

  it('connectionStatus reflects lifecycle', async () => {
    const p = new LocalFolderStorageProvider();
    expect((await p.connectionStatus()).state).toBe('DISCONNECTED');
    await p.connect({ kind: 'local-folder', rootPath: root });
    const s1 = await p.connectionStatus();
    expect(s1.state).toBe('CONNECTED');
    await p.initializeBusiness({ businessId: 'biz_1', businessName: 'Acme Traders' });
    const s2 = await p.connectionStatus();
    expect(s2.folderPath).toBe('BusinessVault - Acme Traders');
    await p.disconnect();
    expect((await p.connectionStatus()).state).toBe('DISCONNECTED');
  });

  it('discovers and reuses a directly selected business folder', async () => {
    const producer = await connectAndInit(root);
    await producer.writeJournalEvents([
      mkEvent({ event_id: 'evt_1' }),
    ]);

    const businessRoot = path.join(root, 'BusinessVault - Acme Traders');
    const direct = new LocalFolderStorageProvider();
    await direct.connect({ kind: 'local-folder', rootPath: businessRoot });

    const businesses = await direct.listBusinesses();
    expect(businesses).toHaveLength(1);
    expect(businesses[0].businessName).toBe('Acme Traders');
    expect(businesses[0].folderPath).toBe('.');

    await direct.initializeBusiness({
      businessId: businesses[0].businessId,
      businessName: businesses[0].businessName,
    });
    expect((await direct.restoreBusiness()).journalFiles).toHaveLength(1);
  });

  it('rejects a config of the wrong kind', async () => {
    const p = new LocalFolderStorageProvider();
    await expect(
      p.connect({
        kind: 'google-drive',
        clientId: 'x',
      }),
    ).rejects.toThrow(/local-folder/);
  });

  it('writeJournalEvents rejects a mixed business_id batch', async () => {
    const p = await connectAndInit(root);
    await expect(
      p.writeJournalEvents([
        mkEvent({ event_id: 'evt_1' }),
        mkEvent({ event_id: 'evt_2', business_id: 'biz_other' }),
      ]),
    ).rejects.toThrow(/mixed business_id/);
  });
});
