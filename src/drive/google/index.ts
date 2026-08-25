// GIS-backed DriveApiClient implementation.
//
// Uses Google Drive REST v3. Access token comes from GIS (initTokenClient)
// and lives in the private drive_tokens IndexedDB. On 401, we perform a
// single silent refresh via connectDrive.silentRefreshDrive; if THAT fails,
// we surface DriveNeedsReconnectError so the UI can route the user to a
// Reconnect button.
//
// Scope: drive.file only (per-file access; app-created files only).
// We deliberately avoid the "spaces=appDataFolder" mode so the user can see
// and manage the BusinessVault folder in their normal Drive UI.
//
// Logging: every non-trivial branch logs via src/lib/log so support can pull
// a JSONL export from Settings when a user reports an issue.

import { log } from '../../lib/log';
import {
  DriveNeedsReconnectError,
  type DriveApiClient,
  type DriveChangesPage,
  type DriveFileRef,
  type DriveUserInfo,
} from '../GoogleDriveStorageProvider';
import { loadTokens, saveTokens } from '../tokenStore';
import { silentRefreshDrive } from '../connectDrive';

// Re-export so callers can import from one place.
export { DriveNeedsReconnectError };

const DRIVE_V3 = 'https://www.googleapis.com/drive/v3';
const UPLOAD_V3 = 'https://www.googleapis.com/upload/drive/v3';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const MIME_FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS =
  'id,name,mimeType,parents,size,md5Checksum,modifiedTime,createdTime,version,trashed';

export interface CreateDriveApiClientOpts {
  businessId: string;
}

// Called by driveGlue (and RestoreWizard) to obtain a concrete Drive API
// client bound to a specific businessId (which keys the token record).
export function createDriveApiClient(opts: CreateDriveApiClientOpts): DriveApiClient {
  return new GisDriveClient(opts.businessId);
}

class GisDriveClient implements DriveApiClient {
  private cachedToken: { accessToken: string; expiresAt: number } | null = null;

  constructor(private readonly businessId: string) {}

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  async hasValidTokens(): Promise<boolean> {
    const rec = await loadTokens(this.businessId);
    if (!rec?.accessToken) {
      log.debug('drive.client', 'no stored token', { businessId: this.businessId });
      return false;
    }
    if (this.isExpired(rec.expiresAt)) {
      log.debug('drive.client', 'stored token expired — attempting silent refresh', {
        businessId: this.businessId,
      });
      try {
        const fresh = await silentRefreshDrive(this.businessId);
        this.cachedToken = { accessToken: fresh, expiresAt: 0 };
        return true;
      } catch (err) {
        log.warn('drive.client', 'silent refresh failed', { error: err });
        return false;
      }
    }
    this.cachedToken = { accessToken: rec.accessToken, expiresAt: rec.expiresAt };
    return true;
  }

  async refreshIfNeeded(): Promise<void> {
    const rec = await loadTokens(this.businessId);
    if (!rec) throw new DriveNeedsReconnectError();
    if (this.isExpired(rec.expiresAt)) {
      const fresh = await silentRefreshDrive(this.businessId).catch((err) => {
        log.warn('drive.client', 'refreshIfNeeded silent refresh failed', { error: err });
        throw new DriveNeedsReconnectError();
      });
      this.cachedToken = { accessToken: fresh, expiresAt: 0 };
    } else {
      this.cachedToken = { accessToken: rec.accessToken, expiresAt: rec.expiresAt };
    }
  }

  async getUserInfo(): Promise<DriveUserInfo> {
    const res = await this.fetch(USERINFO, { method: 'GET' });
    const body = (await res.json()) as { email?: string; name?: string };
    if (!body.email) throw new Error('userinfo missing email');
    return { emailAddress: body.email, displayName: body.name };
  }

  private isExpired(expiresAt: number, skewMs: number = 60_000): boolean {
    return Date.now() + skewMs >= expiresAt;
  }

  private async currentToken(): Promise<string> {
    if (this.cachedToken && !this.isExpired(this.cachedToken.expiresAt)) {
      return this.cachedToken.accessToken;
    }
    const rec = await loadTokens(this.businessId);
    if (!rec?.accessToken) throw new DriveNeedsReconnectError();
    if (this.isExpired(rec.expiresAt)) {
      const fresh = await silentRefreshDrive(this.businessId).catch(() => {
        throw new DriveNeedsReconnectError();
      });
      this.cachedToken = { accessToken: fresh, expiresAt: Date.now() + 3_600_000 };
      return fresh;
    }
    this.cachedToken = { accessToken: rec.accessToken, expiresAt: rec.expiresAt };
    return rec.accessToken;
  }

  // Internal fetch wrapper — retries once on 401 after silent refresh.
  private async fetch(url: string, init: RequestInit, isRetry = false): Promise<Response> {
    const token = await this.currentToken();
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && !isRetry) {
      log.info('drive.client', '401 — silent-refresh + retry', {
        url,
        method: init.method,
      });
      try {
        const fresh = await silentRefreshDrive(this.businessId);
        this.cachedToken = { accessToken: fresh, expiresAt: Date.now() + 3_600_000 };
      } catch {
        throw new DriveNeedsReconnectError();
      }
      return this.fetch(url, init, true);
    }
    if (res.status === 403) {
      // 403 in drive.file scope usually means permission_revoked or
      // insufficient scope. Surface as needs-reconnect so UI prompts consent.
      const text = await res.clone().text().catch(() => '');
      log.warn('drive.client', '403 from Drive', { url, body: text });
      if (/permission|scope|revoked/i.test(text)) {
        throw new DriveNeedsReconnectError(`Drive permission_revoked: ${text}`);
      }
    }
    if (!res.ok) {
      const text = await res.clone().text().catch(() => '');
      const err = new Error(
        `Drive ${init.method ?? 'GET'} ${url} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      ) as Error & { status?: number; body?: string };
      // Attach the HTTP status so callers can react to 404 (stale-id) without
      // parsing the message. Body kept short for log noise.
      err.status = res.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // Folder / file operations (Drive REST v3)
  // -------------------------------------------------------------------------

  async rootFolderId(): Promise<string> {
    // drive.file scope can't touch the true Drive root, but the special id
    // "root" resolves to it for CREATION purposes (parented children ARE
    // visible in the user's My Drive). We never LIST the root — we always
    // find the "BusinessVault" folder by name via a scoped q= query.
    return 'root';
  }

  async findChildByName(parentId: string, name: string): Promise<DriveFileRef | null> {
    const q = [
      `'${escapeQ(parentId)}' in parents`,
      `name = '${escapeQ(name)}'`,
      `trashed = false`,
    ].join(' and ');
    const url = `${DRIVE_V3}/files?q=${encodeURIComponent(q)}&fields=files(${FILE_FIELDS})&spaces=drive&pageSize=10`;
    const res = await this.fetch(url, { method: 'GET' });
    const body = (await res.json()) as { files?: DriveFileRef[] };
    const first = body.files?.[0] ?? null;
    return first;
  }

  async ensureFolder(parentId: string, name: string): Promise<DriveFileRef> {
    const existing = await this.findChildByName(parentId, name);
    if (existing && existing.mimeType === MIME_FOLDER) return existing;
    log.debug('drive.client', 'creating folder', { parentId, name });
    const res = await this.fetch(`${DRIVE_V3}/files?fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: MIME_FOLDER,
        parents: [parentId],
      }),
    });
    return (await res.json()) as DriveFileRef;
  }

  async listChildren(parentId: string): Promise<DriveFileRef[]> {
    const out: DriveFileRef[] = [];
    let pageToken: string | undefined;
    do {
      const q = `'${escapeQ(parentId)}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: '1000',
        spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.fetch(`${DRIVE_V3}/files?${params.toString()}`, { method: 'GET' });
      const body = (await res.json()) as { files?: DriveFileRef[]; nextPageToken?: string };
      if (body.files) out.push(...body.files);
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFile(input: {
    parentId: string;
    name: string;
    mimeType: string;
    body: Blob;
  }): Promise<DriveFileRef> {
    const metadata = {
      name: input.name,
      mimeType: input.mimeType,
      parents: [input.parentId],
    };
    // Multipart upload: one request, small-to-medium bodies. For large
    // attachments the caller could later switch to resumable uploads.
    const boundary = `bv-${Math.random().toString(36).slice(2)}${Date.now()}`;
    const bodyBytes = await blobToBytes(input.body);
    const preamble = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
    );
    const closing = new TextEncoder().encode(`\r\n--${boundary}--`);
    const combined = new Uint8Array(preamble.byteLength + bodyBytes.byteLength + closing.byteLength);
    combined.set(preamble, 0);
    combined.set(bodyBytes, preamble.byteLength);
    combined.set(closing, preamble.byteLength + bodyBytes.byteLength);

    const res = await this.fetch(
      `${UPLOAD_V3}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: combined as unknown as BodyInit,
      },
    );
    return (await res.json()) as DriveFileRef;
  }

  async updateFileContents(
    fileId: string,
    body: Blob,
    mimeType: string,
  ): Promise<DriveFileRef> {
    // Simple media upload — replaces the file content in-place.
    const bytes = await blobToBytes(body);
    const res = await this.fetch(
      `${UPLOAD_V3}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${FILE_FIELDS}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': mimeType },
        body: bytes as unknown as BodyInit,
      },
    );
    return (await res.json()) as DriveFileRef;
  }

  async getFileContents(fileId: string): Promise<Blob> {
    const res = await this.fetch(
      `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET' },
    );
    return await res.blob();
  }

  async getFileMetadata(fileId: string): Promise<DriveFileRef> {
    const res = await this.fetch(
      `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`,
      { method: 'GET' },
    );
    return (await res.json()) as DriveFileRef;
  }

  async moveFile(
    fileId: string,
    newParentId: string,
    oldParentId?: string,
  ): Promise<DriveFileRef> {
    const params = new URLSearchParams({
      addParents: newParentId,
      fields: FILE_FIELDS,
    });
    if (oldParentId) params.set('removeParents', oldParentId);
    const res = await this.fetch(
      `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    return (await res.json()) as DriveFileRef;
  }

  async deleteFile(fileId: string): Promise<void> {
    // Trash (soft delete) — drive.file scope can move to trash but callers may
    // prefer hard delete. Use hard delete since our cleanup paths (staging
    // rollback) actively don't want it sitting in the user's Trash.
    await this.fetch(`${DRIVE_V3}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
  }

  // -------------------------------------------------------------------------
  // Changes API — used by the provider to detect external edits
  // -------------------------------------------------------------------------

  async getStartPageToken(): Promise<string> {
    const res = await this.fetch(`${DRIVE_V3}/changes/startPageToken`, { method: 'GET' });
    const body = (await res.json()) as { startPageToken?: string };
    if (!body.startPageToken) throw new Error('startPageToken missing in response');
    return body.startPageToken;
  }

  async listChanges(pageToken: string): Promise<DriveChangesPage> {
    const params = new URLSearchParams({
      pageToken,
      fields: `nextPageToken, newStartPageToken, changes(fileId, removed, time, file(${FILE_FIELDS}))`,
      pageSize: '1000',
      spaces: 'drive',
      includeRemoved: 'true',
      restrictToMyDrive: 'true',
    });
    const res = await this.fetch(`${DRIVE_V3}/changes?${params.toString()}`, { method: 'GET' });
    const body = (await res.json()) as {
      changes?: Array<{
        fileId?: string;
        removed?: boolean;
        time?: string;
        file?: DriveFileRef;
      }>;
      nextPageToken?: string;
      newStartPageToken?: string;
    };
    return {
      changes: (body.changes ?? [])
        .filter((c): c is { fileId: string; removed?: boolean; time?: string; file?: DriveFileRef } => !!c.fileId)
        .map((c) => ({
          fileId: c.fileId,
          removed: !!c.removed,
          file: c.file,
          time: c.time,
          // The Drive Changes API doesn't tell us who made the change on the
          // drive.file scope. We default to true (foreign) unless the file
          // was written this session — the provider cache dedupes for us.
          foreign: true,
        })),
      nextPageToken: body.nextPageToken,
      newStartPageToken: body.newStartPageToken,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeQ(s: string): string {
  // Drive q= uses single-quoted string literals; escape ' and \ per docs.
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function blobToBytes(b: Blob): Promise<Uint8Array> {
  const anyBlob = b as unknown as {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof anyBlob.arrayBuffer === 'function') {
    return new Uint8Array(await anyBlob.arrayBuffer());
  }
  // Fallback for jsdom's minimal Blob polyfill.
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

// Suppress unused-import lint when the type is only re-exported. Prevents
// "saveTokens is imported but never used" warning; we keep the import in case
// future code wants to update the token record from Drive-side responses.
void saveTokens;
