import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import StorageBootBanner from './StorageBootBanner';
import { BackupHealthProvider } from './BackupHealthContext';
import NotificationProvider from './notifications/NotificationProvider';
import LowStockToast from './notifications/LowStockToast';
import { useActiveBusiness } from './hooks/useActiveBusiness';
import { runLegacyMigrationsForBusiness } from '../boot/runLegacyMigrations';
import { log } from '../lib/log';
import OperationLockOverlay from './OperationLockOverlay';

// When the user prints (window.print() from InvoicePrint, browser print
// dialog, or "Save as PDF") we want ONLY the invoice pane on paper — no
// header, no sidebar, no storage banner, no scroll containers. Without
// these overrides the printer captures the full app viewport (Header +
// Sidebar + content), which is what "distorted invoice PDF" reports mean.
//
// Anchored on data-print-hide attributes rather than element names so
// the rule keeps working if layout components are renamed later.
const PRINT_CSS = `
@media print {
  [data-print-hide] { display: none !important; }
  html, body, #root { height: auto !important; overflow: visible !important; background: #fff !important; }
  .app-shell-root { height: auto !important; overflow: visible !important; display: block !important; background: #fff !important; }
  .app-shell-body { height: auto !important; overflow: visible !important; display: block !important; }
  .app-shell-main { overflow: visible !important; width: 100% !important; max-width: 100% !important; padding: 0 !important; }
}
`;

const SIDEBAR_COLLAPSED_KEY = 'bv-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export default function AppShell() {
  const { businessId } = useActiveBusiness();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // private mode / storage full: collapse still works for this session
      }
      log.info('shell', 'sidebar collapse toggled', { collapsed: next });
      return next;
    });
  }, []);

  // Fire the legacy-reversal migration exactly once per (businessId) after the
  // active business resolves. Idempotent both in-memory (via the module's
  // IN_FLIGHT map) and in-DB (kv marker + per-CN audit rows), so even React 18
  // strict-mode double-mount doesn't cause double-work.
  useEffect(() => {
    if (!businessId) return;
    log.info('boot', 'kicking off legacy migrations for active business', {
      businessId,
    });
    void runLegacyMigrationsForBusiness(businessId);
  }, [businessId]);

  return (
    <BackupHealthProvider>
      <NotificationProvider>
        <style>{PRINT_CSS}</style>
        <div className="app-shell-root flex h-screen bg-app text-fg">
          <div data-print-hide className="h-full min-h-0 lg:shrink-0">
            <Sidebar
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              mobileOpen={mobileNavOpen}
              onCloseMobile={closeMobileNav}
            />
          </div>
          <div className="app-shell-body flex min-w-0 flex-1 flex-col overflow-hidden">
            <div data-print-hide>
              <Header onOpenMobileNav={() => setMobileNavOpen(true)} />
              <StorageBootBanner />
            </div>
            <main className="app-shell-main min-w-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </div>
        <div data-print-hide>
          <LowStockToast />
        </div>
        <OperationLockOverlay />
      </NotificationProvider>
    </BackupHealthProvider>
  );
}
