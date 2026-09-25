// SECURITY: OAuth tokens live ONLY in this private IndexedDB store. They must
// NEVER be written to any user-visible file (CSV, JSON snapshot, manifest,
// journal, README, or any Drive upload). Callers writing to Drive/CSV MUST
// pass their payloads through `assertNoTokenLeak` before persistence.

import Dexie, { type Table } from 'dexie';

// TokenSet mirrors what the GIS token client returns (accessToken + expiresAt
// wall-clock in ms). Under GIS there is no refresh token; the field is kept
// optional for callers that still pass one through.
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  idToken?: string;
  scope?: string;
}

export interface DriveTokenRecord {
  businessId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  idToken?: string;
  scope?: string;
  email?: string;
  googleSub?: string;
  updatedAt: number;
}

class DriveTokenDB extends Dexie {
  drive_tokens!: Table<DriveTokenRecord, string>;

  constructor(name: string = 'businessvault_drive_tokens') {
    super(name);
    this.version(1).stores({
      drive_tokens: '&businessId, googleSub, updatedAt',
    });
  }
}

let _db: DriveTokenDB | null = null;

export function getTokenDb(): DriveTokenDB {
  if (!_db) _db = new DriveTokenDB();
  return _db;
}

export function setTokenDb(db: DriveTokenDB): void {
  _db = db;
}

export function resetTokenDb(): void {
  if (_db) {
    _db.close();
  }
  _db = null;
}

export async function saveTokens(
  businessId: string,
  tokens: TokenSet,
  identity?: { email?: string; sub?: string },
): Promise<void> {
  if (!businessId) throw new Error('saveTokens: businessId required');
  const db = getTokenDb();
  const existing = await db.drive_tokens.get(businessId);
  const record: DriveTokenRecord = {
    businessId,
    accessToken: tokens.accessToken,
    // Preserve refresh token if Google didn't return a new one on refresh.
    refreshToken: tokens.refreshToken ?? existing?.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
    idToken: tokens.idToken ?? existing?.idToken,
    scope: tokens.scope ?? existing?.scope,
    email: identity?.email ?? existing?.email,
    googleSub: identity?.sub ?? existing?.googleSub,
    updatedAt: Date.now(),
  };
  await db.drive_tokens.put(record);
}

export async function loadTokens(
  businessId: string,
): Promise<DriveTokenRecord | undefined> {
  return getTokenDb().drive_tokens.get(businessId);
}

export async function clearTokens(businessId: string): Promise<void> {
  await getTokenDb().drive_tokens.delete(businessId);
}

// Runtime guard used by CSV/snapshot/journal writers. Refuses to persist any
// object graph or string that carries an OAuth token key. Deliberately
// conservative — throwing here is safer than leaking to Drive.
const FORBIDDEN_KEYS: readonly string[] = [
  'refresh_token',
  'access_token',
  'refreshToken',
  'accessToken',
  'id_token',
  'idToken',
  'client_secret',
  'clientSecret',
];

const FORBIDDEN_STRING_MARKERS: readonly string[] = [
  'refresh_token',
  'access_token',
];

export function assertNoTokenLeak(payload: unknown, contextLabel: string): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      const lower = node.toLowerCase();
      for (const marker of FORBIDDEN_STRING_MARKERS) {
        if (lower.includes(marker)) {
          throw new Error(
            `Refusing to write OAuth tokens to ${contextLabel}: found "${marker}" in payload string`,
          );
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new Error(
          `Refusing to write OAuth tokens to ${contextLabel}: forbidden key "${key}"`,
        );
      }
      walk(value);
    }
  };
  walk(payload);
}
