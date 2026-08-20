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
  'group relative flex items-center rounded-md px-2.5 py-1 text-[13px] text-fg-muted hover:bg-surface-hover hover:text-fg transition-colors';
const linkActive = 'bg-surface-hover text-fg font-medium';

export default function Sidebar() {
  return (
    <nav
      className="w-56 shrink-0 border-r border-border bg-app px-3 py-4 overflow-y-auto"
      aria-label="Primary"
    >
      <ul className="space-y-4">
        {SECTIONS.map((section) => (
          <li key={section.title}>
            <div className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
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
                            className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r bg-fg"
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
