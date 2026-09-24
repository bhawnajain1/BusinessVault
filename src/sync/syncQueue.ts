import { ulid } from 'ulid';
import { db } from '../db';
import type {
  SyncQueueJob,
  SyncJobKind,
  SyncJobStatus,
} from '../db/types';

// Spec §10 + §12: persistent, cross-restart retry queue for the sync worker.
// Kinds are the internal names for the three task-shapes named in the task
// prompt: 'event-batch' -> 'journal_flush', 'snapshot' -> 'snapshot',
// 'attachment' -> 'attachment_upload'. We keep the existing DB schema names
// so schema.ts stays untouched.

export type QueueKind = SyncJobKind;

export interface EnqueueInput {
  businessId: string;
  kind: QueueKind;
  payload: unknown;
  runAt?: string;
  maxAttempts?: number;
}

export interface DueQueryOptions {
  now: Date;
  limit?: number;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const DEAD_LETTER_SENTINEL: SyncJobStatus = 'failed';
const STALE_RUNNING_MS = 5 * 60_000;

const iso = (d: Date): string => d.toISOString();

export const isDead = (job: SyncQueueJob): boolean =>
  job.status === DEAD_LETTER_SENTINEL && job.attempts >= job.max_attempts;

export async function enqueue(
  input: EnqueueInput,
  now: Date = new Date(),
): Promise<SyncQueueJob> {
  const job: SyncQueueJob = {
    id: ulid(),
    business_id: input.businessId,
    kind: input.kind,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    next_attempt_at: input.runAt ?? iso(now),
    last_error: null,
    created_at: iso(now),
    updated_at: iso(now),
  };
  await db.sync_queue.add(job);
  return job;
}

export async function listDue(
  opts: DueQueryOptions,
): Promise<SyncQueueJob[]> {
  const nowIso = iso(opts.now);
  const limit = opts.limit ?? 25;
  const rows = await db.sync_queue
    .where('[status+next_attempt_at]')
    .between(['pending', ''], ['pending', nowIso], true, true)
    .limit(limit)
    .toArray();
  return rows;
}

/** Requeue jobs abandoned by a tab or worker that stopped mid-operation. */
export async function recoverStaleRunningJobs(
  now: Date = new Date(),
  staleMs: number = STALE_RUNNING_MS,
): Promise<number> {
  const cutoff = now.getTime() - staleMs;
  const stale = await db.sync_queue
    .where('status')
    .equals('running')
    .filter((job) => new Date(job.updated_at).getTime() <= cutoff)
    .toArray();
  if (stale.length === 0) return 0;
  await db.sync_queue.bulkPut(
    stale.map((job) => ({
      ...job,
      status: 'pending' as const,
      next_attempt_at: iso(now),
      updated_at: iso(now),
      last_error: job.last_error ?? 'Recovered stale running job after worker restart',
    })),
  );
  return stale.length;
}

export async function markInFlight(id: string, now: Date): Promise<void> {
  await db.sync_queue.update(id, {
    status: 'running',
    updated_at: iso(now),
  });
}

export async function markDone(id: string, now: Date): Promise<void> {
  await db.sync_queue.update(id, {
    status: 'done',
    updated_at: iso(now),
    last_error: null,
  });
}

export interface FailureUpdate {
  id: string;
  error: string;
  attempts: number;
  nextAttemptAt: Date;
  now: Date;
  dead: boolean;
}

export async function markFailure(u: FailureUpdate): Promise<void> {
  await db.sync_queue.update(u.id, {
    status: u.dead ? 'failed' : 'pending',
    attempts: u.attempts,
    last_error: u.error,
    next_attempt_at: iso(u.nextAttemptAt),
    updated_at: iso(u.now),
  });
}

export async function pendingCount(businessId?: string): Promise<number> {
  if (businessId) {
    return db.sync_queue
      .where('[business_id+status]')
      .equals([businessId, 'pending'])
      .count();
  }
  return db.sync_queue.where('status').equals('pending').count();
}

export async function deadCount(businessId?: string): Promise<number> {
  if (businessId) {
    return db.sync_queue
      .where('[business_id+status]')
      .equals([businessId, 'failed'])
      .count();
  }
  return db.sync_queue.where('status').equals('failed').count();
}

export async function purgeDone(olderThan: Date): Promise<number> {
  const cutoff = iso(olderThan);
  return db.sync_queue
    .where('status')
    .equals('done')
    .and((j) => j.updated_at < cutoff)
    .delete();
}

// Backoff: min(cap, base * 2^attempts) * (0.5 + rng()). Deterministic when
// rng() is injected — see syncWorker.test.ts.
export interface BackoffOptions {
  attempts: number; // 1 = first failure
  baseMs?: number;
  capMs?: number;
  rng?: () => number;
}

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 5 * 60_000;

export function computeBackoffMs(o: BackoffOptions): number {
  const base = o.baseMs ?? BACKOFF_BASE_MS;
  const cap = o.capMs ?? BACKOFF_CAP_MS;
  const rng = o.rng ?? Math.random;
  const raw = Math.min(cap, base * Math.pow(2, Math.max(0, o.attempts - 1)));
  const jittered = raw * (0.5 + rng());
  return Math.min(cap, Math.max(0, Math.floor(jittered)));
}
