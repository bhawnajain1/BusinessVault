import { Link } from 'react-router-dom';
import CloudIndicator from './CloudIndicator';
import ThemeToggle from './theme/ThemeToggle';

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
    <header className="flex items-center justify-between border-b border-border bg-surface px-4 h-12">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-medium text-fg hover:text-fg"
        aria-label="BusinessVault home"
      >
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt=""
          aria-hidden="true"
          className="h-9 w-9 object-contain"
        />
        <span>BusinessVault</span>
      </Link>
      <div className="flex items-center gap-2">
        <span
          className="text-xs text-fg-muted tabular-nums"
          aria-label={`BusinessVault version ${APP_VERSION}`}
          title={`BusinessVault v${APP_VERSION}`}
        >
          v{APP_VERSION}
        </span>
        {FEEDBACK_EMAIL && (
          <a
            href={buildFeedbackHref()}
            className="text-xs border border-border rounded px-2.5 py-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label="Send feedback"
          >
            Feedback
          </a>
        )}
        <CloudIndicator />
        <ThemeToggle />
      </div>
    </header>
  );
}
