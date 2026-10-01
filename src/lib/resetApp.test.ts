import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('../sync/bootProvider', () => ({
  stopSyncWorkerAsync: vi.fn(async () => undefined),
  suppressProviderBoot: vi.fn(),
}));
vi.mock('../drive/connectDrive', () => ({ disconnectAllDrives: vi.fn(async () => undefined) }));
vi.mock('../drive/tokenStore', () => ({ resetTokenDb: vi.fn() }));

import { resetAppToFreshState } from './resetApp';
import { stopSyncWorkerAsync } from '../sync/bootProvider';
import { resetTokenDb } from '../drive/tokenStore';

describe('resetAppToFreshState safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('bv-theme', 'dark');
    sessionStorage.setItem('test', 'value');
  });

  it('drains workers and deletes ancillary databases before the primary database', async () => {
    const deleted: string[] = [];
    const original = globalThis.indexedDB;
    globalThis.indexedDB = {
      deleteDatabase(name: string) {
        deleted.push(name);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.(new Event('success')));
        return request;
      },
    } as IDBFactory;

    try {
      await resetAppToFreshState();
      expect(stopSyncWorkerAsync).toHaveBeenCalledTimes(1);
      expect(resetTokenDb).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual([
        'businessvault_meta',
        'businessvault_drive_tokens',
        'businessvault-local-folder',
        'businessvault',
      ]);
      expect(localStorage.getItem('bv-theme')).toBeNull();
      expect(sessionStorage.getItem('test')).toBeNull();
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it('does not clear preferences when an ancillary database deletion is blocked', async () => {
    const original = globalThis.indexedDB;
    globalThis.indexedDB = {
      deleteDatabase(name: string) {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          if (name === 'businessvault_drive_tokens') request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
          else request.onsuccess?.(new Event('success'));
        });
        return request;
      },
    } as IDBFactory;

    try {
      await expect(resetAppToFreshState()).rejects.toThrow(/still open/);
      expect(stopSyncWorkerAsync).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('bv-theme')).toBe('dark');
      expect(sessionStorage.getItem('test')).toBe('value');
    } finally {
      globalThis.indexedDB = original;
    }
  });
});
