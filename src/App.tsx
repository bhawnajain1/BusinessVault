import { Routes, Route, Navigate } from 'react-router-dom';
import { Suspense } from 'react';
import AppShell from './ui/AppShell';
import ErrorBoundary from './ui/ErrorBoundary';
import { lazyWithReload } from './lib/lazyWithReload';

// All routes use lazyWithReload (not React.lazy) so a stale chunk after a
// deploy self-heals via one reload instead of surfacing as a black page.
// The `label` is emitted into the chunk-load debug log so we can tell
// which route was navigating when the failure hit.
const Dashboard = lazyWithReload(() => import('./ui/pages/Dashboard'), 'Dashboard');
const Invoices = lazyWithReload(() => import('./ui/pages/Invoices'), 'Invoices');
const InvoiceEditor = lazyWithReload(() => import('./ui/pos/POSScreen'), 'POSScreen');
const Customers = lazyWithReload(() => import('./ui/pages/Customers'), 'Customers');
const Suppliers = lazyWithReload(() => import('./ui/pages/Suppliers'), 'Suppliers');
const Items = lazyWithReload(() => import('./ui/pages/Items'), 'Items');
const Categories = lazyWithReload(() => import('./ui/pages/Categories'), 'Categories');
const Warehouses = lazyWithReload(() => import('./ui/pages/Warehouses'), 'Warehouses');
const StockMovements = lazyWithReload(() => import('./ui/pages/StockMovements'), 'StockMovements');
const Returns = lazyWithReload(() => import('./ui/pages/Returns'), 'Returns');
const SalesReturnDetail = lazyWithReload(() => import('./ui/returns/SalesReturnDetail'), 'SalesReturnDetail');
const Purchases = lazyWithReload(() => import('./ui/pages/Purchases'), 'Purchases');
const PurchaseDetail = lazyWithReload(() => import('./ui/purchases/PurchaseDetail'), 'PurchaseDetail');
const InvoiceDetail = lazyWithReload(() => import('./ui/invoices/InvoiceDetail'), 'InvoiceDetail');
const InvoicePrint = lazyWithReload(() => import('./ui/invoices/InvoicePrint'), 'InvoicePrint');
const InvoiceForm = lazyWithReload(() => import('./ui/invoices/InvoiceForm'), 'InvoiceForm');
const DeletedInvoices = lazyWithReload(() => import('./ui/invoices/DeletedInvoicesPage'), 'DeletedInvoicesPage');
const Payments = lazyWithReload(() => import('./ui/pages/Payments'), 'Payments');
const Advances = lazyWithReload(() => import('./ui/pages/Advances'), 'Advances');
const PartyLedger = lazyWithReload(() => import('./ui/parties/PartyLedgerPage'), 'PartyLedgerPage');
const CustomerDetail = lazyWithReload(() => import('./ui/customers/CustomerDetailPage'), 'CustomerDetailPage');
const Expenses = lazyWithReload(() => import('./ui/pages/Expenses'), 'Expenses');
const TrialBalancePage = lazyWithReload(() => import('./ui/reports/TrialBalancePage'), 'TrialBalancePage');
const ProfitLossPage = lazyWithReload(() => import('./ui/reports/ProfitLossPage'), 'ProfitLossPage');
const BalanceSheetPage = lazyWithReload(() => import('./ui/reports/BalanceSheetPage'), 'BalanceSheetPage');
const GstSummaryPage = lazyWithReload(() => import('./ui/reports/GstSummaryPage'), 'GstSummaryPage');
const StockValuationPage = lazyWithReload(() => import('./ui/reports/StockValuationPage'), 'StockValuationPage');
const AuditLogPage = lazyWithReload(() => import('./ui/reports/AuditLogPage'), 'AuditLogPage');
const ReceivablesPayablesPage = lazyWithReload(() => import('./ui/reports/ReceivablesPayablesPage'), 'ReceivablesPayablesPage');
const SalesReturnsReportPage = lazyWithReload(() => import('./ui/reports/SalesReturnsReportPage'), 'SalesReturnsReportPage');
const ReportsIndex = lazyWithReload(() => import('./ui/pages/Reports'), 'Reports');
const DataAndBackup = lazyWithReload(() => import('./ui/pages/DataAndBackup'), 'DataAndBackup');
const Restore = lazyWithReload(() => import('./ui/pages/Restore'), 'Restore');
const Settings = lazyWithReload(() => import('./ui/pages/Settings'), 'Settings');
const Onboarding = lazyWithReload(() => import('./ui/pages/Onboarding'), 'Onboarding');

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="p-6 text-slate-500">Loading...</div>}>
        <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pos" element={<InvoiceEditor />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/new" element={<InvoiceForm />} />
          <Route path="/invoices/quick" element={<InvoiceEditor />} />
          <Route path="/invoices/deleted" element={<DeletedInvoices />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/invoices/:id/edit" element={<InvoiceForm />} />
          <Route path="/invoices/:id/print" element={<InvoicePrint />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route
            path="/parties/:partyType/:id/ledger"
            element={<PartyLedger />}
          />
          <Route path="/items" element={<Items />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/warehouses" element={<Warehouses />} />
          <Route path="/stock-movements" element={<StockMovements />} />
          <Route path="/returns" element={<Returns />} />
          <Route path="/returns/:id" element={<SalesReturnDetail />} />
          <Route path="/purchases" element={<Purchases />} />
          <Route path="/purchases/:id" element={<PurchaseDetail />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/advances" element={<Advances />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/accounting" element={<TrialBalancePage />} />
          <Route path="/gst" element={<GstSummaryPage />} />
          <Route path="/reports" element={<ReportsIndex />} />
          <Route path="/reports/trial-balance" element={<TrialBalancePage />} />
          <Route path="/reports/pnl" element={<ProfitLossPage />} />
          <Route path="/reports/balance-sheet" element={<BalanceSheetPage />} />
          <Route path="/reports/gst" element={<GstSummaryPage />} />
          <Route path="/reports/stock-valuation" element={<StockValuationPage />} />
          <Route path="/reports/audit-log" element={<AuditLogPage />} />
          <Route path="/reports/receivables-payables" element={<ReceivablesPayablesPage />} />
          <Route path="/reports/sales-returns" element={<SalesReturnsReportPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/backup" element={<DataAndBackup />} />
          <Route path="/restore" element={<Restore />} />
          <Route path="/onboarding" element={<Onboarding />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
