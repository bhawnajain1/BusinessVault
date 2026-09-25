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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="operation-lock-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-6"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <h2 id="operation-lock-title" className="text-lg font-semibold text-slate-900">
          {operation.label} in progress
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Do not navigate, close this tab, or edit business data while this operation is running.
          The current screen is locked to protect your data.
        </p>
        {operation.cancelable ? (
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
        ) : (
          <p className="mt-5 text-sm font-medium text-amber-700">
            Start Fresh cannot be safely cancelled after it begins. Wait for it to finish.
          </p>
        )}
      </div>
    </div>
  );
}
