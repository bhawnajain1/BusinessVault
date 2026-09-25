import { useCallback, useEffect, useMemo, useState } from 'react';
import { db as defaultDb } from '../../db';
import { LocalFolderStorageProvider } from '../../storage/LocalFolderStorageProvider';
import { GoogleDriveStorageProvider } from '../../drive/GoogleDriveStorageProvider';
import type {
  CustomerStorageProvider,
  ProviderConfig,
} from '../../storage/CustomerStorageProvider';
import {
  rebuildFromDrive,
  renderDiagnosticReport,
  EmptyBackupError,
  UnshippedEventsError,
  type DiscoveredBusiness,
  type RestoreReport,
  type UnshippedEventsSummary,
} from '../../restore/rebuildFromDrive';
import { env } from '../../lib/env';
import { connectDrive } from '../../drive/connectDrive';
import { createDriveApiClient } from '../../drive/google';
import { log } from '../../lib/log';
import { downloadDebugLogs } from '../../lib/downloadLogs';
import { beginAppOperation, updateAppOperation } from '../../lib/operationLock';
import { stopSyncWorkerAsync, tryBootProvider } from '../../sync/bootProvider';

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

const RESTORE_BUSINESS_ID = 'pending-onboarding';

type DirHandle = FileSystemDirectoryHandle;
function pickerAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
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
  const [driveConnecting, setDriveConnecting] = useState(false);
  const [driveConnectedEmail, setDriveConnectedEmail] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [businesses, setBusinesses] = useState<DiscoveredBusiness[]>([]);
  const [pickerResolve, setPickerResolve] = useState<
    ((b: DiscoveredBusiness) => void) | null
  >(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log2, setLog] = useState<string[]>([]);
  const [unshipped, setUnshipped] = useState<UnshippedEventsSummary | null>(null);

  const db = props.db ?? defaultDb;

  useEffect(() => {
    log.info('restore-ui', 'restore view state changed', {
      step,
      hasReport: Boolean(report),
      hasError: Boolean(error),
      selectedFolderName: pickedName || null,
    });
  }, [step, report, error, pickedName]);

  const appendLog = useCallback((msg: string) => {
    setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const providerConfig: ProviderConfig | null = useMemo(() => {
    if (providerKind === 'local-folder') {
      return { kind: 'local-folder', rootPath: '' };
    }
    return {
      kind: 'google-drive',
      clientId: env.googleClientId,
      scope: 'drive.file',
    };
  }, [providerKind]);

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
      log.info('restore-ui', 'folder selected', { folderName: handle.name });
      appendLog(`Picked folder: ${handle.name}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.toLowerCase().includes('abort')) {
        log.info('restore-ui', 'folder selection cancelled');
        appendLog('Folder selection cancelled.');
      } else {
        log.error('restore-ui', 'folder selection failed', { error: msg });
        setError(`Folder picker failed: ${msg}`);
      }
    }
  }, [appendLog]);

  const onClearSavedHandle = useCallback(async () => {
    await clearSavedHandle();
    setPickedHandle(null);
    setPickedName('');
    log.info('restore-ui', 'saved folder handle cleared');
    appendLog('Cleared saved folder handle.');
  }, [appendLog]);

  const onConnectDrive = useCallback(async () => {
    setDriveError(null);
    if (!env.googleClientId) {
      setDriveError('Google Drive not configured. Set VITE_GOOGLE_CLIENT_ID and reload.');
      return;
    }
    setDriveConnecting(true);
    try {
      log.info('restore', 'connecting Google Drive (GIS popup)');
      const result = await connectDrive({
        businessId: RESTORE_BUSINESS_ID,
        prompt: 'select_account',
      });
      setDriveConnectedEmail(result.identity.email);
      appendLog(`Google Drive connected as ${result.identity.email}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('restore', 'connectDrive failed', { error: msg });
      setDriveError(msg);
    } finally {
      setDriveConnecting(false);
    }
  }, [appendLog]);

  const runRestore = useCallback(
    async (confirmDataLoss: boolean) => {
      if (!providerConfig) return;
      if (providerKind === 'local-folder' && !pickedHandle) {
        log.warn('restore-ui', 'restore blocked: no local folder selected');
        setError('Choose a folder first.');
        return;
      }
      if (providerKind === 'google-drive' && !driveConnectedEmail) {
        log.warn('restore-ui', 'restore blocked: Google Drive not connected');
        setError('Connect Google Drive first.');
        return;
      }

      const abortController = new AbortController();
      const release = beginAppOperation({
        kind: 'restore',
        label: 'Restore',
        cancelable: true,
        cancel: () => {
          updateAppOperation({ message: 'Cancelling restore…' });
          abortController.abort();
        },
      });
      setStep('connecting');
      setError(null);
      setReport(null);
      setUnshipped(null);
      setProgressPct(0);
      setStatusMessage('Connecting...');
      if (!confirmDataLoss) setLog([]);
      log.info('restore-ui', 'restore started', {
        providerKind,
        confirmDataLoss,
        selectedFolderName: pickedHandle?.name ?? null,
        injectedProvider: Boolean(props.provider),
      });
      appendLog(confirmDataLoss ? 'Restore restarted with data-loss confirmed.' : 'Restore started.');

      let provider: CustomerStorageProvider | null = props.provider ?? null;
      if (!provider) {
        if (providerKind === 'local-folder') {
          provider = new LocalFolderStorageProvider();
        } else if (providerKind === 'google-drive') {
          const api = createDriveApiClient({ businessId: RESTORE_BUSINESS_ID });
          provider = new GoogleDriveStorageProvider({ driveApi: api });
        }
      }

      if (!provider) {
        log.error('restore-ui', 'restore blocked: provider unavailable');
        release();
        setStep('error');
        setError('Provider is not available in this build.');
        return;
      }

      if (providerKind === 'local-folder' && pickedHandle) {
        (provider as LocalFolderStorageProvider).setDirectoryHandle(pickedHandle);
        log.info('restore-ui', 'using selected folder handle', {
          folderName: pickedHandle.name,
        });
        appendLog(`Using handle: ${pickedHandle.name}`);
      }

      try {
        log.info('restore-ui', 'stopping sync worker before restore');
        await stopSyncWorkerAsync();
        log.info('restore-ui', 'calling rebuildFromDrive');
        const result = await rebuildFromDrive(provider, {
          db,
          providerConfig,
          confirmDataLoss,
          onProgress: (msg, pct) => {
            setStatusMessage(msg);
            appendLog(`Progress: ${msg}${pct != null ? ` (${pct}%)` : ''}`);
            if (pct != null) setProgressPct(pct);
            updateAppOperation({ message: msg, progress: pct });
          },
          signal: abortController.signal,
          pickBusiness: async (ctx) => {
            log.info('restore-ui', 'business picker opened', {
              count: ctx.businesses.length,
              businesses: ctx.businesses.map((b) => ({ name: b.businessName, path: b.folderPath })),
            });
            appendLog(`Found ${ctx.businesses.length} businesses: ${ctx.businesses.map((b) => b.businessName).join(', ')}`);
            setBusinesses(ctx.businesses);
            setStep('picking');
            return await new Promise<DiscoveredBusiness>((resolve, reject) => {
              const onAbort = (): void => {
                abortController.signal.removeEventListener('abort', onAbort);
                setPickerResolve(null);
                const error = new Error('Restore cancelled; local data was left unchanged.');
                error.name = 'AbortError';
                reject(error);
              };
              if (abortController.signal.aborted) {
                onAbort();
                return;
              }
              abortController.signal.addEventListener('abort', onAbort, { once: true });
              setPickerResolve(() => (business: DiscoveredBusiness) => {
                abortController.signal.removeEventListener('abort', onAbort);
                log.info('restore-ui', 'business selected', {
                  businessId: business.businessId,
                  businessName: business.businessName,
                  folderPath: business.folderPath,
                });
                resolve(business);
              });
            });
          },
        });
        log.info('restore-ui', 'rebuildFromDrive resolved', {
          businessName: result.businessName,
          eventsReplayed: result.eventsReplayed,
          unhandledEvents: result.unhandledEvents,
          checksumsOk: result.checksumsOk,
          accountingBalanced: result.accountingBalanced,
          inventoryConsistent: result.inventoryConsistent,
          gstReconciled: result.gstReconciled,
        });
        appendLog(`Restore complete. Events replayed: ${result.eventsReplayed}.`);
        setReport(result);
        setStep('done');
        release();
        log.info('restore-ui', 'success state scheduled for render');
      } catch (err) {
        release();
        log.error('restore-ui', 'restore rejected', {
          error: err instanceof Error ? err : String(err),
        });
        await tryBootProvider().catch(() => false);
        if (err instanceof Error && err.name === 'AbortError') {
          log.info('restore-ui', 'restore cancelled state scheduled');
          appendLog('Restore cancelled; local data was left unchanged.');
          setError(err.message);
          setStep('error');
          return;
        }
        if (err instanceof UnshippedEventsError) {
          log.warn('restore-ui', 'restore requires data-loss confirmation', {
            total: err.summary.total,
            businessName: err.summary.businessName,
          });
          appendLog(
            `Refused to overwrite: ${err.summary.total} unshipped event(s) on this device would be lost.`,
          );
          setUnshipped(err.summary);
          setStep('confirm-data-loss');
          return;
        }
        if (err instanceof EmptyBackupError) {
          log.warn('restore-ui', 'restore rejected: empty backup', {
            businessName: err.businessName,
            folderPath: err.folderPath,
          });
          const msg =
            `This backup folder has no data for '${err.businessName}' — ` +
            `nothing to restore. If this is unexpected, check that ` +
            `${err.folderPath}/journal/2026/*.events.jsonl or ` +
            `${err.folderPath}/snapshots/daily/ exists on the provider. ` +
            `Your local data was not touched.`;
          appendLog(`Empty backup: ${err.businessName} (${err.folderPath})`);
          setError(msg);
          setStep('error');
          return;
        }
        const msg = (err as Error).message;
        log.error('restore-ui', 'restore error state scheduled', { message: msg });
        appendLog(`Failed: ${msg}`);
        setError(
          msg ||
            'Restore failed during journal replay. Open the diagnostic log to identify the affected event.',
        );
        setStep('error');
      }
    },
    [db, providerConfig, providerKind, props.provider, pickedHandle, driveConnectedEmail, appendLog],
  );

  const onStart = useCallback(() => runRestore(false), [runRestore]);
  const onConfirmDataLoss = useCallback(() => runRestore(true), [runRestore]);
  const onCancelDataLoss = useCallback(() => {
    setStep('idle');
    setUnshipped(null);
    appendLog('Restore cancelled. Local unshipped data preserved.');
  }, [appendLog]);

  const onReloadRestoredData = useCallback(() => {
    log.info('restore-ui', 'manual reload requested after restore');
    window.location.reload();
  }, []);

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
              <p className="text-sm text-slate-600">
                We use Google Sign-In in a popup. No client secret, no
                redirect URL, no credentials to enter. Scope is fixed to{' '}
                <code>drive.file</code> — we can only see files this app
                created.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onConnectDrive}
                  disabled={driveConnecting}
                  className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {driveConnecting
                    ? 'Opening Google…'
                    : driveConnectedEmail
                      ? 'Reconnect Google Drive'
                      : 'Connect Google Drive'}
                </button>
                {driveConnectedEmail && (
                  <span className="text-sm text-emerald-700">
                    Connected as{' '}
                    <span className="font-medium">{driveConnectedEmail}</span>
                  </span>
                )}
              </div>
              {driveError && (
                <div className="rounded border border-red-300 bg-red-50 text-red-800 p-2 text-sm">
                  {driveError}
                </div>
              )}
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
              (providerKind === 'google-drive' && !driveConnectedEmail)
            }
          >
            Start Restore
          </button>

          {/* Debug-log export — shown pre-onboarding, so restore failures
              can still be diagnosed (Settings' download button is gated
              behind having a business row, which restore-from-scratch
              users don't have yet). */}
          <div className="border-t pt-3 mt-3">
            <p className="text-xs text-slate-600 mb-2">
              Debug: export the local log to share when reporting an issue.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadDebugLogs(1)}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
              >
                Last hour
              </button>
              <button
                type="button"
                onClick={() => downloadDebugLogs(24)}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
              >
                Last 24 hours
              </button>
              <button
                type="button"
                onClick={() => downloadDebugLogs(24 * 7)}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
              >
                Last 7 days
              </button>
            </div>
          </div>
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
              <li>Cancel this restore.</li>
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
              className="action-cancel text-sm font-semibold"
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
                  className="action-restore text-sm font-semibold"
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
                Migrated backup schema v{report.migratedFrom} → v
                {report.schemaVersion}.
              </div>
            )}
            <div className={report.countReconciliation.exact ? 'text-emerald-700' : 'text-rose-700'}>
              Entity counts: {report.countReconciliation.compared
                ? report.countReconciliation.exact
                  ? 'exact match between backup and restored app.'
                  : 'mismatch detected.'
                : 'snapshot counts recorded; journal replay changed the final totals.'}
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-slate-600">Entity count comparison</summary>
              <pre className="mt-1 bg-slate-50 border rounded p-2 whitespace-pre-wrap font-mono text-xs overflow-auto max-h-64">
                {Object.keys(report.counts)
                  .map((store) => `${store}: backup ${report.sourceCounts[store] ?? 0} | restored ${report.counts[store] ?? 0}`)
                  .join('\n')}
              </pre>
            </details>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">
              Full diagnostic report
            </summary>
            <pre className="mt-2 bg-slate-50 border rounded p-3 whitespace-pre-wrap font-mono text-xs overflow-auto max-h-96">
              {renderDiagnosticReport(report.diagnostics)}
            </pre>
          </details>
          <div className="border-t pt-4 flex items-center justify-between gap-3">
            <p className="text-sm text-emerald-700">
              Restore succeeded. Reload to refresh all screens with the restored data.
            </p>
            <button
              type="button"
              onClick={onReloadRestoredData}
              className="shrink-0 rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              Reload restored data
            </button>
          </div>
        </section>
      )}

      {log2.length > 0 && (
        <section className="border rounded-lg p-3 bg-slate-50">
          <div className="text-xs font-medium text-slate-600 mb-1">Diagnostics</div>
          <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap max-h-64 overflow-auto">
            {log2.join('\n')}
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
