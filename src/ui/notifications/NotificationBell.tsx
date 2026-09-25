import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from './NotificationProvider';

// §8 Low-Stock Alerts — the bell in the app header.
//
// Renders a bell icon + unread badge, opens a dropdown showing the last N
// notifications. Click-outside dismisses the dropdown. "Mark all read"
// clears the badge without removing the items. "Clear all" empties the
// list.
//
// Ephemeral list — read-once semantics — nothing here persists. That's a
// deliberate choice, see NotificationProvider.tsx header.

function formatQty(micros: number): string {
  const units = micros / 1_000_000;
  if (Number.isInteger(units)) return units.toString();
  return units.toFixed(3).replace(/\.?0+$/, '');
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationBell() {
  const { notifications, unreadCount, markAllRead, clearAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // When opening, mark all as read after a short delay so the badge
  // visibly decrements while the dropdown animates open — feels less like
  // "your alerts were silently swallowed".
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => markAllRead(), 500);
    return () => window.clearTimeout(id);
  }, [open, markAllRead]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded p-1.5 text-fg-muted hover:bg-surface-hover hover:text-fg"
        aria-label={`Notifications (${unreadCount} unread)`}
        aria-expanded={open}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth="1.75"
          stroke="currentColor"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium text-white tabular-nums"
            aria-hidden="true"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-80 rounded border border-border bg-surface shadow-lg"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
            <span className="font-medium text-fg">Notifications</span>
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="text-fg-muted hover:text-fg"
              >
                Clear all
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-fg-subtle">
                No notifications yet.
              </li>
            )}
            {notifications.map((n) => (
              <li
                key={n.id}
                className="border-b border-border/60 px-3 py-2 last:border-b-0"
              >
                <Link
                  to="/items"
                  onClick={() => setOpen(false)}
                  className="block hover:bg-surface-hover -mx-3 px-3 py-1 rounded"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={
                        n.kind === 'cleared'
                          ? 'mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500'
                          : n.isOutOfStock
                            ? 'mt-1 h-2 w-2 shrink-0 rounded-full bg-danger'
                            : 'mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-500'
                      }
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-fg truncate">
                        {n.kind === 'cleared'
                          ? 'Back in stock'
                          : n.isOutOfStock
                            ? 'Out of stock'
                            : 'Low stock'}
                        : {n.itemName}
                      </div>
                      <div className="text-xs text-fg-muted">
                        {formatQty(n.currentQtyMicros)} {n.unitLabel} remaining
                        {n.kind === 'crossed_below' && (
                          <>
                            {' '}
                            (reorder at {formatQty(n.reorderLevelMicros)}
                            {n.unitLabel ? ` ${n.unitLabel}` : ''})
                          </>
                        )}
                      </div>
                      <div className="text-[11px] text-fg-subtle">
                        {timeAgo(n.occurredAt)}
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
