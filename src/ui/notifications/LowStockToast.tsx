import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from './NotificationProvider';

// §8 Low-Stock Alerts — the transient toast that pops on threshold-cross.
//
// Sits at bottom-right, auto-dismisses after 6 seconds. Click "View Item"
// to jump to the Items list (the item's SKU is shown so the shopkeeper
// can find it). Kept as a single-toast surface (not a stack) because
// consecutive low-stock events are usually about the SAME item — see
// dedupe in NotificationProvider.

const AUTO_DISMISS_MS = 6_000;

function formatQty(micros: number): string {
  const units = micros / 1_000_000;
  if (Number.isInteger(units)) return units.toString();
  return units.toFixed(3).replace(/\.?0+$/, '');
}

export default function LowStockToast() {
  const { toast, dismissToast } = useNotifications();

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(dismissToast, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-80 rounded border border-border bg-surface shadow-lg"
    >
      <div className="flex items-start gap-3 p-3">
        <span
          className={
            toast.isOutOfStock
              ? 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger'
              : 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600'
          }
          aria-hidden="true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M8.485 3.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 3.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              clipRule="evenodd"
            />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg">
            {toast.isOutOfStock ? 'Out of Stock' : 'Low Stock'}
          </div>
          <div className="mt-1 text-sm text-fg-muted">
            <span className="text-fg">{toast.itemName}</span> has{' '}
            {formatQty(toast.currentQtyMicros)} {toast.unitLabel} remaining.
          </div>
          <div className="mt-0.5 text-xs text-fg-subtle">
            Reorder level: {formatQty(toast.reorderLevelMicros)}{' '}
            {toast.unitLabel}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Link
              to="/items"
              onClick={dismissToast}
              className="text-xs rounded border border-border px-2 py-1 text-fg hover:bg-surface-hover"
            >
              View Item
            </Link>
            <button
              type="button"
              onClick={dismissToast}
              className="text-xs text-fg-muted hover:text-fg"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
