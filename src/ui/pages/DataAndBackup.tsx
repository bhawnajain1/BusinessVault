import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { currentBusinessId } from '../../lib/business';
import { setCurrentBusinessId } from '../../lib/business';
import { db } from '../../db';
import type { Business } from '../../db/types';
import BackupSettings from '../settings/BackupSettings';
import { reconnectWithUserGesture, stopSyncWorkerAsync, tryBootProvider } from '../../sync/bootProvider';
import { log } from '../../lib/log';
import { resetAppToFreshState } from '../../lib/resetApp';
import { beginAppOperation } from '../../lib/operationLock';

// Settings → Data & Backup (spec §3, §28). Under GIS, Reconnect is an inline
// popup — no navigation to /onboarding, no redirect_uri round-trip.

export default function DataAndBackup() {
  const navigate = useNavigate();
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const id = await currentBusinessId();
        const rows = await db.businesses.toArray();
        if (cancelled) return;
        setBusinessId(id);
        setBusinesses(rows.sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        if (!cancelled) setBusinessId(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onBusinessChange = useCallback(async (nextId: string): Promise<void> => {
    if (!nextId || nextId === businessId) return;
    await stopSyncWorkerAsync();
    await setCurrentBusinessId(nextId);
    setBusinessId(nextId);
    setReconnectError(null);
  }, [businessId]);

  const onPrepareBusiness = useCallback(async (nextId: string): Promise<boolean> => {
    await stopSyncWorkerAsync();
    await setCurrentBusinessId(nextId);
    setBusinessId(nextId);
    return tryBootProvider();
  }, []);

  const onReconnect = useCallback(async (selectedLocalHandle?: FileSystemDirectoryHandle): Promise<void> => {
    setReconnectError(null);
    if (!businessId) {
      setReconnectError('No active business.');
      return;
    }
    setReconnecting(true);
    try {
      log.info('DataAndBackup', 'reconnect: delegating to bootProvider', { businessId });
      // Delegate to bootProvider — it opens the GIS popup, builds the Drive
      // provider, initializes the business, stops the stale sync worker, and
      // installs a fresh one bound to the new provider. Calling connectDrive
      // directly (previous behavior) only refreshed the OAuth token; the app
      // kept the stale DISCONNECTED provider + old worker, so the yellow
      // "needs to reconnect" banner and the DISCONNECTED status never
      // cleared even though sign-in succeeded.
      const ok = await reconnectWithUserGesture(selectedLocalHandle);
      if (ok) {
        log.info('DataAndBackup', 'reconnect: success — provider adopted', { businessId });
      } else {
        log.warn('DataAndBackup', 'reconnect: bootProvider reported failure', { businessId });
        setReconnectError(
          'Reconnect did not complete. See the banner above for details, or try again.',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('DataAndBackup', 'reconnect failed', { error: msg });
      setReconnectError(msg);
    } finally {
      setReconnecting(false);
    }
  }, [businessId]);

  const onResetFresh = useCallback(async (): Promise<void> => {
    const release = beginAppOperation({
      kind: 'start-fresh',
      label: 'Start Fresh',
      cancelable: false,
    });
    try {
      await resetAppToFreshState();
      window.location.assign(`${import.meta.env.BASE_URL}onboarding`);
    } catch (err) {
      release();
      setReconnectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (loading) {
    return <div className="p-6 text-slate-500">Loading backup settings…</div>;
  }
  if (!businessId) {
    return (
      <div className="p-6 text-slate-600">
        <p>No business found. Complete onboarding first.</p>
        <button
          type="button"
          onClick={() => navigate('/onboarding')}
          className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Go to onboarding
        </button>
      </div>
    );
  }

    return (
      <div>
      {businesses.length > 1 && (
        <section className="mx-6 mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <label className="block text-sm font-medium text-amber-900" htmlFor="backup-business-select">
            Business to back up
          </label>
          <select
            id="backup-business-select"
            value={businessId}
            onChange={(event) => void onBusinessChange(event.target.value)}
            className="mt-2 w-full max-w-xl rounded-md border border-amber-300 bg-white px-3 py-2 text-sm"
          >
            {businesses.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-amber-800">
            Select each business, click Reconnect if needed, and run Backup now before using Start Fresh.
          </p>
        </section>
      )}
      {reconnectError && (
        <div className="mx-6 mt-6 rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {reconnectError}
        </div>
      )}
      <BackupSettings
        key={businessId}
        businessId={businessId}
        onPrepareBusiness={onPrepareBusiness}
        onReconnect={reconnecting ? undefined : onReconnect}
        onResetFresh={onResetFresh}
      />
    </div>
  );
}
