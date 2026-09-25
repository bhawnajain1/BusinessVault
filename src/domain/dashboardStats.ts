// Pure derivation of the dashboard KPI row + Recent Invoices list.
//
// Extracted out of Dashboard.tsx so it can be tested without spinning up
// React / jsdom, and so the "same source" invariant across surfaces
// (dashboard count, invoices page count, receivables report total) is
// pinned by unit tests instead of surviving on discipline alone.
//
// Prior regression this pins down (PR #52): the dashboard used to sum
// `balance_paise` across raw db.invoices, which double-counted rename
// edits (original + auto credit-note + reissue). The fix now derives
// receivables/payables through partyLedger.ts and the invoice count
// through the same filter InvoicesPage uses. See dashboardStats.test.ts
// for the explicit rename-edit reproducer.
//
// This file has NO Dexie dependency — inputs are plain arrays. That's
// what makes it testable and keeps the "boring > clever" rule intact.

import type {
  Advance,
  Customer,
  Invoice,
  Payment,
  Purchase,
  SalesReturn,
  Supplier,
} from '../db/types';
import { computePayables, computeReceivables } from './partyLedger';

// Same predicate InvoicesPage.tsx applies with `showVoided=false`.
// Deliberately does NOT filter status='draft'/'cancelled' — that matches
// InvoicesPage which shows those rows in the list; keeping the dashboard
// aligned with the list is more important than being pedantically strict.
export function isLiveInvoice(inv: Invoice): boolean {
  if (inv.deleted_at) return false;
  if (inv.reverses_invoice_id) return false; // credit note
  if (inv.reversed_by_invoice_id) return false; // superseded original
  return true;
}

// Symmetric to isLiveInvoice for purchases. Purchase has no `deleted_at`
// (no recycle-bin on the purchases side yet — see db/types.ts:354).
export function isLivePurchase(p: Purchase): boolean {
  if (p.status === 'cancelled') return false;
  if (p.reverses_purchase_id) return false; // debit note
  if (p.reversed_by_purchase_id) return false; // superseded original
  if (p.replaced_by_purchase_id) return false; // edited original
  return true;
}

export interface RecentInvoiceRow {
  id: string;
  number: string;
  date: string;
  total_paise: number;
  balance_paise: number;
  customerName: string;
}

export interface DashboardStats {
  invoices: number;
  customers: number;
  suppliers: number;
  items: number;
  purchases: number;
  outstandingReceivablesPaise: number;
  outstandingPayablesPaise: number;
  recentInvoices: RecentInvoiceRow[];
  // Populated for the debug-bundle log line; not rendered in the UI.
  // Lets us diagnose future "count looks off" reports by reading the
  // gap between raw rows and live rows straight out of the JSONL.
  diagnostics: {
    rawInvoiceRows: number;
    supersededInvoices: number;
    creditNotes: number;
    recycledInvoices: number;
    rawPurchaseRows: number;
    supersededPurchases: number;
    debitNotes: number;
  };
  analytics: DashboardAnalytics;
}

export interface DashboardAnalytics {
  monthly: Array<{
    key: string;
    label: string;
    sales_paise: number;
    collections_paise: number;
  }>;
  paymentMix: Array<{ method: string; amount_paise: number }>;
  topCustomers: Array<{ name: string; outstanding_paise: number }>;
}

export interface DashboardInputs {
  invoices: Invoice[];
  purchases: Purchase[];
  customers: Customer[];
  suppliers: Supplier[];
  advances: Advance[];
  salesReturns?: SalesReturn[];
  payments?: Payment[];
  itemCount: number;
  asOfYmd: string;
  recentLimit?: number;
}

export function computeDashboardStats(inputs: DashboardInputs): DashboardStats {
  const {
    invoices,
    purchases,
    customers,
    suppliers,
    advances,
    itemCount,
    asOfYmd,
    recentLimit = 5,
  } = inputs;

  const liveInvoices = invoices.filter(isLiveInvoice);
  const livePurchases = purchases.filter(isLivePurchase);

  // Receivables / payables MUST go through the same computation the
  // /reports/receivables-payables page uses. Anything else is a drift
  // waiting to happen. See dashboardStats.test.ts:"coherence with
  // computeReceivables" for the pin.
  const ar = computeReceivables(
    invoices,
    asOfYmd,
    advances,
    customers,
    inputs.salesReturns ?? [],
  );
  const ap = computePayables(purchases, asOfYmd, advances, suppliers);

  const asOfMonth = asOfYmd.slice(0, 7);
  const monthKeys: string[] = [];
  const monthCursor = new Date(`${asOfMonth}-01T00:00:00Z`);
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(monthCursor);
    date.setUTCMonth(date.getUTCMonth() - i);
    monthKeys.push(date.toISOString().slice(0, 7));
  }
  const monthLabels = new Intl.DateTimeFormat('en', { month: 'short' });
  const monthly = monthKeys.map((key) => {
    const date = new Date(`${key}-01T00:00:00Z`);
    const collections = (inputs.payments ?? []).filter(
      (payment) =>
        payment.direction === 'in' &&
        payment.party_type === 'customer' &&
        !payment.deleted_at &&
        payment.payment_date.startsWith(key),
    );
    return {
      key,
      label: monthLabels.format(date),
      sales_paise: liveInvoices
        .filter((invoice) => invoice.invoice_date.startsWith(key))
        .reduce((sum, invoice) => sum + Math.max(0, invoice.total_paise), 0),
      collections_paise: collections.reduce(
        (sum, payment) => sum + Math.max(0, payment.amount_paise),
        0,
      ),
    };
  });

  const paymentMix = (inputs.payments ?? [])
    .filter(
      (payment) =>
        payment.direction === 'in' && !payment.deleted_at && payment.payment_date <= asOfYmd,
    )
    .reduce((byMethod, payment) => {
      byMethod.set(
        payment.method,
        (byMethod.get(payment.method) ?? 0) + Math.max(0, payment.amount_paise),
      );
      return byMethod;
    }, new Map<string, number>());

  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const recentInvoices: RecentInvoiceRow[] = [...liveInvoices]
    .sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1))
    .slice(0, recentLimit)
    .map((i) => ({
      id: i.id,
      number: i.invoice_number,
      date: i.invoice_date,
      total_paise: i.total_paise,
      balance_paise: i.balance_paise,
      customerName: customerNameById.get(i.customer_id) ?? '—',
    }));

  return {
    invoices: liveInvoices.length,
    customers: customers.length,
    suppliers: suppliers.length,
    items: itemCount,
    purchases: livePurchases.length,
    outstandingReceivablesPaise: ar.totals.outstanding_paise,
    outstandingPayablesPaise: ap.totals.outstanding_paise,
    recentInvoices,
    diagnostics: {
      rawInvoiceRows: invoices.length,
      supersededInvoices: invoices.filter((i) => !!i.reversed_by_invoice_id)
        .length,
      creditNotes: invoices.filter((i) => !!i.reverses_invoice_id).length,
      recycledInvoices: invoices.filter((i) => !!i.deleted_at).length,
      rawPurchaseRows: purchases.length,
      supersededPurchases: purchases.filter((p) => !!p.reversed_by_purchase_id)
        .length,
      debitNotes: purchases.filter((p) => !!p.reverses_purchase_id).length,
    },
    analytics: {
      monthly,
      paymentMix: [...paymentMix.entries()]
        .map(([method, amount_paise]) => ({ method, amount_paise }))
        .sort((a, b) => b.amount_paise - a.amount_paise),
      topCustomers: ar.perCustomer
        .filter((customer) => customer.outstanding_paise > 0)
        .slice(0, 5)
        .map((customer) => ({
          name: customerNameById.get(customer.customer_id) ?? 'Unknown customer',
          outstanding_paise: customer.outstanding_paise,
        })),
    },
  };
}
