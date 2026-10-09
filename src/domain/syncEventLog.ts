import Dexie from 'dexie';
import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import {
  GENESIS_HASH,
  canonicalJson,
  sha256Hex,
  type SyncEvent,
  type SyncOperation,
} from '../journal/event';

export interface AppendEventInput {
  businessId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  timestamp?: string;
  idempotencyKey?: string;
  entityVersion?: number;
}

/**
 * Appends one immutable sync-journal event, hash-chained to the previous tail.
 * Must be called inside a Dexie `rw` transaction that already includes
 * `db.sync_events` so the state mutation and its event commit atomically.
 *
 * The operational Dexie schema (src/db/schema.ts) uses snake_case column names
 * as index keys — we translate from the camelCase SyncEvent type at the write
 * boundary here so index paths resolve correctly.
 */
export async function appendSyncEvent(
  db: BusinessVaultDB,
  input: AppendEventInput,
): Promise<SyncEvent> {
  if (input.idempotencyKey) {
    const dup = await findByIdempotencyKey(
      db,
      input.businessId,
      input.idempotencyKey,
    );
    if (dup) return dup;
  }

  const timestamp = input.timestamp ?? new Date().toISOString();
  const entityVersion = input.entityVersion ?? await nextEntityVersion(
    db,
    input.businessId,
    input.entityType,
    input.entityId,
  );
  const previousHash = await tailPayloadHash(db, input.businessId);
  // sha256Hex → Web Crypto returns a native Promise that Dexie's transaction
  // zone does not track. Wrap it with Dexie.waitFor so the tx stays open.
  const payloadHash = await Dexie.waitFor(sha256Hex(canonicalJson(input.payload)));

  const evt: SyncEvent = {
    eventId: ulid(),
    businessId: input.businessId,
    deviceId: input.deviceId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    entityVersion,
    timestamp,
    payload: input.payload,
    payloadHash,
    previousHash,
    syncStatus: 'LOCAL_ONLY',
  };
  if (input.idempotencyKey) evt.idempotencyKey = input.idempotencyKey;

  const row = {
    event_id: evt.eventId,
    business_id: evt.businessId,
    device_id: evt.deviceId,
    entity_type: evt.entityType,
    entity_id: evt.entityId,
    operation: evt.operation,
    entity_version: evt.entityVersion,
    timestamp: evt.timestamp,
    payload: evt.payload,
    payload_hash: evt.payloadHash,
    previous_hash: evt.previousHash,
    sync_status: evt.syncStatus,
    sync_attempts: 0,
    last_error: null,
    synced_at: null,
    journal_file: null,
    idempotency_key: evt.idempotencyKey ?? null,
  };
  await db.sync_events.add(row as unknown as import('../db/types').SyncEvent);
  return evt;
}

async function findByIdempotencyKey(
  db: BusinessVaultDB,
  businessId: string,
  key: string,
): Promise<SyncEvent | undefined> {
  const rows = (await db.sync_events.toArray()) as unknown as Array<
    Record<string, unknown>
  >;
  for (const r of rows) {
    if (
      r['business_id'] === businessId &&
      r['idempotency_key'] === key
    ) {
      return rowToEvent(r);
    }
  }
  return undefined;
}

async function nextEntityVersion(
  db: BusinessVaultDB,
  businessId: string,
  entityType: string,
  entityId: string,
): Promise<number> {
  const rows = (await db.sync_events
    .where('[business_id+entity_type+entity_id]')
    .equals([businessId, entityType, entityId])
    .toArray()) as unknown as Array<Record<string, unknown>>;
  let max = 0;
  for (const r of rows) {
    const v = Number(r['entity_version'] ?? 0);
    if (v > max) max = v;
  }
  return max + 1;
}

export async function tailPayloadHash(
  db: BusinessVaultDB,
  businessId: string,
): Promise<string> {
  // Order by (timestamp, event_id) — event_id is a ULID, monotonic within a
  // single millisecond. Sorting on timestamp alone is under-specified when a
  // seed batch shares one `now` for many events (defaults.ts, coa.ts): Dexie
  // gives no stable tie-order, so the hash chain diverges across replays.
  const rows = (await db.sync_events
    .where('[business_id+timestamp]')
    .between([businessId, ''], [businessId, '￿'])
    .toArray()) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return GENESIS_HASH;
  rows.sort((a, b) => {
    const ta = String(a['timestamp']);
    const tb = String(b['timestamp']);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a['event_id']) < String(b['event_id']) ? -1 : 1;
  });
  return String(rows[rows.length - 1]['payload_hash'] ?? GENESIS_HASH);
}

function rowToEvent(r: Record<string, unknown>): SyncEvent {
  return {
    eventId: String(r['event_id']),
    businessId: String(r['business_id']),
    deviceId: String(r['device_id']),
    entityType: String(r['entity_type']),
    entityId: String(r['entity_id']),
    operation: r['operation'] as SyncOperation,
    entityVersion: Number(r['entity_version']),
    timestamp: String(r['timestamp']),
    payload: r['payload'],
    payloadHash: String(r['payload_hash']),
    previousHash: String(r['previous_hash']),
    syncStatus: r['sync_status'] as SyncEvent['syncStatus'],
    ...(r['idempotency_key']
      ? { idempotencyKey: String(r['idempotency_key']) }
      : {}),
  };
}
