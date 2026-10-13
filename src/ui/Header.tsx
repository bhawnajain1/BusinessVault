import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Calendar, ChevronDown, Menu, MessageSquare, Settings, Cloud, RotateCcw } from 'lucide-react';
import CloudIndicator from './CloudIndicator';
import NotificationBell from './notifications/NotificationBell';
import GlobalSearch from './GlobalSearch';
import { db } from '../db';
import { useActiveBusiness } from './hooks/useActiveBusiness';
import { useLiveQuery } from './hooks/useLiveQuery';
import { getConnectedEmail } from '../drive/connectDrive';
import { RANGE_OPTIONS, useDashboardRange, type RangeKey } from './dashboard/dateRange';

// Baked in at build time from the FEEDBACK_EMAIL GitHub Actions secret. Kept
// out of source so scrapers on the public Pages build don't harvest the
// address. Empty in local dev unless a `.env.local` sets VITE_FEEDBACK_EMAIL —
// in that case the Feedback menu item hides itself.
const FEEDBACK_EMAIL = (import.meta.env.VITE_FEEDBACK_EMAIL as string | undefined) ?? '';

// Baked in at build time from package.json — see vite.config.ts.
declare const __APP_VERSION__: string;
const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

function buildFeedbackHref(): string {
  const subject = `BusinessVault feedback`;
  const body = [
    'Please describe what you saw and what you expected:',
    '',
    '',
    '---',
    `App URL: ${window.location.href}`,
    `User agent: ${navigator.userAgent}`,
  ].join('\n');
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'BV';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export default function Header({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const location = useLocation();
  const onOverview = location.pathname === '/';

  return (
    <header className="bv-ui app-header flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="-ml-1 rounded-lg p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 lg:hidden"
        aria-label="Open navigation"
        aria-controls="app-sidebar"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <GlobalSearch />
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {onOverview && <HeaderRangePicker />}
        <span
          className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium tabular-nums text-slate-500 sm:inline"
          aria-label={`BusinessVault version ${APP_VERSION}`}
          title={`BusinessVault v${APP_VERSION}`}
        >
          v{APP_VERSION}
        </span>
        {FEEDBACK_EMAIL && (
          <a
            href={buildFeedbackHref()}
            className="hidden h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 sm:inline-flex"
            aria-label="Send feedback"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            Feedback
          </a>
        )}
        <NotificationBell />
        <CloudIndicator />
        <ProfileMenu />
      </div>
    </header>
  );
}

// Only rendered on the Overview route — the range drives dashboard data and
// nothing else, so showing it on other pages would be a control that does
// nothing.
function HeaderRangePicker() {
  const [range, setRange] = useDashboardRange();
  return (
    <label className="relative hidden items-center md:flex">
      <span className="sr-only">Dashboard date range</span>
      <Calendar className="pointer-events-none absolute left-3 h-4 w-4 text-slate-500" aria-hidden="true" />
      <select
        value={range.key}
        onChange={(e) => setRange(e.target.value as RangeKey)}
        className="h-10 appearance-none rounded-lg border border-slate-200 bg-white pl-9 pr-8 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
      >
        {RANGE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-slate-500" aria-hidden="true" />
    </label>
  );
}

function ProfileMenu() {
  const { businessId } = useActiveBusiness();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const profile = useLiveQuery(async () => {
    if (!businessId) return null;
    const [business, email] = await Promise.all([
      db.businesses.get(businessId),
      getConnectedEmail(businessId).catch(() => null),
    ]);
    return { name: business?.name ?? 'My business', email };
  }, [businessId], null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = profile?.name ?? 'BusinessVault';
  const itemCls =
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-900';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-slate-50"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-indigo-600 text-sm font-semibold text-white" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="hidden max-w-[160px] truncate text-sm font-medium text-slate-800 xl:block">{name}</span>
        <ChevronDown className="hidden h-4 w-4 text-slate-500 sm:block" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          <div className="border-b border-slate-100 px-3 pb-2.5 pt-2">
            <div className="truncate text-sm font-semibold text-slate-900">{name}</div>
            <div className="truncate text-xs text-slate-500">{profile?.email ?? 'Google Drive not connected'}</div>
          </div>
          <div className="py-1">
            <Link role="menuitem" to="/settings" className={itemCls} onClick={() => setOpen(false)}>
              <Settings className="h-4 w-4 text-slate-500" aria-hidden="true" /> Business settings
            </Link>
            <Link role="menuitem" to="/settings/backup" className={itemCls} onClick={() => setOpen(false)}>
              <Cloud className="h-4 w-4 text-slate-500" aria-hidden="true" /> Data & Backup
            </Link>
            <Link role="menuitem" to="/restore" className={itemCls} onClick={() => setOpen(false)}>
              <RotateCcw className="h-4 w-4 text-slate-500" aria-hidden="true" /> Restore from Backup
            </Link>
            {FEEDBACK_EMAIL && (
              <a role="menuitem" href={buildFeedbackHref()} className={itemCls} onClick={() => setOpen(false)}>
                <MessageSquare className="h-4 w-4 text-slate-500" aria-hidden="true" /> Send feedback
              </a>
            )}
          </div>
          <div className="border-t border-slate-100 px-3 pb-1 pt-2 text-xs text-slate-500" aria-label={`BusinessVault version ${APP_VERSION}`}>
            BusinessVault v{APP_VERSION}
          </div>
        </div>
      )}
    </div>
  );
}
