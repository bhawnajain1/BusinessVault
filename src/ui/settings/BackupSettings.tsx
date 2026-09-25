import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  CloudBackup,
  Download,
  ExternalLink,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { db } from '../../db';
import { useBackupHealth } from '../BackupHealthContext';
import type { BackupHealthStatus } from '../../sync/syncWorker';
import { getActiveProvider } from '../../sync/providerRegistry';
import { enqueue } from '../../sync/syncQueue';
import { buildSnapshotInput } from '../../sync/buildSnapshotInput';
import { pokeSyncWorker } from '../../sync/syncWorker';
import {
  adoptConnectedProvider,
  getBootState,
  stopSyncWorker,
  subscribeBoot,
} from '../../sync/bootProvider';
import { connectDrive, disconnectDrive } from '../../drive/connectDrive';
import { buildDriveProvider } from '../onboarding/driveGlue';
import {
  LocalFolderStorageProvider,
  peekSavedHandle,
} from '../../storage/LocalFolderStorageProvider';
import { hasGoogleClientId } from '../../auth/gis';
import { log } from '../../lib/log';
import { beginAppOperation, updateAppOperation } from '../../lib/operationLock';
import type {
  ConnectionStatus,
  IntegrityReport,
} from '../../storage/CustomerStorageProvider';
import type { Business } from '../../db/types';
import DataExport from './DataExport';

// Spec §28 exact layout:
//
//   Google Drive
//   Connected as: <email>
//   Business folder: BusinessVault - <name>  [Open My Google Drive Folder]
//   Last event sync:  <relative time>
//   Last full backup: <relative time>
//   Pending:          <count>
//   Backup integrity: <Verified | Failed>
//   Status:           <HEALTHY | SYNCING | OFFLINE | DISCONNECTED | ERROR | CONFLICT | INTEGRITY_FAILURE>
//
// Buttons: Backup now / Verify integrity now / Export My Business /
// Disconnect Google Drive.
//
// The word "snapshot" is retained inside the sync/storage code (job kind,
// on-disk folder layout, protocol) because that's what the artifact IS —
// a point-in-time snapshot of the data. But the UI says "backup" so end
// users understand it as a backup operation.
//
// When DISCONNECTED shows persistent non-blocking warning + Reconnect (§30).

const DRIVE_FOLDER_URL = (id: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Never';
  const deltaSec = Math.floor((now.getTime() - t) / 1000);
  if (deltaSec < 0) return 'Just now';
  if (deltaSec < 45) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleString();
}

const STATUS_TONE: Record<BackupHealthStatus, string> = {
  HEALTHY: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  SYNCING: 'bg-blue-50 text-blue-700 ring-blue-200',
  OFFLINE: 'bg-slate-100 text-slate-700 ring-slate-300',
  DISCONNECTED: 'bg-amber-50 text-amber-800 ring-amber-300',
  ERROR: 'bg-rose-50 text-rose-700 ring-rose-300',
  CONFLICT: 'bg-amber-50 text-amber-800 ring-amber-300',
  INTEGRITY_FAILURE: 'bg-rose-100 text-rose-800 ring-rose-400',
};

// Pure derivation of the pill/banner status. Exported so the regression test
// can pin down the DISCONNECTED-banner bug without mounting a React tree.
//
// Precedence:
//   1. Live provider says DISCONNECTED → banner shows Reconnect. This wins
//      even over health.status because the provider knows the OAuth state
//      first-hand.
//   2. Integrity report says the on-disk snapshot is corrupt → INTEGRITY_FAILURE.
//   3. Otherwise, trust the polled health.status (HEALTHY / SYNCING / OFFLINE /
//      ERROR / CONFLICT) — the sync worker is the authority on job outcomes.
//
// Bug this replaces: when the effect that populated `conn` ran once at mount
// (during a page reload triggered by GIS reconnect), it captured a snapshot
// BEFORE the provider registry had the new provider, leaving `conn.state` =
// 'DISCONNECTED' forever. The banner then never cleared even after sync
// resumed. Fix: poll the provider every 2s (elsewhere in this file) so this
// derivation gets fresh input.
export function deriveDisplayStatus(
  conn: ConnectionStatus | null,
  healthStatus: BackupHealthStatus,
  integrity: IntegrityReport | null,
): BackupHealthStatus {
  if (conn?.state === 'DISCONNECTED') return 'DISCONNECTED';
  if (integrity && !integrity.ok) return 'INTEGRITY_FAILURE';
  return healthStatus;
}

export function shouldShowDisconnectedDuringBoot(
  bootStatus: ReturnType<typeof getBootState>['status'],
  hasProvider: boolean,
): boolean {
  if (hasProvider) return false;
  return bootStatus !== 'idle' && bootStatus !== 'starting';
}

export function shouldShowDriveFolderLink(
  status: BackupHealthStatus,
  driveFolderId: string | null,
): boolean {
  return driveFolderId !== null && status !== 'DISCONNECTED';
}

interface Props {
  businessId: string;
  onReconnect?: (selectedLocalHandle?: FileSystemDirectoryHandle) => void | Promise<void>;
  onResetFresh?: () => void | Promise<void>;
}

export default function BackupSettings({ businessId, onReconnect, onResetFresh }: Props) {
  const health = useBackupHealth();
  const [business, setBusiness] = useState<Business | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const connectionReadRef = useRef(0);
  const [bootStatus, setBootStatus] = useState(getBootState().status);
  const [manuallyDisconnected, setManuallyDisconnected] = useState(false);

  const readConnectionStatus = useCallback(async (): Promise<void> => {
    const readId = ++connectionReadRef.current;
    if (manuallyDisconnected) {
      setConn({ state: 'DISCONNECTED' });
      return;
    }
    const provider = getActiveProvider();
    if (!provider) {
      if (readId === connectionReadRef.current) {
        setConn(
          shouldShowDisconnectedDuringBoot(getBootState().status, false)
            ? { state: 'DISCONNECTED' }
            : null,
        );
      }
      return;
    }
    try {
      const next = await provider.connectionStatus();
      // Reconnect can replace the provider while an older status read is
      // still pending. Only the newest read may update the UI.
      if (readId === connectionReadRef.current) setConn(next);
    } catch (e) {
      if (readId === connectionReadRef.current) {
        setConn({ state: 'ERROR', error: (e as Error).message });
      }
    }
  }, [manuallyDisconnected]);

  // Re-read the business row + provider connection status every 2s. A one-shot
  // read at mount would leave the DISCONNECTED banner stuck if the user
  // reconnected Drive AFTER the effect ran — the provider registry swap in
  // adoptConnectedProvider() has no way to signal us. Polling matches the
  // BackupHealthContext pattern already used for `health` above.
  useEffect(() => {
    let cancelled = false;
    log.debug('BackupSettings', 'mount: starting connection poll', { businessId });
    const readOnce = async (): Promise<void> => {
      const b = await db.businesses.get(businessId);
      if (cancelled) return;
      setBusiness(b ?? null);
      await readConnectionStatus();
    };
    void readOnce();
    const id = setInterval(() => {
      void readOnce();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
      connectionReadRef.current += 1;
      log.debug('BackupSettings', 'unmount: stopping connection poll', { businessId });
    };
  }, [businessId, readConnectionStatus]);

  useEffect(() => {
    const unsubscribe = subscribeBoot((next) => {
      setBootStatus(next.status);
      void readConnectionStatus();
    });
    return unsubscribe;
  }, [readConnectionStatus]);

  const handleReconnect = useCallback(async (): Promise<void> => {
    if (!onReconnect) return;
    setManuallyDisconnected(false);
    await onReconnect();
    await readConnectionStatus();
  }, [onReconnect, readConnectionStatus]);

  const status: BackupHealthStatus = useMemo(() => {
    const booting = !conn && (bootStatus === 'idle' || bootStatus === 'starting');
    const healthStatus = booting && health.status === 'DISCONNECTED' ? 'HEALTHY' : health.status;
    return deriveDisplayStatus(conn, healthStatus, integrity);
  }, [bootStatus, conn, integrity, health.status]);
  const connected = status !== 'DISCONNECTED' && status !== 'ERROR';

  const lastLoggedStatusRef = useRef<BackupHealthStatus | null>(null);
  useEffect(() => {
    if (lastLoggedStatusRef.current !== status) {
      log.info('BackupSettings', 'displayed status changed', {
        businessId,
        previous: lastLoggedStatusRef.current,
        next: status,
        conn_state: conn?.state ?? null,
        health_status: health.status,
        integrity_ok: integrity?.ok ?? null,
      });
      lastLoggedStatusRef.current = status;
    }
  }, [businessId, conn, health.status, integrity, status]);

  const email = conn?.account ?? business?.drive_connected_email ?? '(not connected)';
  const folderName = business?.name ?? '';
  const folderPath = conn?.folderPath ?? `BusinessVault - ${folderName}`;
  const driveFolderId = business?.drive_folder_id ?? null;

  const integrityLabel = integrity == null
    ? '—'
    : integrity.ok
      ? 'Verified'
      : `Failed (${integrity.issues.length} issue${integrity.issues.length === 1 ? '' : 's'})`;

  const clearMessages = (): void => {
    setMessage(null);
    setError(null);
  };

  const runBackup = useCallback(async (): Promise<boolean> => {
    clearMessages();
    if (!getActiveProvider() && onReconnect) {
      setMessage('Reconnecting to Google Drive…');
      await onReconnect();
    }
    const provider = getActiveProvider();
    if (!provider) {
      setError('Google Drive is not connected — click Reconnect above, then try again.');
      return false;
    }
    setBusy('backup');
    setMessage('Preparing backup…');
    let releaseOperation: (() => void) | null = null;
    try {
      if (!business) {
        throw new Error('Business is still loading.');
      }
      // The user may have deleted the vault in Drive while this tab was open.
      // Re-run initialization so the provider rediscovers or recreates the
      // remote folder instead of using its stale cached folder id.
      const initialized = await provider.initializeBusiness({
        businessId,
        businessName: business.name,
      });
      if (business.drive_folder_id !== null && business.drive_folder_id !== initialized.providerFolderId) {
        await db.businesses.update(businessId, {
          drive_folder_id: initialized.providerFolderId,
          updated_at: new Date().toISOString(),
        });
        const refreshed = await db.businesses.get(businessId);
        if (refreshed) setBusiness(refreshed);
      }
       // On-demand snapshots need a unique path. A date-only value makes a
       // second manual backup on the same day look like an idempotent retry.
       const asOf = new Date().toISOString().replace(/:/g, '-');
      const input = await buildSnapshotInput(db, businessId, business.name, 'ondemand', asOf);
       const job = await enqueue({
        businessId,
        kind: 'snapshot',
        payload: { input },
      });
       pokeSyncWorker();
       const destination = business.drive_folder_id == null ? 'local backup folder' : 'Google Drive';
       setMessage(`Backup writing to ${destination}…`);
       updateAppOperation({ progress: 35, message: `Backup queued for ${destination}…` });
      // Poll the queued job until it lands. Backup jobs typically take
      // 60-120s wall-clock; a fire-and-forget toast used to leave the user
      // wondering whether it had failed. Poll every 750ms — cheap indexeddb
      // read — and terminate on done/failed/timeout.
       const startedAt = Date.now();
       const TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard ceiling
       while (true) {
        const row = await db.sync_queue.get(job.id);
        if (!row) {
          throw new Error('Backup job disappeared before successful completion. Nothing was cleared.');
        }
        if (row.status === 'done') {
           setMessage('Backup complete.');
          return true;
        }
        if (row.status === 'failed') {
           setError(`Backup failed: ${row.last_error ?? 'unknown error'}`);
          return false;
        }
        if (Date.now() - startedAt > TIMEOUT_MS) {
           setError('Backup is still running after 10 minutes. Check back later — it may finish in the background.');
          return false;
        }
        if (row.status === 'running') {
          setMessage(`Backup uploading… (attempt ${row.attempts + 1})`);
        }
         if (Date.now() - startedAt > TIMEOUT_MS) {
            setError(`Backup is still running after 10 minutes. Check the ${destination} and try again later.`);
           return false;
         }
         if (row.status === 'running') {
           const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
           const phase = destination === 'local backup folder' ? 'writing files' : 'uploading';
            const progress = destination === 'local backup folder' ? 65 : 70;
            const statusMessage = `Backup ${phase}… ${elapsedSeconds}s (attempt ${row.attempts + 1})`;
            setMessage(statusMessage);
            updateAppOperation({ progress, message: statusMessage });
         } else if (row.status === 'pending') {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            const statusMessage = `Backup is queued… ${elapsedSeconds}s`;
            setMessage(statusMessage);
            updateAppOperation({ progress: 35, message: statusMessage });
         }
        await new Promise((r) => setTimeout(r, 750));
      }
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      releaseOperation?.();
      setBusy(null);
    }
  }, [businessId, business, onReconnect]);

  const onBackupNow = useCallback(async (): Promise<void> => {
    await runBackup();
  }, [runBackup]);

  const onVerifyNow = useCallback(async (): Promise<void> => {
    clearMessages();
    const provider = getActiveProvider();
    if (!provider) {
      setError('Google Drive is not connected.');
      return;
    }
    setBusy('verify');
    try {
      const report = await provider.verifyIntegrity();
      setIntegrity(report);
      setMessage(
        report.ok
          ? `Backup integrity verified across ${report.filesChecked} file${report.filesChecked === 1 ? '' : 's'}.`
          : `Backup integrity check found ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const onSwitchToDrive = useCallback(async (): Promise<void> => {
    clearMessages();
    if (!business) {
      setError('Business is still loading.');
      return;
    }
    if (!hasGoogleClientId()) {
      setError('Google Drive is not configured. Set VITE_GOOGLE_CLIENT_ID and reload.');
      return;
    }
    const ok = window.confirm(
      `Switch this business's backups to Google Drive?\n\n` +
        `Your entire history for this business will be re-uploaded to Drive ` +
        `under BusinessVault - ${business.name} in the background. Files already ` +
        `in the local backup folder are not touched.`,
    );
    if (!ok) return;
    setBusy('switch');
    try {
      const res = await connectDrive({ businessId, prompt: 'consent' });
      const provider = await buildDriveProvider(businessId);
      const init = await provider.initializeBusiness({
        businessId,
        businessName: business.name,
      });
      await db.businesses.update(businessId, {
        drive_folder_id: init.providerFolderId,
        drive_connected_email: res.identity.email,
        updated_at: new Date().toISOString(),
      });
      // Refresh local view of the business row so the button hides + the
      // "connected as" line updates without a page reload.
      const refreshed = await db.businesses.get(businessId);
      if (refreshed) setBusiness(refreshed);
      // Swap the running local-folder worker (or none) for a Drive worker so
      // queued sync_events flush to Drive immediately. Promote any events the
      // old worker had already claimed (SYNCING) back to QUEUED so the fresh
      // Drive worker re-picks them up — otherwise a mid-flush switch would
      // orphan them.
      const syncingRequeued = await db.sync_events
        .where('[business_id+sync_status]')
        .equals([businessId, 'SYNCING'])
        .modify({ sync_status: 'QUEUED' });
      // Re-ship the full pre-switch history to Drive. Rows flagged SYNCED
      // against the previous provider (typically a busted local-folder
      // provider that never actually persisted them) still exist only in
      // IndexedDB. Restore-from-Drive would find an empty journal without
      // this backfill. Clearing synced_at + journal_file lets the Drive
      // worker treat them as fresh work.
      const syncedBackfilled = await db.sync_events
        .where('[business_id+sync_status]')
        .equals([businessId, 'SYNCED'])
        .modify({
          sync_status: 'QUEUED',
          synced_at: null,
          journal_file: null,
        });
      const runningRequeued = await db.sync_queue
        .where('[business_id+status]')
        .equals([businessId, 'running'])
        .modify({ status: 'pending' });
      log.info('backup', 'switch-to-drive backfill', {
        businessId,
        syncingRequeued,
        syncedBackfilled,
        runningRequeued,
        driveFolderId: init.providerFolderId,
        driveEmail: res.identity.email,
      });
      stopSyncWorker();
      adoptConnectedProvider(provider, businessId);
      setConn(await provider.connectionStatus());
      setMessage(
        `Switched to Google Drive as ${res.identity.email}. Your history (${syncedBackfilled} events) is being re-uploaded to Drive — check back in a minute.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [business, businessId]);

  const onDisconnect = useCallback(async (): Promise<void> => {
    clearMessages();
    const switchingToLocal = disconnected;
    const ok = window.confirm(
      switchingToLocal
        ? 'Switch to local folder backup?\n\nLocal data will be kept. Google Drive files will not be deleted, and you can reconnect Google Drive later.'
        : 'Disconnect Google Drive?\n\nLocal data will be kept — you can reconnect any time. Pending events will replay after reconnect.',
    );
    if (!ok) return;
    setBusy('disconnect');
    try {
      const provider = getActiveProvider();
      if (provider) await provider.disconnect();
      await disconnectDrive(businessId);
      stopSyncWorker();
      // Clear the connected email from the business row per §30 (local data stays).
      await db.businesses.update(businessId, {
        drive_folder_id: switchingToLocal ? null : business?.drive_folder_id ?? null,
        drive_connected_email: null,
        updated_at: new Date().toISOString(),
      });
      const refreshed = await db.businesses.get(businessId);
      if (refreshed) setBusiness(refreshed);
      setManuallyDisconnected(true);
      setConn({ state: 'DISCONNECTED' });
      setMessage('Google Drive disconnected. Local data is intact.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [businessId]);

  const onStartFresh = useCallback(async (): Promise<void> => {
    if (!onResetFresh) return;
    clearMessages();
    const confirmed = window.confirm(
      'Start fresh on this device?\n\n' +
        'BusinessVault will first create a fresh backup in Google Drive. Only after that succeeds will this browser be signed out and cleared. ' +
        'Your existing local folder and Google Drive files will not be deleted.\n\n' +
        'Continue?',
    );
    if (!confirmed) return;

    setBusy('start-fresh');
    try {
      let current = await db.businesses.get(businessId);
      if (!current) throw new Error('Business is still loading.');

      const localBusinesses = await db.businesses.toArray();
      if (localBusinesses.length !== 1 || localBusinesses[0]?.id !== businessId) {
        throw new Error(
          'Start Fresh is blocked because this device has multiple businesses. Back up each business before clearing the browser.',
        );
      }

      if (!current.drive_folder_id) {
        setMessage('Google Drive is required. Connect it to continue.');
        await onSwitchToDrive();
        current = await db.businesses.get(businessId);
        if (!current?.drive_folder_id) {
          throw new Error('Google Drive connection was not completed. Nothing was cleared.');
        }
      } else if (!getActiveProvider()) {
        setMessage('Reconnecting to Google Drive…');
        await onReconnect?.();
      }

      const provider = getActiveProvider();
      if (!provider || !current?.drive_folder_id) {
        throw new Error('Google Drive is not connected. Nothing was cleared.');
      }
      const status = await provider.connectionStatus();
      if (status.state !== 'CONNECTED') {
        throw new Error('Google Drive is not connected. Nothing was cleared.');
      }

      setMessage('Creating final Google Drive backup…');
      const backedUp = await runBackup();
      if (!backedUp) {
        throw new Error('Final Google Drive backup did not complete. Nothing was cleared.');
      }

      const integrity = await provider.verifyIntegrity();
      if (!integrity.ok) {
        throw new Error(
          `Final Google Drive backup failed integrity verification (${integrity.issues.length} issue${integrity.issues.length === 1 ? '' : 's'}). Nothing was cleared.`,
        );
      }

      setMessage('Backup complete. Clearing this browser…');
      await onResetFresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }, [businessId, onReconnect, onResetFresh, runBackup]);

  const onSwitchToLocal = useCallback(async (): Promise<void> => {
    clearMessages();
    const ok = window.confirm(
      'Switch this business to local folder backup?\n\n' +
        'Your local data will be kept and existing Google Drive files will not be deleted.',
    );
    if (!ok) return;
    const picker = (window as unknown as {
      showDirectoryPicker: (options?: { mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    const selectedLocalHandle = await picker({ mode: 'readwrite' });
    setBusy('local');
    try {
      const provider = getActiveProvider();
      if (provider) await provider.disconnect();
      await disconnectDrive(businessId);
      stopSyncWorker();
      await db.businesses.update(businessId, {
        drive_folder_id: null,
        drive_connected_email: null,
        updated_at: new Date().toISOString(),
      });
      const refreshed = await db.businesses.get(businessId);
      if (refreshed) setBusiness(refreshed);
      setManuallyDisconnected(false);
      setConn(null);
      setMessage('Choose your local backup folder to continue.');
      // This remains inside the user click handler, so the File System Access
      // picker is allowed to open immediately after the provider switch.
      if (onReconnect) await onReconnect(selectedLocalHandle);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [businessId, onReconnect]);

  const disconnected = status === 'DISCONNECTED';
  const usingLocalFolder = driveFolderId == null;
  const localFolderNeedsReconnect = usingLocalFolder && status === 'ERROR';
  const providerLabel = usingLocalFolder ? 'Local folder' : 'Google Drive';

  return (
    <div className="backup-settings-page">
      <header className="backup-settings-header">
        <div>
          <p className="backup-settings-eyebrow">Settings</p>
          <h1>Data &amp; Backup</h1>
          <p className="backup-settings-intro">
            Manage cloud backups, verify your data, and export a local copy.
          </p>
        </div>
      </header>

      {(disconnected || localFolderNeedsReconnect) && (
        <div
          role="status"
          className="backup-settings-alert"
        >
          <div>
            <div className="backup-settings-alert-title">
              {usingLocalFolder ? 'Local backup folder' : 'Google Drive backup disconnected.'}
            </div>
            <div className="backup-settings-alert-copy">
              {usingLocalFolder
                ? 'The saved folder is no longer available. Choose the BusinessVault folder again to resume backups.'
                : 'Your business continues to work on this device. Reconnect to resume backups — pending events will upload automatically.'}
            </div>
          </div>
          <button
            type="button"
            className="backup-settings-alert-action"
            onClick={() => void handleReconnect()}
          >
            {usingLocalFolder ? 'Choose local folder' : 'Reconnect'}
          </button>
        </div>
      )}

      <section className="backup-settings-card">
        <header className="backup-settings-card-header">
          <div className="backup-settings-card-icon" aria-hidden="true">
             {usingLocalFolder ? (
               <CloudBackup size={32} strokeWidth={2} aria-hidden="true" />
             ) : (
               <img src={`${import.meta.env.BASE_URL}icons/google-drive-logo.svg`} alt="" />
             )}
           </div>
           <div>
             <h2>{providerLabel}</h2>
             <p>{usingLocalFolder ? 'Local backup storage' : 'Cloud backup storage'}</p>
          </div>
          <span className={`backup-settings-connected-pill ${connected ? '' : 'backup-settings-connected-pill-offline'}`}>
            <span className="backup-settings-status-dot" aria-hidden="true" />
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </header>
        <dl className="backup-settings-details">
          <Row label="Connected as" value={email} />
          <Row
            label="Business folder"
            value={
              <span className="inline-flex items-center gap-2">
                <span>{folderPath}</span>
                {shouldShowDriveFolderLink(status, driveFolderId) && driveFolderId ? (
                  <a
                    href={DRIVE_FOLDER_URL(driveFolderId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="backup-settings-drive-link"
                  >
                    <ExternalLink size={20} strokeWidth={2} aria-hidden="true" />
                    Open My Google Drive Folder
                  </a>
                ) : null}
              </span>
            }
          />
        </dl>
        <dl className="backup-settings-metrics">
          <Metric label="Last event sync" value={relativeTime(health.lastEventSyncAt)} />
          <Metric label="Last full backup" value={relativeTime(health.lastFullSnapshotAt)} />
          <Metric label="Pending" value={String(health.pending)} />
          <Metric label="Backup integrity" value={integrityLabel} />
        </dl>
        <div className={`backup-settings-health ${STATUS_TONE[status]}`}>
          <span className="backup-settings-health-icon" aria-hidden="true">
            {status === 'HEALTHY' ? <CheckCircle2 size={20} strokeWidth={2} /> : <TriangleAlert size={20} strokeWidth={2} />}
          </span>
          <span className="backup-settings-health-label">Status</span>
          <span className="backup-settings-health-value">{status}</span>
          <span className="backup-settings-health-divider" aria-hidden="true" />
          <span className="backup-settings-health-copy">
             {status === 'HEALTHY'
               ? `${providerLabel} connection is active.`
               : `${providerLabel} needs attention.`}
          </span>
        </div>
      </section>

      <section className="backup-settings-card backup-settings-action-card">
        <header className="backup-settings-action-header">
          <div className="backup-settings-action-icon" aria-hidden="true">
            <CloudBackup size={32} strokeWidth={2} aria-hidden="true" />
          </div>
          <div>
            <h2>Backup &amp; export</h2>
            <p>Create, verify, or download a copy of your business data.</p>
          </div>
        </header>
        <div className="backup-settings-actions">
        <button
          type="button"
          onClick={onBackupNow}
          disabled={!!busy || disconnected}
          className="backup-settings-button backup-settings-button-primary"
        >
          <CloudBackup size={20} strokeWidth={2} aria-hidden="true" />
          {busy === 'backup' ? 'Backup in progress…' : 'Backup now'}
        </button>
        <button
          type="button"
          onClick={onVerifyNow}
          disabled={!!busy || disconnected}
          className="backup-settings-button backup-settings-button-secondary"
        >
          <ShieldCheck size={20} strokeWidth={2} aria-hidden="true" />
          {busy === 'verify' ? 'Verifying…' : 'Verify integrity now'}
        </button>
        <button
          type="button"
          onClick={() => setShowExport((v) => !v)}
          className="backup-settings-button backup-settings-button-tertiary"
        >
          <Download size={20} strokeWidth={2} aria-hidden="true" />
          Export My Business
        </button>
        {driveFolderId == null && (
            <button
            type="button"
            onClick={onSwitchToDrive}
            disabled={!!busy}
            className="backup-settings-button backup-settings-button-secondary backup-settings-button-drive"
          >
            {busy === 'switch' ? 'Switching…' : 'Switch to Google Drive backup'}
          </button>
        )}
        {usingLocalFolder && onReconnect && (
          <button
            type="button"
            onClick={() => void handleReconnect()}
            disabled={!!busy}
            className="backup-settings-button backup-settings-button-secondary"
          >
            {busy === 'reconnect' ? 'Choosing…' : 'Choose local folder'}
          </button>
        )}
        </div>
      </section>

       {driveFolderId != null && (
         <section className="backup-settings-danger-zone">
          <div>
            <TriangleAlert size={24} strokeWidth={2} aria-hidden="true" />
            <h2>Disconnect Google Drive</h2>
            <p>Stops automatic Google Drive backups. Your existing Drive files will not be deleted.</p>
          </div>
          <button
            type="button"
            onClick={() => void handleReconnect()}
            disabled={!!busy}
            className="backup-settings-button backup-settings-button-danger"
          >
            <Unplug size={20} strokeWidth={2} aria-hidden="true" />
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google Drive'}
          </button>
        </section>
       )}

       {onResetFresh && (
         <section className="backup-settings-danger-zone">
           <div>
             <TriangleAlert size={24} strokeWidth={2} aria-hidden="true" />
             <h2>Start fresh on this device</h2>
             <p>Delete all local app data and sign out. Backup files are not deleted.</p>
           </div>
           <button
             type="button"
             onClick={() => void onStartFresh()}
             disabled={!!busy}
             className="backup-settings-button backup-settings-button-danger"
           >
             Start fresh
           </button>
         </section>
       )}

       {disconnected && driveFolderId != null && (
         <section className="backup-settings-card backup-settings-action-card">
           <p className="backup-settings-action-copy">
             Google Drive is disconnected. Switch to a local folder to continue testing backups on this device.
           </p>
           <button
             type="button"
             onClick={onDisconnect}
             disabled={!!busy}
             className="backup-settings-button backup-settings-button-secondary"
           >
             {busy === 'disconnect' ? 'Switching…' : 'Switch to local folder backup'}
           </button>
           <button
             type="button"
             onClick={() => void onSwitchToLocal()}
             disabled={!!busy}
             className="backup-settings-button backup-settings-button-secondary"
           >
             {busy === 'local' ? 'Switching…' : 'Switch to local folder backup'}
           </button>
         </section>
       )}

      {message && (
        <div className="backup-settings-feedback backup-settings-feedback-success">
          {message}
        </div>
      )}
      {error && (
        <div className="backup-settings-feedback backup-settings-feedback-error">
          {error}
        </div>
      )}

      {showExport && (
          <section className="backup-settings-card backup-settings-export-card">
            <DataExport businessId={businessId} />
          </section>
      )}

      {integrity && !integrity.ok && (
        <section className="backup-settings-integrity-card">
          <div className="font-semibold">Integrity issues</div>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            {integrity.issues.slice(0, 20).map((iss, i) => (
              <li key={i}>
                <span className="font-mono">{iss.code}</span> — {iss.path}: {iss.detail}
              </li>
            ))}
            {integrity.issues.length > 20 && (
              <li>… and {integrity.issues.length - 20} more.</li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="backup-settings-detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="backup-settings-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
