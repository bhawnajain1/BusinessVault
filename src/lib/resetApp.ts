import { db } from '../db';
import { metaDb } from './device';
import { stopSyncWorker } from '../sync/bootProvider';
import { resetTokenDb } from '../drive/tokenStore';

const DATABASES = [
  'businessvault',
  'businessvault_meta',
  'businessvault_drive_tokens',
  'businessvault-local-folder',
] as const;

const LOCAL_PREFERENCE_KEYS = [
  'bv.lowStockAlertsEnabled',
  'bv.lowStockSoundEnabled',
  'bv-theme',
] as const;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}`));
    request.onblocked = () => resolve();
  });
}

export async function resetAppToFreshState(): Promise<void> {
  stopSyncWorker();
  db.close();
  metaDb().close();
  resetTokenDb();

  for (const key of LOCAL_PREFERENCE_KEYS) {
    localStorage.removeItem(key);
  }
  sessionStorage.clear();

  await Promise.all(DATABASES.map(deleteDatabase));
}
