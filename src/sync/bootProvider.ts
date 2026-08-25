import { db } from '../db';
import { getActiveProvider, setActiveProvider } from './providerRegistry';
import { startSyncWorker, type StopHandle, type BackupHealth } from './syncWorker';
import {
  LocalFolderStorageProvider,
  peekSavedHandle,
  queryHandlePermission,
} from '../storage/LocalFolderStorageProvider';
import type { CustomerStorageProvider } from '../storage/CustomerStorageProvider';
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

type BootKind = 'local-folder' | 'google-drive';

interface BootState {
  status: BootStatus;
  error: string | null;
  health: BackupHealth | null;
  kind: BootKind | null;
}

type Listener = (s: BootState) => void;

let state: BootState = { status: 'idle', error: null, health: null, kind: null };
let activeBusinessIdBound: string | null = null;
const listeners = new Set<Listener>();
let workerHandle: StopHandle | null = null;

function emit(patch: Partial<BootState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

// Always route worker creation through this. Without it, two sites in this
// file assign `workerHandle = startSyncWorker(...)` without first stopping
// the previous worker — most notably tryBootDrive (slow silent refresh) and
// bootWithHandle. A user-initiated Reconnect can race the boot flow and
// leave both workers polling the same sync_queue: the same jobId gets
// started twice within a few ms, each worker takes its own backoff path,
// and the sync_events state machine sees interleaved SYNCING→SYNCED
// transitions. This helper enforces the stop-old-start-new invariant in
// one place.
function installWorker(handle: StopHandle): void {
  if (workerHandle) {
    log.info('boot', 'stopping previous worker before starting new one', {
      wasBound: activeBusinessIdBound,
    });
    workerHandle.stop();
  }
  workerHandle = handle;
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

function pickKind(business: Business): BootKind {
  return business.drive_folder_id ? 'google-drive' : 'local-folder';
}

/** Silent probe on app load. Routes to the right backend based on how the
 *  business was onboarded (drive_folder_id present ⇒ google-drive, else
 *  local-folder). Never opens a picker or Google consent popup — those need
 *  a user gesture, so on any credential gap we emit `needs-permission` /
 *  `no-folder` and let the banner offer Reconnect. */
export async function tryBootProvider(): Promise<boolean> {
  if (workerHandle) return true;
  const business = await getActiveBusiness();
  if (!business) {
    emit({ status: 'idle', error: null, kind: null });
    return true;
  }
  const kind = pickKind(business);
  log.info('boot', 'trying provider', { business: business.name, kind });
  return kind === 'google-drive'
    ? tryBootDrive(business)
    : tryBootLocalFolder(business);
}

async function tryBootLocalFolder(business: Business): Promise<boolean> {
  const saved = await peekSavedHandle();
  if (!saved) {
    log.info('boot', 'no saved folder handle — awaiting user reconnect');
    emit({ status: 'no-folder', error: null, kind: 'local-folder' });
    return false;
  }

  const perm = await queryHandlePermission(saved);
  if (perm !== 'granted') {
    log.info('boot', 'saved handle needs permission grant', { perm });
    emit({ status: 'needs-permission', error: null, kind: 'local-folder' });
    return false;
  }

  return await bootWithHandle(saved, business);
}

async function tryBootDrive(business: Business): Promise<boolean> {
  // Cheap "have we ever connected?" gate. If tokens are stale but present,
  // the DriveApiClient's silent refresh handles it inside connect() below;
  // if refresh fails we surface needs-permission for the banner.
  const { isDriveConnected } = await import('../drive/connectDrive');
  const connected = await isDriveConnected(business.id).catch(() => false);
  if (!connected) {
    log.info('boot', 'drive not connected — awaiting user reconnect', {
      business: business.id,
    });
    emit({ status: 'needs-permission', error: null, kind: 'google-drive' });
    return false;
  }

  emit({ status: 'starting', error: null, kind: 'google-drive' });
  try {
    const { buildDriveProvider } = await import('../ui/onboarding/driveGlue');
    const provider = await buildDriveProvider(business.id);
    await provider.initializeBusiness({
      businessId: business.id,
      businessName: business.name,
    });
    activeBusinessIdBound = business.id;
    setActiveProvider(provider);
    installWorker(startSyncWorker({
      provider,
      onStateChange: (h) => emit({ health: h }),
    }));
    log.info('boot', 'drive sync worker started', { business: business.name });
    emit({ status: 'running', error: null, kind: 'google-drive' });
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error('boot', 'drive boot failed', { error: msg });
    const { DriveNeedsReconnectError } = await import(
      '../drive/GoogleDriveStorageProvider'
    );
    const needsAuth = err instanceof DriveNeedsReconnectError;
    emit({
      status: needsAuth ? 'needs-permission' : 'error',
      error: needsAuth ? null : msg,
      kind: 'google-drive',
    });
    return false;
  }
}

/** Called from a Reconnect banner click. Runs inside a user gesture so
 *  showDirectoryPicker (no saved handle) or requestPermission (saved handle,
 *  permission expired) can succeed. For Drive-backed businesses this opens
 *  the GIS popup instead. */
export async function reconnectWithUserGesture(): Promise<boolean> {
  // If a worker is already running but the user is clicking Reconnect, it's
  // because sync is failing (e.g. businessId mismatch after creating a new
  // business, or a stale handle mid-session). Clear the provider + binding
  // so the reconnect flow starts from a clean slate — installWorker below
  // will stop the old worker atomically when the new one is created.
  if (workerHandle) {
    setActiveProvider(null);
    activeBusinessIdBound = null;
  }
  const business = await getActiveBusiness();
  if (!business) {
    emit({ status: 'idle', error: null, kind: null });
    return true;
  }
  const kind = pickKind(business);
  emit({ status: 'starting', error: null, kind });

  if (kind === 'google-drive') {
    try {
      const { connectDrive } = await import('../drive/connectDrive');
      // Popup — needs the user gesture we're already inside of. `consent`
      // re-prompts so a revoked token / expired session doesn't silently
      // fall through to the "not connected" branch.
      await connectDrive({ businessId: business.id, prompt: 'consent' });
      const { buildDriveProvider } = await import('../ui/onboarding/driveGlue');
      const provider = await buildDriveProvider(business.id);
      await provider.initializeBusiness({
        businessId: business.id,
        businessName: business.name,
      });
      activeBusinessIdBound = business.id;
      setActiveProvider(provider);
      installWorker(startSyncWorker({
        provider,
        onStateChange: (h) => emit({ health: h }),
      }));
      emit({ status: 'running', error: null, kind: 'google-drive' });
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      log.error('boot', 'drive reconnect failed', { error: msg });
      // GIS popup dismissed / user cancelled → stay actionable, don't red-flag.
      const cancelled =
        msg.includes('popup_closed_by_user') ||
        msg.includes('access_denied') ||
        msg.toLowerCase().includes('cancelled by user');
      emit({
        status: cancelled ? 'needs-permission' : 'error',
        error: cancelled ? null : msg,
        kind: 'google-drive',
      });
      return false;
    }
  }

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
    activeBusinessIdBound = business.id;
    setActiveProvider(provider);
    installWorker(startSyncWorker({
      provider,
      onStateChange: (h) => emit({ health: h }),
    }));
    emit({ status: 'running', error: null, kind: 'local-folder' });
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.toLowerCase().includes('abort')) {
      // User cancelled the picker — revert to whatever state we were in
      // before so the banner remains actionable.
      emit({ status: 'no-folder', error: null, kind: 'local-folder' });
    } else {
      emit({ status: 'error', error: msg, kind: 'local-folder' });
    }
    return false;
  }
}

async function bootWithHandle(
  handle: FileSystemDirectoryHandle,
  business: Business,
): Promise<boolean> {
  emit({ status: 'starting', error: null, kind: 'local-folder' });
  const provider = new LocalFolderStorageProvider();
  provider.setDirectoryHandle(handle);
  try {
    await provider.connect({ kind: 'local-folder', rootPath: '' });
    await provider.initializeBusiness({
      businessId: business.id,
      businessName: business.name,
    });
    activeBusinessIdBound = business.id;
    setActiveProvider(provider);
    installWorker(startSyncWorker({
      provider,
      onStateChange: (h) => emit({ health: h }),
    }));
    log.info('boot', 'sync worker started', { business: business.name });
    emit({ status: 'running', error: null, kind: 'local-folder' });
    return true;
  } catch (err) {
    log.error('boot', 'bootWithHandle failed', { error: err });
    emit({
      status: 'error',
      error: (err as Error).message ?? String(err),
      kind: 'local-folder',
    });
    return false;
  }
}

/** Register an already-connected provider (used by Onboarding, which connects
 *  the provider itself inside the user click). If a worker is already running
 *  bound to a different business, stop it first so the new provider takes
 *  over. Without this, creating a second business on the same device leaves
 *  the worker flushing new events against the previous business's folder
 *  handle and every job fails with `businessId mismatch`.
 *
 *  `boundBusinessId` is passed explicitly so this works for both LocalFolder
 *  (which stores it internally via setBusiness) and Drive (which doesn't
 *  expose the same accessor). */
export function adoptConnectedProvider(
  provider: CustomerStorageProvider,
  boundBusinessId: string,
): void {
  if (workerHandle && activeBusinessIdBound === boundBusinessId) return;
  activeBusinessIdBound = boundBusinessId;
  const kind: BootKind = provider instanceof LocalFolderStorageProvider
    ? 'local-folder'
    : 'google-drive';
  setActiveProvider(provider);
  installWorker(startSyncWorker({
    provider,
    onStateChange: (h) => emit({ health: h }),
  }));
  log.info('boot', 'sync worker started via adopt', { business: boundBusinessId, kind });
  emit({ status: 'running', error: null, kind });
}

export function stopSyncWorker(): void {
  if (workerHandle) {
    workerHandle.stop();
    workerHandle = null;
  }
  activeBusinessIdBound = null;
  setActiveProvider(null);
  emit({ status: 'idle', error: null, kind: null });
}

export function isRunning(): boolean {
  return workerHandle !== null && getActiveProvider() !== null;
}
