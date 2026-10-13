import { useEffect, useState, type FocusEvent, type MouseEvent } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight,
  Boxes,
  ChartLine,
  ChartPie,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Cloud,
  CreditCard,
  FileClock,
  FileText,
  Landmark,
  Layers,
  LayoutDashboard,
  Package,
  Percent,
  Receipt,
  RotateCcw,
  Scale,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Tags,
  Trash,
  Truck,
  Undo2,
  Users,
  Wallet,
  Warehouse,
  X,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

interface NavSection {
  title: string | null;
  items: NavItem[];
}

// Every route the old sidebar exposed is still here, regrouped to match the
// redesign. `end` on /invoices and /reports keeps their child routes
// (/invoices/deleted, /reports/pnl) from lighting up the parent item.
const SECTIONS: NavSection[] = [
  {
    title: null,
    items: [{ to: '/', label: 'Overview', icon: LayoutDashboard, end: true }],
  },
  {
    title: 'Sales',
    items: [
      { to: '/customers', label: 'Customers', icon: Users },
      { to: '/pos', label: 'POS', icon: ShoppingCart },
      { to: '/invoices', label: 'Invoices', icon: FileText, end: true },
      { to: '/invoices/deleted', label: 'Recycle Bin', icon: Trash },
      { to: '/payments', label: 'Payments', icon: CreditCard },
      { to: '/advances', label: 'Advances', icon: Layers },
      { to: '/returns', label: 'Returns', icon: Undo2 },
    ],
  },
  {
    title: 'Purchase',
    items: [
      { to: '/purchases', label: 'Purchases', icon: ShoppingBag },
      { to: '/suppliers', label: 'Suppliers', icon: Truck },
      { to: '/expenses', label: 'Expenses', icon: Receipt },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { to: '/items', label: 'Items', icon: Package },
      { to: '/categories', label: 'Categories', icon: Tags },
      { to: '/warehouses', label: 'Warehouses', icon: Warehouse },
      { to: '/stock-movements', label: 'Stock Movements', icon: ArrowLeftRight },
    ],
  },
  {
    title: 'Reports',
    items: [
      { to: '/reports', label: 'All Reports', icon: ClipboardList, end: true },
      { to: '/reports/receivables-payables', label: 'Receivables & Payables', icon: Wallet },
      { to: '/reports/trial-balance', label: 'Trial Balance', icon: Scale },
      { to: '/reports/pnl', label: 'P&L', icon: ChartPie },
      { to: '/reports/sales-purchases', label: 'Sales & Purchases', icon: ChartLine },
      { to: '/reports/balance-sheet', label: 'Balance Sheet', icon: Landmark },
      { to: '/reports/gst', label: 'GST Summary', icon: Percent },
      { to: '/reports/stock-valuation', label: 'Stock Valuation', icon: Boxes },
      { to: '/reports/audit-log', label: 'Audit Log', icon: FileClock },
    ],
  },
  {
    title: 'Data',
    items: [
      { to: '/settings/backup', label: 'Data & Backup', icon: Cloud },
      { to: '/restore', label: 'Restore from Backup', icon: RotateCcw },
    ],
  },
  {
    title: 'Settings',
    items: [{ to: '/settings', label: 'Settings', icon: Settings, end: true }],
  },
];

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

// Desktop (lg+): static column, 256px or 72px when collapsed. Collapsed
// labels stay in the DOM as sr-only text so screen readers still get the
// link name, and a CSS tooltip shows on hover / keyboard focus.
// Mobile (<lg): off-canvas drawer opened from the header menu button;
// closes on navigation, Escape, or a tap on the scrim.
export default function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const location = useLocation();

  useEffect(() => {
    onCloseMobile();
    // Close the mobile drawer whenever the route changes.
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  // On mobile the drawer always shows full labels.
  const narrow = collapsed && !mobileOpen;

  // Collapsed-mode tooltip. Rendered once with position:fixed because the
  // scrolling <nav> would clip an absolutely positioned child.
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const showTip = (label: string) => (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    if (!narrow) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTip({ label, top: rect.top + rect.height / 2 });
  };
  const hideTip = () => setTip(null);

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-200/60 backdrop-blur-sm lg:hidden"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}
      <aside
        id="app-sidebar"
        className={`bv-ui app-sidebar fixed inset-y-0 left-0 z-50 flex h-full flex-col border-r border-slate-200 bg-white transition-[width,transform] duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full'
        } ${narrow ? 'w-[72px]' : 'w-64'}`}
        aria-label="Sidebar"
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-slate-200 ${narrow ? 'justify-center px-2' : 'justify-between px-5'}`}>
          <Link
            to="/"
            className="flex min-w-0 items-center gap-2.5 rounded-lg text-slate-900"
            aria-label="BusinessVault home"
          >
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt=""
              aria-hidden="true"
              className="h-9 w-9 shrink-0 rounded-lg object-contain"
            />
            {!narrow && (
              <span className="truncate text-[17px] font-bold tracking-tight">
                BusinessVault <span className="ml-0.5 text-xs font-normal text-slate-500">workspace</span>
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={onCloseMobile}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4" aria-label="Primary">
          <ul className="space-y-5">
            {SECTIONS.map((section) => (
              <li key={section.title ?? 'overview'}>
                {section.title &&
                  (narrow ? (
                    <div className="mx-3 mb-2 border-t border-slate-200" aria-hidden="true" />
                  ) : (
                    <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                      {section.title}
                    </div>
                  ))}
                <ul className="space-y-0.5">
                  {section.items.map((item) => (
                    <li key={item.to}>
                      <SidebarLink item={item} narrow={narrow} onShowTip={showTip(item.label)} onHideTip={hideTip} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden shrink-0 border-t border-slate-200 p-3 lg:block">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={`flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 ${narrow ? 'justify-center' : ''}`}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" aria-hidden="true" />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>
      {narrow && tip && (
        <div
          className="pointer-events-none fixed left-[80px] z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-md"
          style={{ top: tip.top }}
          aria-hidden="true"
        >
          {tip.label}
        </div>
      )}
    </>
  );
}

function SidebarLink({
  item,
  narrow,
  onShowTip,
  onHideTip,
}: {
  item: NavItem;
  narrow: boolean;
  onShowTip: (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => void;
  onHideTip: () => void;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onMouseEnter={onShowTip}
      onMouseLeave={onHideTip}
      onFocus={onShowTip}
      onBlur={onHideTip}
      className={({ isActive }) =>
        `group relative flex h-9 items-center gap-3 rounded-lg text-[14px] font-medium transition-colors ${
          narrow ? 'justify-center px-0' : 'px-3'
        } ${
          isActive
            ? 'bg-indigo-50 text-indigo-700'
            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-indigo-600' : 'text-slate-500 group-hover:text-slate-700'}`}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className={narrow ? 'sr-only' : 'truncate'}>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}
