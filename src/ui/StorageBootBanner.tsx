import { useEffect, useState } from 'react';
import {
  getBootState,
  reconnectWithUserGesture,
  subscribeBoot,
  tryBootLocalFolderProvider,
} from '../sync/bootProvider';
import { useBackupHealth } from './BackupHealthContext';

// Auto-attempts a silent reconnect on mount. If Chrome revoked the folder
// permission (needs a user gesture to re-grant), or if the saved handle is
// gone, shows a small yellow banner with a "Reconnect" button. The button
// runs inside a click handler so showDirectoryPicker / requestPermission
// succeed.
//
// Also surfaces sync-worker failures once boot is running: if the worker's
// BackupHealth reports ERROR or DISCONNECTED (a job died after max_attempts,
// or the folder handle went stale mid-session — e.g. businessId mismatch
// after creating a second business), show a red banner with the last error
// and a Reconnect button. Without this, the app silently accumulates
// unshipped events and the user only discovers the loss after a Restore.
export default function StorageBootBanner() {
  const [state, setState] = useState(getBootState());
  const [busy, setBusy] = useState(false);
  const health = useBackupHealth();

  useEffect(() => {
    const unsub = subscribeBoot(setState);
    // Silent boot on first mount. This will land in 'running' if the saved
    // handle still has readwrite permission, or 'needs-permission' if not.
    void tryBootLocalFolderProvider();
    return unsub;
  }, []);

  const onReconnect = async () => {
    setBusy(true);
    try {
      await reconnectWithUserGesture();
    } finally {
      setBusy(false);
    }
  };

  const buttonLabel = (isNoFolder: boolean) =>
    busy ? 'Working…' : isNoFolder ? 'Choose Folder…' : 'Reconnect';

  // Boot-phase banner: no folder yet, needs permission, or bootWithHandle
  // outright failed. Yellow (needs-permission / no-folder) or red (error).
  if (state.status !== 'idle' && state.status !== 'starting' && state.status !== 'running') {
    const isError = state.status === 'error';
    const isNoFolder = state.status === 'no-folder';
    const message = isError
      ? `Backup folder error: ${state.error ?? 'unknown'}`
      : isNoFolder
        ? 'Backup folder not chosen yet. Pick a folder so new entries flush to disk.'
        : 'Backup folder needs permission. Click Reconnect and re-grant access so new entries flush to disk.';
    return (
      <div
        className={
          'px-4 py-2 text-sm flex items-center gap-3 border-b ' +
          (isError
            ? 'bg-rose-50 border-rose-200 text-rose-900'
            : 'bg-amber-50 border-amber-200 text-amber-900')
        }
      >
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onReconnect}
          disabled={busy}
          className="rounded border border-current px-2 py-1 text-xs hover:bg-white/40 disabled:opacity-50"
        >
          {buttonLabel(isNoFolder)}
        </button>
      </div>
    );
  }

  // Post-boot: worker is running but reports ERROR / DISCONNECTED. Surface
  // the error and let the user reconnect (which starts a fresh provider —
  // fixes the businessId-mismatch loop that stalls after a new business is
  // created on top of a running worker).
  if (health.status === 'ERROR' || health.status === 'DISCONNECTED') {
    const message = health.lastError
      ? `Backup is not saving to your folder: ${health.lastError}`
      : 'Backup is not saving to your folder. Click Reconnect to re-select the folder for this business.';
    return (
      <div
        className="px-4 py-2 text-sm flex items-center gap-3 border-b bg-rose-50 border-rose-200 text-rose-900"
        data-testid="sync-error-banner"
      >
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onReconnect}
          disabled={busy}
          className="rounded border border-current px-2 py-1 text-xs hover:bg-white/40 disabled:opacity-50"
        >
          {buttonLabel(false)}
        </button>
      </div>
    );
  }

  return null;
}
