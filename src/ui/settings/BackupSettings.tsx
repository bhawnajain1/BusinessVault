import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { db } from '../../db';
import { useBackupHealth } from '../BackupHealthContext';
import type { BackupHealthStatus } from '../../sync/syncWorker';
import { getActiveProvider } from '../../sync/providerRegistry';
import { enqueue } from '../../sync/syncQueue';
import { buildSnapshotInput } from '../../sync/buildSnapshotInput';
import { pokeSyncWorker } from '../../sync/syncWorker';
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
//   Business folder: BusinessVault/<name>  [Open My Google Drive Folder]
//   Last event sync:    <relative time>
//   Last full snapshot: <relative time>
//   Pending:            <count>
//   Backup integrity:   <Verified | Failed>
//   Status:             <HEALTHY | SYNCING | OFFLINE | DISCONNECTED | ERROR | CONFLICT | INTEGRITY_FAILURE>
//
// Buttons: Snapshot now / Verify integrity now / Export My Business /
// Disconnect Google Drive.
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

interface Props {
  businessId: string;
  onReconnect?: () => void;
}

export default function BackupSettings({ businessId, onReconnect }: Props) {
  const health = useBackupHealth();
  const [business, setBusiness] = useState<Business | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      const b = await db.businesses.get(businessId);
      if (!cancelled) setBusiness(b ?? null);
      const provider = getActiveProvider();
      if (provider) {
        try {
          const c = await provider.connectionStatus();
          if (!cancelled) setConn(c);
        } catch (e) {
          if (!cancelled) setConn({ state: 'ERROR', error: (e as Error).message });
        }
      } else {
        if (!cancelled) setConn({ state: 'DISCONNECTED' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Derive display status: prefer health.status, but override to DISCONNECTED
  // when there's no provider / connection state says so.
  const status: BackupHealthStatus = useMemo(() => {
    if (conn?.state === 'DISCONNECTED') return 'DISCONNECTED';
    if (integrity && !integrity.ok) return 'INTEGRITY_FAILURE';
    return health.status;
  }, [conn, integrity, health.status]);

  const email = conn?.account ?? business?.drive_connected_email ?? '(not connected)';
  const folderName = business?.name ?? '';
  const folderPath = conn?.folderPath ?? `BusinessVault/${folderName}`;
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

  const onSnapshotNow = useCallback(async (): Promise<void> => {
    clearMessages();
    if (!getActiveProvider()) {
      setError('Google Drive is not connected — click Reconnect above, then try again.');
      return;
    }
    setBusy('snapshot');
    try {
      if (!business) {
        throw new Error('Business is still loading.');
      }
      const asOf = new Date().toISOString().slice(0, 10);
      const input = await buildSnapshotInput(db, businessId, business.name, 'ondemand', asOf);
      await enqueue({
        businessId,
        kind: 'snapshot',
        payload: { input },
      });
      pokeSyncWorker();
      setMessage('Snapshot queued. It will run in the background.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [businessId, business]);

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

  const onDisconnect = useCallback(async (): Promise<void> => {
    clearMessages();
    const ok = window.confirm(
      'Disconnect Google Drive?\n\nLocal data will be kept — you can reconnect any time. Pending events will replay after reconnect.',
    );
    if (!ok) return;
    setBusy('disconnect');
    try {
      const provider = getActiveProvider();
      if (provider) await provider.disconnect();
      // Clear the connected email from the business row per §30 (local data stays).
      await db.businesses.update(businessId, {
        drive_connected_email: null,
        updated_at: new Date().toISOString(),
      });
      setConn({ state: 'DISCONNECTED' });
      setMessage('Google Drive disconnected. Local data is intact.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [businessId]);

  const disconnected = status === 'DISCONNECTED';

  return (
    <div className="space-y-6 p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold text-slate-900">Data & Backup</h1>

      {disconnected && (
        <div
          role="status"
          className="flex items-center justify-between gap-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
        >
          <div>
            <div className="font-semibold">Google Drive backup disconnected.</div>
            <div className="text-sm">
              Your business continues to work on this device. Reconnect to
              resume backups — pending events will upload automatically.
            </div>
          </div>
          <button
            type="button"
            className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white">
        <header className="border-b border-slate-100 px-5 py-3 font-semibold text-slate-900">
          Google Drive
        </header>
        <dl className="divide-y divide-slate-100">
          <Row label="Connected as" value={email} />
          <Row
            label="Business folder"
            value={
              <span className="inline-flex items-center gap-2">
                <span>{folderPath}</span>
                {driveFolderId ? (
                  <a
                    href={DRIVE_FOLDER_URL(driveFolderId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Open My Google Drive Folder
                  </a>
                ) : null}
              </span>
            }
          />
          <Row label="Last event sync" value={relativeTime(health.lastEventSyncAt)} />
          <Row label="Last full snapshot" value={relativeTime(health.lastFullSnapshotAt)} />
          <Row label="Pending" value={String(health.pending)} />
          <Row label="Backup integrity" value={integrityLabel} />
          <Row
            label="Status"
            value={
              <span
                className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_TONE[status]}`}
              >
                {status}
              </span>
            }
          />
        </dl>
      </section>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onSnapshotNow}
          disabled={!!busy || disconnected}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === 'snapshot' ? 'Queueing…' : 'Snapshot now'}
        </button>
        <button
          type="button"
          onClick={onVerifyNow}
          disabled={!!busy || disconnected}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy === 'verify' ? 'Verifying…' : 'Verify integrity now'}
        </button>
        <button
          type="button"
          onClick={() => setShowExport((v) => !v)}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
        >
          Export My Business
        </button>
        {!disconnected && (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={!!busy}
            className="ml-auto rounded-md border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google Drive'}
          </button>
        )}
      </div>

      {message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {showExport && (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <DataExport businessId={businessId} />
        </section>
      )}

      {integrity && !integrity.ok && (
        <section className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
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
    <div className="grid grid-cols-3 gap-4 px-5 py-3 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 text-slate-900">{value}</dd>
    </div>
  );
}
