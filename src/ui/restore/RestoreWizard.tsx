import { useCallback, useMemo, useState } from 'react';
import { db as defaultDb } from '../../db';
import { LocalFolderStorageProvider } from '../../storage/LocalFolderStorageProvider';
import type {
  CustomerStorageProvider,
  ProviderConfig,
} from '../../storage/CustomerStorageProvider';
import {
  rebuildFromDrive,
  renderDiagnosticReport,
  UnshippedEventsError,
  type DiscoveredBusiness,
  type RestoreReport,
  type UnshippedEventsSummary,
} from '../../restore/rebuildFromDrive';

type Step =
  | 'idle'
  | 'connecting'
  | 'picking'
  | 'restoring'
  | 'confirm-data-loss'
  | 'done'
  | 'error';

type ProviderKind = 'google-drive' | 'local-folder';

interface RestoreWizardProps {
  provider?: CustomerStorageProvider;
  db?: typeof defaultDb;
}

// The window.showDirectoryPicker type isn't in lib.dom yet.
type DirHandle = FileSystemDirectoryHandle;
function pickerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

async function clearSavedHandle(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('businessvault-local-folder');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

export default function RestoreWizard(props: RestoreWizardProps) {
  const [providerKind, setProviderKind] = useState<ProviderKind>('local-folder');
  const [pickedHandle, setPickedHandle] = useState<DirHandle | null>(null);
  const [pickedName, setPickedName] = useState<string>('');
  const [driveClientId, setDriveClientId] = useState('');
  const [driveClientSecret, setDriveClientSecret] = useState('');
  const [driveRedirectUri, setDriveRedirectUri] = useState(
    typeof window !== 'undefined'
      ? `${window.location.origin}${import.meta.env.BASE_URL || '/'}oauth/callback`.replace(
          /\/+oauth\/callback$/,
          '/oauth/callback',
        )
      : '',
  );

  const [step, setStep] = useState<Step>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [businesses, setBusinesses] = useState<DiscoveredBusiness[]>([]);
  const [pickerResolve, setPickerResolve] = useState<
    ((b: DiscoveredBusiness) => void) | null
  >(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [unshipped, setUnshipped] = useState<UnshippedEventsSummary | null>(null);

  const db = props.db ?? defaultDb;

  const appendLog = useCallback((msg: string) => {
    setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const providerConfig: ProviderConfig | null = useMemo(() => {
    if (providerKind === 'local-folder') {
      // rootPath is ignored in the browser (picker/handle drives the FS backend);
      // required only by the Node/test path.
      return { kind: 'local-folder', rootPath: '' };
    }
    return {
      kind: 'google-drive',
      clientId: driveClientId,
      clientSecret: driveClientSecret,
      redirectUri: driveRedirectUri,
    };
  }, [providerKind, driveClientId, driveClientSecret, driveRedirectUri]);

  const onChooseFolder = useCallback(async () => {
    setError(null);
    if (!pickerAvailable()) {
      setError('Your browser does not support the File System Access API. Use Chrome, Edge, or Arc.');
      return;
    }
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (o?: { mode?: 'readwrite' }) => Promise<DirHandle>;
      }).showDirectoryPicker;
      const handle = await picker({ mode: 'readwrite' });
      setPickedHandle(handle);
      setPickedName(handle.name);
      appendLog(`Picked folder: ${handle.name}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.toLowerCase().includes('abort')) {
        appendLog('Folder selection cancelled.');
      } else {
        setError(`Folder picker failed: ${msg}`);
      }
    }
  }, [appendLog]);

  const onClearSavedHandle = useCallback(async () => {
    await clearSavedHandle();
    setPickedHandle(null);
    setPickedName('');
    appendLog('Cleared saved folder handle.');
  }, [appendLog]);

  const runRestore = useCallback(
    async (confirmDataLoss: boolean) => {
      if (!providerConfig) return;
      if (providerKind === 'local-folder' && !pickedHandle) {
        setError('Choose a folder first.');
        return;
      }

      setStep('connecting');
      setError(null);
      setReport(null);
      setUnshipped(null);
      setProgressPct(0);
      setStatusMessage('Connecting...');
      if (!confirmDataLoss) setLog([]);
      appendLog(confirmDataLoss ? 'Restore restarted with data-loss confirmed.' : 'Restore started.');

      const provider =
        props.provider ??
        (providerKind === 'local-folder'
          ? new LocalFolderStorageProvider()
          : null);

      if (!provider) {
        setStep('error');
        setError('Google Drive provider is not wired in yet in this build.');
        return;
      }

      if (providerKind === 'local-folder' && pickedHandle) {
        (provider as LocalFolderStorageProvider).setDirectoryHandle(pickedHandle);
        appendLog(`Using handle: ${pickedHandle.name}`);
      }

      try {
        const result = await rebuildFromDrive(provider, {
          db,
          providerConfig,
          confirmDataLoss,
          onProgress: (msg, pct) => {
            setStatusMessage(msg);
            appendLog(`Progress: ${msg}${pct != null ? ` (${pct}%)` : ''}`);
            if (pct != null) setProgressPct(pct);
          },
          pickBusiness: async (ctx) => {
            appendLog(`Found ${ctx.businesses.length} businesses: ${ctx.businesses.map((b) => b.businessName).join(', ')}`);
            setBusinesses(ctx.businesses);
            setStep('picking');
            return await new Promise<DiscoveredBusiness>((resolve) => {
              setPickerResolve(() => resolve);
            });
          },
        });
        appendLog(`Restore complete. Events replayed: ${result.eventsReplayed}.`);
        setReport(result);
        setStep('done');
      } catch (err) {
        if (err instanceof UnshippedEventsError) {
          appendLog(
            `Refused to overwrite: ${err.summary.total} unshipped event(s) on this device would be lost.`,
          );
          setUnshipped(err.summary);
          setStep('confirm-data-loss');
          return;
        }
        const msg = (err as Error).message;
        appendLog(`Failed: ${msg}`);
        setError(msg);
        setStep('error');
      }
    },
    [db, providerConfig, providerKind, props.provider, pickedHandle, appendLog],
  );

  const onStart = useCallback(() => runRestore(false), [runRestore]);
  const onConfirmDataLoss = useCallback(() => runRestore(true), [runRestore]);
  const onCancelDataLoss = useCallback(() => {
    setStep('idle');
    setUnshipped(null);
    appendLog('Restore cancelled. Local unshipped data preserved.');
  }, [appendLog]);

  const onPick = (b: DiscoveredBusiness) => {
    if (pickerResolve) {
      pickerResolve(b);
      setPickerResolve(null);
      setStep('restoring');
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">
        Restore from Backup
      </h1>
      <p className="text-slate-600">
        This rebuilds your local database from a customer-owned backup folder. Nothing on the backup is modified.
      </p>

      {(step === 'idle' || step === 'error') && (
        <section className="border rounded-lg p-4 space-y-4 bg-white">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Backup source
            </label>
            <select
              className="w-full border rounded px-3 py-2"
              value={providerKind}
              onChange={(e) => setProviderKind(e.target.value as ProviderKind)}
            >
              <option value="local-folder">Local folder</option>
              <option value="google-drive">Google Drive</option>
            </select>
          </div>

          {providerKind === 'local-folder' && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">
                Folder
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onChooseFolder}
                  className="bg-slate-900 text-white rounded px-3 py-2 text-sm hover:bg-slate-800"
                >
                  Choose Folder…
                </button>
                {pickedName && (
                  <span className="text-sm text-slate-700 font-mono truncate">{pickedName}</span>
                )}
                {!pickedName && (
                  <span className="text-sm text-slate-500">No folder chosen yet.</span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                Pick either <code>BusinessVault</code> (the folder that contains your business folders) or its parent. Chrome will show a permission prompt.
              </p>
              <button
                type="button"
                onClick={onClearSavedHandle}
                className="text-xs text-slate-600 underline hover:text-slate-900"
              >
                Clear saved folder handle
              </button>
            </div>
          )}

          {providerKind === 'google-drive' && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  OAuth Client ID
                </label>
                <input
                  className="w-full border rounded px-3 py-2 font-mono text-sm"
                  value={driveClientId}
                  onChange={(e) => setDriveClientId(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  OAuth Client Secret
                </label>
                <input
                  type="password"
                  className="w-full border rounded px-3 py-2 font-mono text-sm"
                  value={driveClientSecret}
                  onChange={(e) => setDriveClientSecret(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Redirect URI
                </label>
                <input
                  className="w-full border rounded px-3 py-2 font-mono text-sm"
                  value={driveRedirectUri}
                  onChange={(e) => setDriveRedirectUri(e.target.value)}
                />
              </div>
              <p className="text-xs text-slate-500">
                Scope is fixed to <code>drive.file</code>.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded border border-red-300 bg-red-50 text-red-800 p-3 text-sm">
              {error}
            </div>
          )}

          <button
            type="button"
            className="bg-emerald-600 text-white rounded px-4 py-2 hover:bg-emerald-700 disabled:opacity-50"
            onClick={onStart}
            disabled={
              (providerKind === 'local-folder' && !pickedHandle) ||
              (providerKind === 'google-drive' &&
                (!driveClientId || !driveClientSecret || !driveRedirectUri))
            }
          >
            Start Restore
          </button>
        </section>
      )}

      {(step === 'connecting' || step === 'restoring') && (
        <section className="border rounded-lg p-4 bg-white space-y-3">
          <div className="text-slate-700">{statusMessage}</div>
          <div className="h-2 bg-slate-200 rounded overflow-hidden">
            <div
              className="h-full bg-slate-900 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="text-xs text-slate-500">
            Do not close this tab. Restore runs entirely on your device.
          </div>
        </section>
      )}

      {step === 'confirm-data-loss' && unshipped && (
        <section className="border-2 border-red-400 rounded-lg p-4 bg-red-50 space-y-4">
          <h2 className="text-lg font-semibold text-red-900">
            Stop — this restore would erase local work
          </h2>
          <p className="text-sm text-red-900">
            <strong>{unshipped.total}</strong> event
            {unshipped.total === 1 ? '' : 's'} for{' '}
            <strong>{unshipped.businessName}</strong> exist on this device but
            have not been backed up to the folder yet. If you continue, they
            will be permanently deleted.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-white border border-red-200 rounded p-3">
              <div className="text-xs uppercase tracking-wide text-red-700 mb-2">
                By sync status
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(unshipped.byStatus).map(([k, v]) => (
                    <tr key={k}>
                      <td className="font-mono text-slate-700">{k}</td>
                      <td className="text-right text-slate-900">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-white border border-red-200 rounded p-3">
              <div className="text-xs uppercase tracking-wide text-red-700 mb-2">
                By entity type
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(unshipped.byEntityType).map(([k, v]) => (
                    <tr key={k}>
                      <td className="font-mono text-slate-700">{k}</td>
                      <td className="text-right text-slate-900">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="text-sm text-red-900 space-y-1">
            <div className="font-semibold">Recommended:</div>
            <ol className="list-decimal ml-5 space-y-1">
              <li>
                Cancel this restore.
              </li>
              <li>
                Open Settings → Backup and make sure the backup folder is
                connected and the sync worker shows "Healthy".
              </li>
              <li>
                Wait until pending events reach zero, so the folder catches
                up with this device.
              </li>
              <li>
                Then run Restore again — it will find nothing unshipped and
                proceed safely.
              </li>
            </ol>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onCancelDataLoss}
              className="bg-slate-900 text-white rounded px-4 py-2 hover:bg-slate-800"
            >
              Cancel restore (keep local data)
            </button>
            <button
              type="button"
              onClick={onConfirmDataLoss}
              className="bg-red-600 text-white rounded px-4 py-2 hover:bg-red-700"
            >
              I understand — overwrite anyway
            </button>
          </div>
        </section>
      )}

      {step === 'picking' && (
        <section className="border rounded-lg p-4 bg-white space-y-3">
          <h2 className="text-lg font-medium text-slate-900">
            Select a business to restore
          </h2>
          <ul className="divide-y">
            {businesses.map((b) => (
              <li
                key={b.folderPath}
                className="py-3 flex items-center justify-between"
              >
                <div>
                  <div className="font-medium text-slate-900">
                    {b.businessName}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    {b.folderPath} · schema v{b.schemaVersion}
                  </div>
                </div>
                <button
                  type="button"
                  className="border rounded px-3 py-1 hover:bg-slate-50"
                  onClick={() => onPick(b)}
                >
                  Restore this
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {step === 'done' && report && (
        <section className="border rounded-lg p-4 bg-white space-y-4">
          <h2 className="text-lg font-medium text-slate-900">
            Restore report — {report.businessName}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <Metric ok={report.checksumsOk} label="Checksums" />
            <Metric ok={report.accountingBalanced} label="Accounting balanced" />
            <Metric ok={report.inventoryConsistent} label="Inventory identity" />
            <Metric ok={report.gstReconciled} label="GST reconciled" />
          </div>
          <div className="text-sm text-slate-700">
            <div>
              Events replayed: <strong>{report.eventsReplayed}</strong>
              {report.unhandledEvents > 0 && (
                <span className="text-amber-700 ml-2">
                  ({report.unhandledEvents} unhandled)
                </span>
              )}
            </div>
            {report.migratedFrom !== undefined && (
              <div>
                Migrated snapshot schema v{report.migratedFrom} → v
                {report.schemaVersion}.
              </div>
            )}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">
              Full diagnostic report
            </summary>
            <pre className="mt-2 bg-slate-50 border rounded p-3 whitespace-pre-wrap font-mono text-xs overflow-auto max-h-96">
              {renderDiagnosticReport(report.diagnostics)}
            </pre>
          </details>
        </section>
      )}

      {log.length > 0 && (
        <section className="border rounded-lg p-3 bg-slate-50">
          <div className="text-xs font-medium text-slate-600 mb-1">Diagnostics</div>
          <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap max-h-64 overflow-auto">
            {log.join('\n')}
          </pre>
        </section>
      )}
    </div>
  );
}

function Metric({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={
        'rounded border p-3 ' +
        (ok
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
          : 'border-red-300 bg-red-50 text-red-800')
      }
    >
      <div className="text-xs uppercase tracking-wide">{label}</div>
      <div className="font-semibold">{ok ? 'OK' : 'Failed'}</div>
    </div>
  );
}
