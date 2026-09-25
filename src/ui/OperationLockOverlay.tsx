import { useEffect } from 'react';
import { installOperationUnloadGuard, useAppOperation } from '../lib/operationLock';

export default function OperationLockOverlay() {
  const operation = useAppOperation();

  useEffect(() => installOperationUnloadGuard(), []);

  useEffect(() => {
    if (!operation) return;
    const restoreCurrentRoute = (): void => {
      window.history.pushState({ operationLock: true }, '', window.location.href);
      const leave = window.confirm(
        `Cancel ${operation.label.toLowerCase()} and leave this screen? Any unfinished work will be rolled back.`,
      );
      if (leave) operation.cancel();
    };
    window.history.pushState({ operationLock: true }, '', window.location.href);
    window.addEventListener('popstate', restoreCurrentRoute);
    return () => window.removeEventListener('popstate', restoreCurrentRoute);
  }, [operation]);

  if (!operation) return null;

  const isRestore = operation.kind === 'restore';
  const isBackup = operation.kind === 'backup';
  const progress = operation.progress ?? 0;
  const message = operation.message ?? (isRestore ? 'Preparing restore' : 'Preparing backup');
  const steps = isRestore
    ? ['Connected to backup provider', 'Found backup businesses', 'Rebuilding and verifying local database']
    : ['Connected to backup provider', 'Prepared backup files', 'Writing backup files'];
  const activeStep = progress >= 60 ? 2 : progress >= 20 ? 1 : 0;
  const safetyMessage = isBackup
    ? 'Do not close this tab or change business data until the backup finishes.'
    : operation.kind === 'start-fresh'
      ? 'Start Fresh cannot be safely cancelled after it begins. Wait for it to finish.'
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="operation-lock-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-6"
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="p-6">
        <h2 id="operation-lock-title" className="text-lg font-semibold text-slate-900">
          {isRestore ? 'Restoring backup' : isBackup ? 'Backing up your data' : `${operation.label} in progress`}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {isRestore
            ? 'Please keep this tab open while we rebuild your local database.'
            : isBackup
              ? 'Please keep this tab open while we safely write your backup files.'
              : 'Do not navigate, close this tab, or edit business data while this operation is running. The current screen is locked to protect your data.'}
        </p>
        {(isRestore || isBackup) && (
          <>
            <div className="mt-5 rounded-lg bg-slate-50 p-4">
              <div className="flex items-center justify-between text-sm font-semibold text-slate-900">
                <span>{message}</span>
                <span>{progress}%</span>
              </div>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-label={isRestore ? 'Restore progress' : 'Backup progress'}
              >
                <div className="h-full rounded-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="mt-5 space-y-3 border-t border-slate-200 pt-4" aria-live="polite">
              {steps.map((step, index) => (
                <div key={step} className={`flex items-center gap-3 text-sm ${index === activeStep ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${index < activeStep ? 'bg-emerald-600 text-white' : index === activeStep ? 'border-4 border-blue-200 bg-white text-blue-600' : 'border border-slate-300 bg-white text-slate-400'}`} aria-hidden="true">
                    {index < activeStep ? '✓' : index + 1}
                  </span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              <span aria-hidden="true" className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 font-semibold text-white">i</span>
              The backup files will not be changed.
            </div>
          </>
        )}
        {operation.cancelable && !isRestore ? (
          <button
            type="button"
            className="mt-5 rounded-md border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
            onClick={() => {
              if (window.confirm(`Cancel ${operation.label.toLowerCase()}? Any unfinished work will be rolled back.`)) {
                operation.cancel();
              }
            }}
          >
            Cancel operation and leave
          </button>
        ) : safetyMessage ? (
          <p className="mt-5 text-sm font-medium text-amber-700">
            {safetyMessage}
          </p>
        ) : null}
        </div>
        {isRestore && operation.cancelable && (
          <div className="border-t border-slate-200 bg-white px-6 py-4 text-right">
            <button
              type="button"
              className="rounded-md border border-red-400 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              onClick={() => {
                if (window.confirm('Cancel restore and leave? Any unfinished restore work will be rolled back.')) operation.cancel();
              }}
            >
              Cancel restore and leave
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
