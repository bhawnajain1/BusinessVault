import { Link } from 'react-router-dom';

const REPORTS: ReadonlyArray<{ to: string; title: string; blurb: string }> = [
  {
    to: '/reports/trial-balance',
    title: 'Trial Balance',
    blurb: 'Every account, debit vs credit, snapshot balanced to the paise.',
  },
  {
    to: '/reports/pnl',
    title: 'Profit & Loss',
    blurb: 'Income minus expenses for the selected period.',
  },
  {
    to: '/reports/balance-sheet',
    title: 'Balance Sheet',
    blurb: 'Assets, liabilities, equity — as of a date.',
  },
  {
    to: '/reports/gst',
    title: 'GST Summary',
    blurb: 'GSTR-1 / GSTR-3B style rollup: output / input, intra vs inter.',
  },
  {
    to: '/reports/stock-valuation',
    title: 'Stock Valuation',
    blurb: 'On-hand quantity and value, per item.',
  },
  {
    to: '/reports/audit-log',
    title: 'Audit Log',
    blurb: 'Immutable event journal — every change, hash-chained.',
  },
  {
    to: '/reports/receivables-payables',
    title: 'Receivables & Payables',
    blurb: 'Open balances by customer and supplier — who owes you, who you owe.',
  },
  {
    to: '/reports/sales-returns',
    title: 'Sales Returns',
    blurb: 'Returns register with roll-ups by reason and by customer.',
  },
];

export default function ReportsIndex() {
  return (
    <div className="p-6 flex flex-col gap-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Reports</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {REPORTS.map((r) => (
          <Link
            key={r.to}
            to={r.to}
            className="block border border-slate-200 rounded p-4 bg-white hover:border-slate-400 hover:shadow-sm transition"
          >
            <div className="font-medium text-slate-900">{r.title}</div>
            <div className="text-sm text-slate-600 mt-1">{r.blurb}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
