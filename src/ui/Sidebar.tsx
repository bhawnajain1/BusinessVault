import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ to: '/', label: 'Dashboard', end: true }],
  },
  {
    title: 'Sell',
    items: [
      { to: '/pos', label: 'POS' },
      { to: '/invoices', label: 'Invoices' },
      { to: '/invoices/deleted', label: 'Recycle Bin' },
      { to: '/payments', label: 'Payments' },
      { to: '/advances', label: 'Advances' },
      { to: '/returns', label: 'Returns' },
    ],
  },
  {
    title: 'Buy',
    items: [
      { to: '/purchases', label: 'Purchases' },
      { to: '/suppliers', label: 'Suppliers' },
      { to: '/expenses', label: 'Expenses' },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { to: '/items', label: 'Items' },
      { to: '/categories', label: 'Categories' },
      { to: '/warehouses', label: 'Warehouses' },
      { to: '/stock-movements', label: 'Stock Movements' },
    ],
  },
  {
    title: 'Customers',
    items: [{ to: '/customers', label: 'Customers' }],
  },
  {
    title: 'Reports',
    items: [
      { to: '/reports/receivables-payables', label: 'Receivables & Payables' },
      { to: '/reports/trial-balance', label: 'Trial Balance' },
      { to: '/reports/pnl', label: 'P&L' },
      { to: '/reports/balance-sheet', label: 'Balance Sheet' },
      { to: '/reports/gst', label: 'GST Summary' },
    ],
  },
  {
    title: 'Data',
    items: [
      { to: '/settings/backup', label: 'Data & Backup' },
      { to: '/restore', label: 'Restore from Backup' },
    ],
  },
  {
    title: 'Settings',
    items: [{ to: '/settings', label: 'Settings' }],
  },
];

const linkBase =
  'group relative flex items-center rounded-xl px-3 py-2.5 text-[15px] font-semibold text-slate-700 transition-colors hover:bg-blue-50 hover:text-blue-700';
const linkActive = 'bg-blue-50 text-blue-700 shadow-sm';

export default function Sidebar() {
  return (
    <nav
      className="h-full min-h-0 w-60 shrink-0 overflow-y-auto border-r border-slate-200/80 bg-white/70 px-4 py-5 backdrop-blur-xl"
      aria-label="Primary"
    >
      <ul className="space-y-6">
        {SECTIONS.map((section) => (
          <li key={section.title}>
            <div className="mb-2 px-2.5 text-[12px] font-bold uppercase tracking-[0.14em] text-slate-600">
              {section.title}
            </div>
            <ul className="space-y-px">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `${linkBase} ${isActive ? linkActive : ''}`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-blue-600"
                          />
                        )}
                        <span className="ml-1">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
