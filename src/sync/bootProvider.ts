import { db } from '../db';
import { getActiveProvider, setActiveProvider } from './providerRegistry';
import { startSyncWorker, type StopHandle, type BackupHealth } from './syncWorker';
import {
  LocalFolderStorageProvider,
  peekSavedHandle,
  queryHandlePermission,
} from '../storage/LocalFolderStorageProvider';
import { currentBusinessId, NotOnboardedError } from '../lib/business';
import type { Business } from '../db/types';
import { log } from '../lib/log';

type BootStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'needs-permission'
  | 'no-folder'
  | 'error';

interface BootState {
  status: BootStatus;
  error: string | null;
  health: BackupHealth | null;
}

type Listener = (s: BootState) => void;

let state: BootState = { status: 'idle', error: null, health: null };
const listeners = new Set<Listener>();
let workerHandle: StopHandle | null = null;

function emit(patch: Partial<BootState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function subscribeBoot(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => {
    listeners.delete(l);
  };
}

export function getBootState(): BootState {
  return state;
}

async function getActiveBusiness(): Promise<Business | null> {
  try {
    const id = await currentBusinessId();
    return (await db.businesses.get(id)) ?? null;
  } catch (e) {
    if (e instanceof NotOnboardedError) return null;
    throw e;
  }
}

/** Silent probe on app load. Never opens a picker or calls requestPermission
 *  (both need a user gesture). Only actually starts the worker if a saved
 *  handle exists AND its permission is already 'granted'. Otherwise sets
 *  status to 'needs-permission' (saved handle but Chrome revoked read-write)
 *  or 'no-folder' (no saved handle at all — new install or user cleared it)
 *  so the banner shows a Reconnect / Choose Folder button. */
export async function tryBootLocalFolderProvider(): Promise<boolean> {
  if (workerHandle) return true;
  const business = await getActiveBusiness();
  if (!business) {
    emit({ status: 'idle', error: null });
    return true;
  }
  log.info('boot', 'trying local-folder provider', { business: business.name });

  const saved = await peekSavedHandle();
  if (!saved) {
    log.info('boot', 'no saved folder handle — awaiting user reconnect');
    emit({ status: 'no-folder', error: null });
    return false;
  }

  const perm = await queryHandlePermission(saved);
  if (perm !== 'granted') {
    log.info('boot', 'saved handle needs permission grant', { perm });
    emit({ status: 'needs-permission', error: null });
    return false;
  }

  return await bootWithHandle(saved, business);
}

/** Called from a Reconnect banner click. Runs inside a user gesture so
 *  showDirectoryPicker (no saved handle) or requestPermission (saved handle,
 *  permission expired) can succeed. */
export async function reconnectWithUserGesture(): Promise<boolean> {
  // If a worker is already running but the user is clicking Reconnect, it's
  // because sync is failing (e.g. businessId mismatch after creating a new
  // business, or a stale handle mid-session). Tear down the stale worker so
  // we can start fresh with a new provider bound to the active business.
  if (workerHandle) {
    log.info('boot', 'stopping stale worker before reconnect');
    workerHandle.stop();
    workerHandle = null;
    setActiveProvider(null);
  }
  const business = await getActiveBusiness();
  if (!business) {
    emit({ status: 'idle', error: null });
    return true;
  }
  emit({ status: 'starting', error: null });
  const provider = new LocalFolderStorageProvider();
  try {
    // connect() handles: (a) prompt via showDirectoryPicker if no saved
    // handle, or (b) requestPermission on the saved handle. Both require a
    // user gesture, which is why this function is only called from onClick.
    await provider.connect({ kind: 'local-folder', rootPath: '' });
    await provider.initializeBusiness({
      businessId: business.id,
      businessName: business.name,
    });
    setActiveProvider(provider);
    workerHandle = startSyncWorker({
      provider,
      onStateChange: (h) => emit({ health: h }),
    });
    emit({ status: 'running', error: null });
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.toLowerCase().includes('abort')) {
      // User cancelled the picker — revert to whatever state we were in
      // before so the banner remains actionable.
      emit({ status: 'no-folder', error: null });
    } else {
      emit({ status: 'error', error: msg });
    }
    return false;
  }
}

async function bootWithHandle(
  handle: FileSystemDirectoryHandle,
  business: Business,
): Promise<boolean> {
  emit({ status: 'starting', error: null });
  const provider = new LocalFolderStorageProvider();
  provider.setDirectoryHandle(handle);
  try {
    await provider.connect({ kind: 'local-folder', rootPath: '' });
    await provider.initializeBusiness({
      businessId: business.id,
      businessName: business.name,
    });
    setActiveProvider(provider);
    workerHandle = startSyncWorker({
      provider,
      onStateChange: (h) => emit({ health: h }),
    });
    log.info('boot', 'sync worker started', { business: business.name });
    emit({ status: 'running', error: null });
    return true;
  } catch (err) {
    log.error('boot', 'bootWithHandle failed', { error: err });
    emit({ status: 'error', error: (err as Error).message ?? String(err) });
    return false;
  }
}

/** Register an already-connected provider (used by Onboarding, which connects
 *  the provider itself inside the user click). If a worker is already running
 *  bound to a different business, stop it first so the new provider takes
 *  over. Without this, creating a second business on the same device leaves
 *  the worker flushing new events against the previous business's folder
 *  handle and every job fails with `businessId mismatch`. */
export function adoptConnectedProvider(provider: LocalFolderStorageProvider): void {
  const newBusinessId = provider.getBoundBusinessId();
  if (workerHandle) {
    const active = getActiveProvider() as LocalFolderStorageProvider | null;
    const currentBusinessId = active?.getBoundBusinessId?.() ?? null;
    if (currentBusinessId === newBusinessId) return;
    log.info('boot', 'stopping worker before adopting new business', {
      from: currentBusinessId,
      to: newBusinessId,
    });
    workerHandle.stop();
    workerHandle = null;
  }
  setActiveProvider(provider);
  workerHandle = startSyncWorker({
    provider,
    onStateChange: (h) => emit({ health: h }),
  });
  log.info('boot', 'sync worker started via adopt', { business: newBusinessId });
  emit({ status: 'running', error: null });
}

export function stopSyncWorker(): void {
  if (workerHandle) {
    workerHandle.stop();
    workerHandle = null;
  }
  setActiveProvider(null);
  emit({ status: 'idle', error: null });
}

export function isRunning(): boolean {
  return workerHandle !== null && getActiveProvider() !== null;
}
