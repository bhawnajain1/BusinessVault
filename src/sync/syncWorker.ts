import { db } from '../db';
import type { SyncEvent, SyncQueueJob } from '../db/types';
import type {
  CustomerStorageProvider,
  SyncEvent as ProviderSyncEvent,
  WriteSnapshotInput,
  UploadAttachmentInput,
} from '../storage/CustomerStorageProvider';
import {
  computeBackoffMs,
  enqueue,
  listDue,
  markDone,
  markFailure,
  markInFlight,
  pendingCount,
} from './syncQueue';
import {
  addPokeListener,
  pokeSyncWorker as pokeSyncWorkerImpl,
  removePokeListener,
} from './pokeChannel';
import { log } from '../lib/log';

// Spec §28/§29: shape of the header cloud indicator.
export type BackupHealthStatus =
  | 'HEALTHY'
  | 'SYNCING'
  | 'OFFLINE'
  | 'DISCONNECTED'
  | 'ERROR'
  | 'CONFLICT'
  | 'INTEGRITY_FAILURE';

export interface BackupHealth {
  status: BackupHealthStatus;
  pending: number;
  lastEventSyncAt: string | null;
  lastFullSnapshotAt: string | null;
  lastError?: string;
  updatedAt: string;
}

export interface StartWorkerDeps {
  provider: CustomerStorageProvider;
  onStateChange: (state: BackupHealth) => void;
  // Injectable knobs — tests set these; production omits them.
  clock?: () => Date;
  rng?: () => number;
  tickIntervalMs?: number;
  offlineTickMs?: number;
  batchWindowMs?: number;
  maxBatchSize?: number;
  isOnline?: () => boolean;
  autoStart?: boolean;
}

export interface StopHandle {
  stop: () => void;
  tick: () => Promise<void>;
  flushBatch: () => Promise<void>;
  getHealth: () => BackupHealth;
}

// Task prompt: 'event-batch'|'snapshot'|'attachment'. Internally we already
// have 'journal_flush' | 'snapshot' | 'attachment_upload' in schema. This
// map is intentionally tiny; the worker branches on kind.

interface JournalBatchPayload {
  businessId: string;
  eventIds: string[];
}

interface SnapshotPayload {
  input: WriteSnapshotInput;
}

interface AttachmentPayload {
  input: UploadAttachmentInput;
  attachmentId?: string;
}

const HEALTH_KV_KEY = 'sync.backupHealth';
const DEFAULT_TICK_MS = 5_000;
const DEFAULT_OFFLINE_TICK_MS = 30_000;
const DEFAULT_BATCH_WINDOW_MS = 5_000;
const DEFAULT_MAX_BATCH = 200;

// Re-export for callers that already imported pokeSyncWorker from this
// module. Listeners live in ./pokeChannel so database.ts can statically
// import without a cycle.
export const pokeSyncWorker = pokeSyncWorkerImpl;

const iso = (d: Date): string => d.toISOString();

function isOnlineDefault(): boolean {
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
    return navigator.onLine;
  }
  return true;
}

async function loadHealth(): Promise<BackupHealth> {
  const row = await db.kv.get(HEALTH_KV_KEY);
  if (row && row.value && typeof row.value === 'object') {
    return row.value as BackupHealth;
  }
  return {
    status: 'HEALTHY',
    pending: 0,
    lastEventSyncAt: null,
    lastFullSnapshotAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

async function saveHealth(h: BackupHealth): Promise<void> {
  await db.kv.put({ key: HEALTH_KV_KEY, value: h, updated_at: h.updatedAt });
}

export function toProviderEvent(e: SyncEvent): ProviderSyncEvent {
  return {
    event_id: e.event_id,
    business_id: e.business_id,
    device_id: e.device_id,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    // The DB uses 'created'/'updated'/... — provider uses 'create'/'update'/...
    // Map both worlds.
    operation:
      e.operation === 'created'
        ? 'create'
        : e.operation === 'updated'
          ? 'update'
          : e.operation === 'deleted'
            ? 'delete'
            : e.operation === 'reversed'
              ? 'reverse'
              : 'update',
    entity_version: e.entity_version,
    timestamp: e.timestamp,
    payload:
      typeof e.payload === 'object' && e.payload !== null
        ? (e.payload as Readonly<Record<string, unknown>>)
        : {},
    payload_hash: e.payload_hash,
    previous_hash: e.previous_hash || null,
    sync_status: e.sync_status,
  };
}

// Batch pending sync_events into an 'event-batch' queue job. Caller is
// responsible for calling this periodically (or when > maxBatch pending).
export async function coalescePendingEvents(
  businessId: string,
  maxBatch: number,
  now: Date = new Date(),
): Promise<string | null> {
  const events = await db.sync_events
    .where('[business_id+sync_status]')
    .equals([businessId, 'QUEUED'])
    .limit(maxBatch)
    .toArray();
  if (events.length === 0) return null;
  const eventIds = events.map((e) => e.event_id);
  await db.sync_events
    .where('event_id')
    .anyOf(eventIds)
    .modify({ sync_status: 'SYNCING' });
  const job = await enqueue(
    {
      businessId,
      kind: 'journal_flush',
      payload: { businessId, eventIds } satisfies JournalBatchPayload,
    },
    now,
  );
  return job.id;
}

export function startSyncWorker(deps: StartWorkerDeps): StopHandle {
  const clock = deps.clock ?? ((): Date => new Date());
  const rng = deps.rng ?? Math.random;
  const tickMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
  const offlineMs = deps.offlineTickMs ?? DEFAULT_OFFLINE_TICK_MS;
  const batchWindowMs = deps.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxBatch = deps.maxBatchSize ?? DEFAULT_MAX_BATCH;
  const isOnline = deps.isOnline ?? isOnlineDefault;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastBatchAt = clock().getTime();
  let currentHealth: BackupHealth = {
    status: 'HEALTHY',
    pending: 0,
    lastEventSyncAt: null,
    lastFullSnapshotAt: null,
    updatedAt: iso(clock()),
  };

  const emit = (patch: Partial<BackupHealth>): void => {
    currentHealth = {
      ...currentHealth,
      ...patch,
      updatedAt: iso(clock()),
    };
    void saveHealth(currentHealth);
    deps.onStateChange(currentHealth);
  };

  // Boot: pick up persisted health so the header renders correctly during
  // the first tick, per §29.
  void loadHealth().then((h) => {
    currentHealth = h;
    deps.onStateChange(h);
  });

  const flushBatch = async (): Promise<void> => {
    // Coalesce all QUEUED sync_events across businesses. Simpler than
    // per-business timers; providers dedupe by event_id anyway (§10 idem).
    const businesses = await db.businesses.toArray();
    for (const b of businesses) {
      // Drain: keep enqueueing batches of up to maxBatch until empty.
      while (!stopped) {
        const jobId = await coalescePendingEvents(b.id, maxBatch, clock());
        if (!jobId) break;
      }
    }
    lastBatchAt = clock().getTime();
  };

  const runJob = async (job: SyncQueueJob): Promise<void> => {
    const now = clock();
    await markInFlight(job.id, now);
    try {
      if (job.kind === 'journal_flush') {
        const p = job.payload as JournalBatchPayload;
        const rows = await db.sync_events
          .where('event_id')
          .anyOf(p.eventIds)
          .toArray();
        const providerEvents = rows.map(toProviderEvent);
        const res = await deps.provider.writeJournalEvents(providerEvents);
        // Mark synced. Duplicates are still SYNCED (idempotent replay).
        const nowIso = iso(clock());
        await db.sync_events
          .where('event_id')
          .anyOf(p.eventIds)
          .modify({
            sync_status: 'SYNCED',
            synced_at: nowIso,
            journal_file: res.journalPath,
            last_error: null,
          });
        await markDone(job.id, clock());
        emit({
          status: 'HEALTHY',
          pending: await pendingCount(),
          lastEventSyncAt: nowIso,
        });
      } else if (job.kind === 'snapshot') {
        const p = job.payload as SnapshotPayload;
        if (!p || !p.input || typeof p.input.businessId !== 'string') {
          // Malformed payload — was queued by a broken caller. Fail dead so
          // the queue doesn't spin forever burning quota.
          await markFailure({
            id: job.id,
            error: 'snapshot job has malformed payload (missing p.input.businessId)',
            attempts: job.max_attempts,
            nextAttemptAt: clock(),
            now: clock(),
            dead: true,
          });
          return;
        }
        const handle = await deps.provider.writeSnapshot(p.input);
        await markDone(job.id, clock());
        emit({
          status: 'HEALTHY',
          pending: await pendingCount(),
          lastFullSnapshotAt: handle.createdAt,
        });
      } else if (job.kind === 'attachment_upload') {
        const p = job.payload as AttachmentPayload;
        const res = await deps.provider.uploadAttachment(p.input);
        if (p.attachmentId) {
          await db.attachments.update(p.attachmentId, {
            drive_file_id: res.providerFileId,
            updated_at: iso(clock()),
          });
        }
        await markDone(job.id, clock());
        emit({ status: 'HEALTHY', pending: await pendingCount() });
      } else {
        // Unknown kinds get shelved as dead so they don't retry forever.
        await markFailure({
          id: job.id,
          error: `unknown kind: ${job.kind}`,
          attempts: job.max_attempts,
          nextAttemptAt: clock(),
          now: clock(),
          dead: true,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('sync', 'job failed', {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts + 1,
        error: err,
      });
      const attempts = job.attempts + 1;
      const dead = attempts >= job.max_attempts;

      // Distinguish transient OAuth errors (§30). Provider is expected to
      // throw either a message containing 'OAUTH_EXPIRED' or 'DISCONNECTED'.
      const oauth = /OAUTH_EXPIRED|invalid_grant|unauthorized/i.test(msg);
      const disconnected =
        /DISCONNECTED|permission_revoked|revoked/i.test(msg);
      if (oauth) {
        try {
          await deps.provider.connect(
            // A no-config reconnect: the provider is expected to consult its
            // stored refresh token. If it needs UI reauth it will throw
            // DISCONNECTED and we surface that below.
            { kind: 'google-drive', clientId: '', clientSecret: '', redirectUri: '' },
          );
        } catch {
          /* fall through to normal failure handling */
        }
      }

      if (dead) {
        // §10: never discard; row stays with status='failed' + attempts>=max.
        // Revert affected sync_events to QUEUED so the next successful job
        // picks them up (unless the whole business has been disconnected).
        if (job.kind === 'journal_flush') {
          const p = job.payload as JournalBatchPayload;
          await db.sync_events
            .where('event_id')
            .anyOf(p.eventIds)
            .modify({
              sync_status: 'FAILED',
              last_error: msg,
              sync_attempts: attempts,
            });
        }
        await markFailure({
          id: job.id,
          error: msg,
          attempts,
          nextAttemptAt: clock(),
          now: clock(),
          dead: true,
        });
        emit({
          status: disconnected ? 'DISCONNECTED' : 'ERROR',
          pending: await pendingCount(),
          lastError: msg,
        });
      } else {
        const backoff = computeBackoffMs({ attempts, rng });
        const next = new Date(clock().getTime() + backoff);
        // For journal batches, put the events back so a future job (or the
        // same one) can retry them. We leave them SYNCING because this same
        // job row is still alive and will retry after its next_attempt_at.
        await markFailure({
          id: job.id,
          error: msg,
          attempts,
          nextAttemptAt: next,
          now: clock(),
          dead: false,
        });
        emit({
          status: disconnected ? 'DISCONNECTED' : 'ERROR',
          pending: await pendingCount(),
          lastError: msg,
        });
      }
    }
  };

  const tickOnce = async (): Promise<void> => {
    if (stopped) return;
    if (!isOnline()) {
      emit({
        status: 'OFFLINE',
        pending: await pendingCount(),
      });
      return;
    }

    // Promote LOCAL_ONLY → QUEUED. Every domain service (Invoice, Payment,
    // Advance, Purchase, Return, ...) writes new sync_events with
    // sync_status='LOCAL_ONLY' inside a Dexie transaction; no service marks
    // them QUEUED itself so the batching stage below has something to pick
    // up. Without this promotion, freshly-CRUD'd data would live only in
    // IndexedDB — the user-visible symptom is empty `current/` /
    // `journal/` folders under the local backup root despite active work.
    await db.sync_events
      .where('sync_status')
      .equals('LOCAL_ONLY')
      .modify({ sync_status: 'QUEUED' });

    // Batching: coalesce whenever we've accumulated a full batch or the
    // window has elapsed. §12.
    const now = clock().getTime();
    const anyQueued = await db.sync_events
      .where('sync_status')
      .equals('QUEUED')
      .limit(1)
      .count();
    if (
      anyQueued > 0 &&
      (now - lastBatchAt >= batchWindowMs ||
        (await db.sync_events
          .where('sync_status')
          .equals('QUEUED')
          .count()) >= maxBatch)
    ) {
      await flushBatch();
    }

    emit({ status: 'SYNCING', pending: await pendingCount() });
    const due = await listDue({ now: clock(), limit: 25 });
    if (due.length === 0) {
      emit({ status: 'HEALTHY', pending: await pendingCount() });
      return;
    }
    log.debug('sync', 'draining jobs', { count: due.length });
    for (const job of due) {
      if (stopped) return;
      await runJob(job);
    }
  };

  const loop = (): void => {
    if (stopped) return;
    void tickOnce().finally(() => {
      if (stopped) return;
      const nextIn = isOnline() ? tickMs : offlineMs;
      timer = setTimeout(loop, nextIn);
    });
  };

  // Poke handler: fires an immediate tick regardless of the scheduled timer.
  // Also collapses the batch window so a fresh event flushes on this tick
  // instead of waiting another 5s.
  const onPoke = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    lastBatchAt = 0; // force flushBatch condition to be true on next tickOnce
    timer = setTimeout(loop, 0);
  };
  addPokeListener(onPoke);

  if (deps.autoStart !== false) {
    timer = setTimeout(loop, 0);
  }

  return {
    stop: (): void => {
      stopped = true;
      removePokeListener(onPoke);
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick: tickOnce,
    flushBatch,
    getHealth: (): BackupHealth => currentHealth,
  };
}
