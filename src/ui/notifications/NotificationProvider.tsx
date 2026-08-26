import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  LOW_STOCK_EVENT_NAME,
  type LowStockPayload,
} from '../../domain/lowStockAlerts';
import { isLowStockAlertsEnabled, isLowStockSoundEnabled } from '../../lib/lowStockPrefs';
import { playLowStockSound } from '../../lib/lowStockSound';
import { log } from '../../lib/log';

// §8 Low-Stock Alerts — notification centre.
//
// Holds an in-memory list of low-stock crossings for THIS tab, listens for
// the CustomEvent fired from lowStockAlerts.ts, plays the beep, and drives
// a transient toast. Deliberately not persisted: browser notifications
// don't survive reloads elsewhere either, and it saves us a schema table +
// migration + backup shape for something that's pure UX. If the user needs
// a durable list of currently-low items, the Reports > Stock Valuation
// page already provides that.
//
// De-dup: successive alerts for the same item within DEDUPE_WINDOW_MS are
// coalesced — a POS invoice with three lines all pulling the same item
// would otherwise trigger three toasts on top of each other. The
// underlying detector already coalesces per-transaction; this window
// covers back-to-back transactions.

const DEDUPE_WINDOW_MS = 3_000;

export interface Notification extends LowStockPayload {
  id: string;
  readAt: string | null;
}

interface Ctx {
  notifications: Notification[];
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
  toast: LowStockPayload | null;
  dismissToast: () => void;
}

const NotificationContext = createContext<Ctx | null>(null);

export function useNotifications(): Ctx {
  const c = useContext(NotificationContext);
  if (!c) throw new Error('useNotifications must be used inside NotificationProvider');
  return c;
}

function makeId(): string {
  // ulid-quality not needed for an ephemeral UI id; keeping it simple.
  return `n_${Math.floor(performance.now() * 1000).toString(36)}_${Math.floor(
    (typeof crypto !== 'undefined' && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint32Array(1))[0]
      : 0) % 1e9,
  ).toString(36)}`;
}

export default function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [toast, setToast] = useState<LowStockPayload | null>(null);
  // Track recent dispatches per item so back-to-back same-item alerts don't
  // stack. Value is the last-fire timestamp; a ref would work but state is
  // fine at these frequencies.
  const [lastFireByItem] = useState<Map<string, number>>(() => new Map());

  const onLowStock = useCallback(
    (evt: Event) => {
      const detail = (evt as CustomEvent<LowStockPayload>).detail;
      if (!detail) return;
      if (!isLowStockAlertsEnabled()) {
        log.info('lowStock', 'alert suppressed: alerts disabled', {
          itemId: detail.itemId,
        });
        return;
      }
      const now = performance.now();
      const key = `${detail.kind}:${detail.itemId}`;
      const last = lastFireByItem.get(key);
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
        log.info('lowStock', 'alert de-duped', {
          itemId: detail.itemId,
          sinceLastMs: Math.round(now - last),
        });
        return;
      }
      lastFireByItem.set(key, now);

      log.info('lowStock', 'alert accepted', {
        kind: detail.kind,
        itemId: detail.itemId,
        itemName: detail.itemName,
      });

      setNotifications((prev) => {
        const next: Notification = { ...detail, id: makeId(), readAt: null };
        // Cap the in-memory list so a runaway inventory dump doesn't grow
        // it unbounded. 200 is well past what a POS session would see.
        const combined = [next, ...prev];
        return combined.length > 200 ? combined.slice(0, 200) : combined;
      });
      // Only crossings pop a toast; "cleared" events land silently in the
      // list — good news, but not deserving of an attention grab.
      if (detail.kind === 'crossed_below') {
        setToast(detail);
        if (isLowStockSoundEnabled()) {
          void playLowStockSound();
        }
      }
    },
    [lastFireByItem],
  );

  useEffect(() => {
    window.addEventListener(LOW_STOCK_EVENT_NAME, onLowStock);
    return () => window.removeEventListener(LOW_STOCK_EVENT_NAME, onLowStock);
  }, [onLowStock]);

  const markAllRead = useCallback(() => {
    const now = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: now })),
    );
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);
  const dismissToast = useCallback(() => setToast(null), []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.readAt === null).length,
    [notifications],
  );

  const value = useMemo<Ctx>(
    () => ({ notifications, unreadCount, markAllRead, clearAll, toast, dismissToast }),
    [notifications, unreadCount, markAllRead, clearAll, toast, dismissToast],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}
