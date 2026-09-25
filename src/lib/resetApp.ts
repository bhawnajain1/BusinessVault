import { db } from '../db';
import { metaDb } from './device';
import { stopSyncWorkerAsync } from '../sync/bootProvider';
import { resetTokenDb } from '../drive/tokenStore';
import { log } from './log';

const DATABASES = [
  'businessvault_meta',
  'businessvault_drive_tokens',
  'businessvault-local-folder',
  // Delete the customer data database last so a blocked ancillary database
  // leaves the primary business data intact.
  'businessvault',
] as const;

const LOCAL_PREFERENCE_KEYS = [
  'bv.lowStockAlertsEnabled',
  'bv.lowStockSoundEnabled',
  'bv-theme',
] as const;

function deleteDatabase(name: string): Promise<void> {
  log.info('reset', 'database deletion requested', { database: name });
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      log.info('reset', 'database deleted', { database: name });
      resolve();
    };
    request.onerror = () => {
      const error = request.error ?? new Error(`Could not delete ${name}`);
      log.error('reset', 'database deletion failed', { database: name, error });
      reject(error);
    };
    request.onblocked = () => {
      const error = new Error(`Could not delete ${name}: another tab or connection is still open`);
      log.error('reset', 'database deletion blocked', { database: name, error });
      reject(error);
    };
  });
}

export async function resetAppToFreshState(): Promise<void> {
  log.warn('reset', 'start fresh requested');
  await stopSyncWorkerAsync();
  log.info('reset', 'sync worker stopped and drained');
  db.close();
  metaDb().close();
  resetTokenDb();
  log.info('reset', 'application database handles closed');

  try {
    for (const database of DATABASES) await deleteDatabase(database);
  } catch (error) {
    log.error('reset', 'start fresh aborted before preference cleanup', { error });
    throw error;
  }

  for (const key of LOCAL_PREFERENCE_KEYS) localStorage.removeItem(key);
  sessionStorage.clear();
  log.info('reset', 'start fresh completed');
}
