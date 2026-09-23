import { Link } from 'react-router-dom';
import CloudIndicator from './CloudIndicator';
import NotificationBell from './notifications/NotificationBell';

// Baked in at build time from the FEEDBACK_EMAIL GitHub Actions secret. Kept
// out of source so scrapers on the public Pages build don't harvest the
// address. Empty in local dev unless a `.env.local` sets VITE_FEEDBACK_EMAIL —
// in that case the Feedback button hides itself.
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

export default function Header() {
  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200/80 bg-white/85 px-5 backdrop-blur-xl">
      <Link
        to="/"
        className="flex items-center gap-3 text-sm font-semibold tracking-tight text-slate-900 hover:text-blue-700"
        aria-label="BusinessVault home"
      >
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt=""
          aria-hidden="true"
          className="h-10 w-10 rounded-xl object-contain shadow-sm"
        />
        <span>BusinessVault <span className="ml-1 font-normal text-slate-400">workspace</span></span>
      </Link>
      <div className="flex items-center gap-2">
        <span
          className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500 tabular-nums sm:inline"
          aria-label={`BusinessVault version ${APP_VERSION}`}
          title={`BusinessVault v${APP_VERSION}`}
        >
          v{APP_VERSION}
        </span>
        {FEEDBACK_EMAIL && (
          <a
            href={buildFeedbackHref()}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
            aria-label="Send feedback"
          >
            Feedback
          </a>
        )}
        <NotificationBell />
        <CloudIndicator />
      </div>
    </header>
  );
}
