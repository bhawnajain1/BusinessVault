import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import AppShell from './ui/AppShell';

const Dashboard = lazy(() => import('./ui/pages/Dashboard'));
const Invoices = lazy(() => import('./ui/pages/Invoices'));
const InvoiceEditor = lazy(() => import('./ui/pos/POSScreen'));
const Customers = lazy(() => import('./ui/pages/Customers'));
const Suppliers = lazy(() => import('./ui/pages/Suppliers'));
const Items = lazy(() => import('./ui/pages/Items'));
const Categories = lazy(() => import('./ui/pages/Categories'));
const Warehouses = lazy(() => import('./ui/pages/Warehouses'));
const StockMovements = lazy(() => import('./ui/pages/StockMovements'));
const Returns = lazy(() => import('./ui/pages/Returns'));
const Purchases = lazy(() => import('./ui/pages/Purchases'));
const PurchaseDetail = lazy(() => import('./ui/purchases/PurchaseDetail'));
const InvoiceDetail = lazy(() => import('./ui/invoices/InvoiceDetail'));
const InvoicePrint = lazy(() => import('./ui/invoices/InvoicePrint'));
const InvoiceForm = lazy(() => import('./ui/invoices/InvoiceForm'));
const DeletedInvoices = lazy(() => import('./ui/invoices/DeletedInvoicesPage'));
const Payments = lazy(() => import('./ui/pages/Payments'));
const Advances = lazy(() => import('./ui/pages/Advances'));
const PartyLedger = lazy(() => import('./ui/parties/PartyLedgerPage'));
const CustomerDetail = lazy(() => import('./ui/customers/CustomerDetailPage'));
const Expenses = lazy(() => import('./ui/pages/Expenses'));
const TrialBalancePage = lazy(() => import('./ui/reports/TrialBalancePage'));
const ProfitLossPage = lazy(() => import('./ui/reports/ProfitLossPage'));
const BalanceSheetPage = lazy(() => import('./ui/reports/BalanceSheetPage'));
const GstSummaryPage = lazy(() => import('./ui/reports/GstSummaryPage'));
const StockValuationPage = lazy(() => import('./ui/reports/StockValuationPage'));
const AuditLogPage = lazy(() => import('./ui/reports/AuditLogPage'));
const ReceivablesPayablesPage = lazy(() => import('./ui/reports/ReceivablesPayablesPage'));
const ReportsIndex = lazy(() => import('./ui/pages/Reports'));
const DataAndBackup = lazy(() => import('./ui/pages/DataAndBackup'));
const Restore = lazy(() => import('./ui/pages/Restore'));
const Settings = lazy(() => import('./ui/pages/Settings'));
const Onboarding = lazy(() => import('./ui/pages/Onboarding'));

export default function App() {
  return (
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
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/backup" element={<DataAndBackup />} />
          <Route path="/restore" element={<Restore />} />
          <Route path="/onboarding" element={<Onboarding />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
