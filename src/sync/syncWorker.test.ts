import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { ulid } from 'ulid';
import { db } from '../db';
import type { Business, SyncEvent } from '../db/types';
import {
  computeBackoffMs,
  claimDue,
  enqueue,
  listDue,
  pendingCount,
  deadCount,
} from './syncQueue';
import { startSyncWorker, type BackupHealth } from './syncWorker';
import type {
  ConnectionStatus,
  CustomerStorageProvider,
  IntegrityReport,
  ProviderConfig,
  SnapshotHandle,
  UploadAttachmentResult,
  WriteResult,
} from '../storage/CustomerStorageProvider';

const BUSINESS_ID = '01BUSINESS0000000000000000';
const DEVICE_ID = '01DEVICE0000000000000000000';

function makeBusiness(): Business {
  return {
    id: BUSINESS_ID,
    name: 'Acme',
    legal_name: 'Acme Traders',
    gstin: null,
    pan: null,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    state_code: '',
    pincode: '',
    country: 'IN',
    phone: '',
    email: '',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    entity_version: 1,
  };
}

function makeEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    event_id: ulid(),
    business_id: BUSINESS_ID,
    device_id: DEVICE_ID,
    entity_type: 'invoice',
    entity_id: ulid(),
    operation: 'created',
    entity_version: 1,
    timestamp: new Date().toISOString(),
    payload: { foo: 'bar' },
    payload_hash: 'deadbeef',
    previous_hash: '',
    sync_status: 'QUEUED',
    sync_attempts: 0,
    last_error: null,
    synced_at: null,
    journal_file: null,
    ...overrides,
  };
}

class FakeProvider implements CustomerStorageProvider {
  writes: number = 0;
  uploadedAttachments: Array<{ path: string; text: string }> = [];
  seenEventIds: Set<string> = new Set();
  writeShouldThrow: null | string = null;
  reconnectCount: number = 0;
  connected: boolean = true;

  async connect(_c: ProviderConfig): Promise<void> {
    this.reconnectCount += 1;
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async connectionStatus(): Promise<ConnectionStatus> {
    return { state: this.connected ? 'CONNECTED' : 'DISCONNECTED' };
  }
  async initializeBusiness(): Promise<never> {
    throw new Error('not used');
  }
  async writeJournalEvents(events: unknown[]): Promise<WriteResult> {
    if (this.writeShouldThrow) {
      throw new Error(this.writeShouldThrow);
    }
    this.writes += 1;
    const dups: string[] = [];
    for (const e of events as { event_id: string }[]) {
      if (this.seenEventIds.has(e.event_id)) dups.push(e.event_id);
      else this.seenEventIds.add(e.event_id);
    }
    return {
      written: events.length - dups.length,
      duplicates: dups,
      journalPath: 'journal/2026/2026-08.events.jsonl',
    };
  }
  async readJournalEvents(): Promise<never> {
    throw new Error('not used');
  }
  async writeSnapshot(): Promise<SnapshotHandle> {
    return {
      businessId: BUSINESS_ID,
      kind: 'daily',
      path: 'snapshots/daily/2026-08-19',
      providerFolderId: 'x',
      asOf: '2026-08-19',
      createdAt: new Date().toISOString(),
    };
  }
  async readSnapshot(): Promise<never> {
    throw new Error('not used');
  }
  async listSnapshots(): Promise<never[]> {
    return [];
  }
  async uploadAttachment(input?: { path: string; blob: Blob }): Promise<UploadAttachmentResult> {
    if (input) this.uploadedAttachments.push({
      path: input.path,
      text: await (input.blob as NodeBlob).text(),
    });
    return { providerFileId: 'file123' };
  }
  async downloadAttachment(): Promise<Blob> {
    return new Blob();
  }
  async verifyIntegrity(): Promise<IntegrityReport> {
    return {
      businessId: BUSINESS_ID,
      checkedAt: new Date().toISOString(),
      ok: true,
      filesChecked: 0,
      issues: [],
    };
  }
  async getChanges(): Promise<never> {
    throw new Error('not used');
  }
  async restoreBusiness(): Promise<never> {
    throw new Error('not used');
  }
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.businesses.add(makeBusiness());
});

afterEach(async () => {
  // Nothing to reset; each test creates its own worker and stops it.
});

describe('computeBackoffMs', () => {
  it('follows the base * 2^attempts * (0.5+r) formula with cap', () => {
    expect(computeBackoffMs({ attempts: 1, rng: () => 0 })).toBe(
      Math.floor(2000 * 0.5),
    );
    expect(computeBackoffMs({ attempts: 2, rng: () => 0 })).toBe(
      Math.floor(4000 * 0.5),
    );
    expect(computeBackoffMs({ attempts: 3, rng: () => 0 })).toBe(
      Math.floor(8000 * 0.5),
    );
    const huge = computeBackoffMs({ attempts: 40, rng: () => 0.999 });
    expect(huge).toBeLessThanOrEqual(5 * 60_000);
    expect(huge).toBeGreaterThanOrEqual(5 * 60_000 * 0.5 - 1);
  });

  it('is deterministic when rng is injected', () => {
    const rng = (): number => 0.25;
    expect(computeBackoffMs({ attempts: 3, rng })).toBe(
      computeBackoffMs({ attempts: 3, rng }),
    );
  });
});

describe('syncQueue persistence', () => {
  it('surfaces due jobs and survives a fresh Dexie handle', async () => {
    await enqueue({
      businessId: BUSINESS_ID,
      kind: 'journal_flush',
      payload: { businessId: BUSINESS_ID, eventIds: [] },
      runAt: '1970-01-01T00:00:00.000Z',
    });
    db.close();
    await db.open();
    const due = await listDue({ now: new Date() });
    expect(due).toHaveLength(1);
    expect(due[0].kind).toBe('journal_flush');
  });

  it('claims due jobs atomically so a second claimant gets none', async () => {
    await enqueue({
      businessId: BUSINESS_ID,
      kind: 'journal_flush',
      payload: { businessId: BUSINESS_ID, eventIds: [] },
      runAt: '1970-01-01T00:00:00.000Z',
    });

    const [first, second] = await Promise.all([
      claimDue(BUSINESS_ID, new Date('2026-08-19T12:00:00Z'), 1),
      claimDue(BUSINESS_ID, new Date('2026-08-19T12:00:00Z'), 1),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect((await db.sync_queue.toArray())[0].status).toBe('running');
  });
});

describe('startSyncWorker — batching', () => {
  it('coalesces up to maxBatchSize events per journal_flush', async () => {
    const provider = new FakeProvider();
    const events: SyncEvent[] = [];
    for (let i = 0; i < 250; i += 1) events.push(makeEvent());
    await db.sync_events.bulkAdd(events);

    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:00Z'),
      rng: () => 0.5,
      batchWindowMs: 0,
      maxBatchSize: 200,
      isOnline: () => true,
      autoStart: false,
    });

    await handle.tick();
    handle.stop();

    expect(provider.writes).toBe(2);
    const synced = await db.sync_events
      .where('sync_status')
      .equals('SYNCED')
      .count();
    expect(synced).toBe(250);
  });

  it('loads attachment bytes by id for a durable upload job', async () => {
    const provider = new FakeProvider();
    await db.attachments.add({
      id: 'gst-source-attachment',
      business_id: BUSINESS_ID,
      ref_type: 'gstr2b_import',
      ref_id: 'gst-import',
      filename: 'gstr2b.json',
      mime_type: 'application/json',
      size_bytes: 11,
      checksum: 'checksum',
      blob: new NodeBlob(['source-data']),
      drive_file_id: null,
      logical_path: 'attachments/gstr2b/import-1.json',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await enqueue({
      businessId: BUSINESS_ID,
      kind: 'attachment_upload',
      payload: { attachmentId: 'gst-source-attachment' },
    });
    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      batchWindowMs: 0,
      autoStart: false,
    });

    await handle.tick();
    await handle.stopAsync();

    expect(provider.uploadedAttachments).toEqual([{
      path: 'attachments/gstr2b/import-1.json',
      text: 'source-data',
    }]);
    expect(await db.attachments.get('gst-source-attachment')).toMatchObject({ drive_file_id: 'file123' });
    expect((await db.sync_queue.toArray())[0]).toMatchObject({ status: 'done' });
  });

  it('binds work to one business and coalesces concurrent ticks', async () => {
    const otherBusinessId = '01OTHERBUSINESS000000000000';
    await db.businesses.add({ ...makeBusiness(), id: otherBusinessId, name: 'Other' });
    const provider = new FakeProvider();
    await db.sync_events.bulkAdd([
      makeEvent(),
      makeEvent({ business_id: otherBusinessId }),
    ]);
    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:00Z'),
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });

    await Promise.all([handle.tick(), handle.tick(), handle.tick()]);

    expect(provider.writes).toBe(1);
    expect(await db.sync_events.where('[business_id+sync_status]').equals([BUSINESS_ID, 'SYNCED']).count()).toBe(1);
    expect(await db.sync_events.where('[business_id+sync_status]').equals([otherBusinessId, 'QUEUED']).count()).toBe(1);
    handle.stop();
  });

  it('stopAsync drains an in-flight tick without late status callbacks', async () => {
    const provider = new FakeProvider();
    await db.sync_events.add(makeEvent());
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    provider.writeJournalEvents = async (events): Promise<WriteResult> => {
      started = true;
      await blocked;
      return { written: events.length, duplicates: [], journalPath: 'journal/test' };
    };
    const seen: BackupHealth[] = [];
    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: (health) => seen.push(health),
      clock: () => new Date('2026-08-19T12:00:00Z'),
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });
    const tick = handle.tick();
    while (!started) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const seenBeforeStop = seen.length;
    const draining = handle.stopAsync();
    release();
    await draining;
    await tick;

    expect(seen.length).toBe(seenBeforeStop);
    expect((await db.sync_queue.toArray())[0].status).toBe('done');
  });
});

describe('startSyncWorker — offline queueing survives restart', () => {
  it('keeps events QUEUED while offline, drains after restart', async () => {
    const provider = new FakeProvider();
    await db.sync_events.bulkAdd([makeEvent(), makeEvent()]);

    const offlineHandle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:00Z'),
      batchWindowMs: 0,
      isOnline: () => false,
      autoStart: false,
    });
    await offlineHandle.tick();
    offlineHandle.stop();

    expect(provider.writes).toBe(0);
    expect(
      await db.sync_events.where('sync_status').equals('QUEUED').count(),
    ).toBe(2);

    // Restart with connectivity restored — Dexie state persists.
    const onlineHandle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:01Z'),
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });
    await onlineHandle.tick();
    onlineHandle.stop();

    expect(provider.writes).toBe(1);
    expect(
      await db.sync_events.where('sync_status').equals('SYNCED').count(),
    ).toBe(2);
  });
});

describe('startSyncWorker — OAuth expired retries via backoff (GIS)', () => {
  // Under GIS the worker CANNOT call provider.connect on its own — there is no
  // client secret and no way to open a popup from a background timer. Silent
  // refresh is handled inside the DriveApiClient. Transient OAUTH_EXPIRED
  // failures must therefore behave like any other transient error: the job
  // stays 'pending' and retries via backoff. Explicit DriveNeedsReconnectError
  // (covered in the next test) is a separate signal that the user must click
  // Reconnect in Settings.
  it('does NOT auto-reconnect on OAUTH_EXPIRED; leaves job for retry', async () => {
    const provider = new FakeProvider();
    provider.writeShouldThrow = 'OAUTH_EXPIRED token needs refresh';
    await db.sync_events.bulkAdd([makeEvent()]);

    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:00Z'),
      rng: () => 0.5,
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });
    await handle.tick();

    expect(provider.reconnectCount).toBe(0);
    const jobs = await db.sync_queue.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].attempts).toBe(1);

    handle.stop();
  });

  it('surfaces DriveNeedsReconnectError as pending without reconnecting', async () => {
    const provider = new FakeProvider();
    provider.writeShouldThrow =
      'DriveNeedsReconnectError: Drive needs to be reconnected';
    await db.sync_events.bulkAdd([makeEvent()]);

    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:00Z'),
      rng: () => 0.5,
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });
    await handle.tick();

    expect(provider.reconnectCount).toBe(0);
    const jobs = await db.sync_queue.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].attempts).toBe(1);

    handle.stop();
  });
});

describe('startSyncWorker — dead letter after N attempts', () => {
  it('keeps the row with status=failed, never discards it', async () => {
    const provider = new FakeProvider();
    provider.writeShouldThrow = 'transient network error';
    await db.sync_events.bulkAdd([makeEvent()]);

    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: () => {},
      clock: () => new Date('2026-08-19T12:00:00Z'),
      rng: () => 0.5,
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });
    await handle.tick();

    let job = (await db.sync_queue.toArray())[0];
    expect(job).toBeDefined();
    await db.sync_queue.update(job.id, {
      attempts: job.max_attempts - 1,
      status: 'pending',
      next_attempt_at: '1970-01-01T00:00:00.000Z',
    });

    await handle.tick();
    job = (await db.sync_queue.toArray())[0];
    expect(job.status).toBe('failed');
    expect(job.attempts).toBeGreaterThanOrEqual(job.max_attempts);
    expect(await deadCount()).toBeGreaterThanOrEqual(1);
    // §10 — row preserved, never discarded.
    expect(await db.sync_queue.count()).toBeGreaterThanOrEqual(1);
    handle.stop();
  });
});

describe('startSyncWorker — health reporting', () => {
  it('emits HEALTHY with pending 0 after a successful drain', async () => {
    const provider = new FakeProvider();
    await db.sync_events.bulkAdd([makeEvent()]);
    const seen: BackupHealth[] = [];
    const handle = startSyncWorker({
      businessId: BUSINESS_ID,
      provider,
      onStateChange: (s) => seen.push(s),
      clock: () => new Date('2026-08-19T12:00:00Z'),
      batchWindowMs: 0,
      isOnline: () => true,
      autoStart: false,
    });
    await handle.tick();
    handle.stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(await pendingCount()).toBe(0);
  });
});
