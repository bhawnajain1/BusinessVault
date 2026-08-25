import { Outlet } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import StorageBootBanner from './StorageBootBanner';
import { BackupHealthProvider } from './BackupHealthContext';

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

export default function AppShell() {
  return (
    <BackupHealthProvider>
      <style>{PRINT_CSS}</style>
      <div className="app-shell-root flex h-screen flex-col bg-app text-fg">
        <div data-print-hide>
          <Header />
          <StorageBootBanner />
        </div>
        <div className="app-shell-body flex flex-1 overflow-hidden">
          <div data-print-hide>
            <Sidebar />
          </div>
          <main className="app-shell-main flex-1 overflow-y-auto bg-app">
            <Outlet />
          </main>
        </div>
      </div>
    </BackupHealthProvider>
  );
}
