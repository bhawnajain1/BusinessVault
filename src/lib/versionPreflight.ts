// Preflight version check — fetches index.html on tab wake / periodic tick
// and reloads if the deployed entry-bundle hash no longer matches the one we
// booted with. This preempts the stale-chunk-after-deploy failure BEFORE the
// user clicks a link that triggers a 404-ing dynamic import.
//
// Complements src/lib/lazyWithReload.ts (which self-heals AFTER the failure):
// preflight = proactive; lazyWithReload = reactive fallback.
//
// Why compare the entry-bundle hash instead of a build-id header?
// Vite emits a hash-suffixed entry chunk into index.html:
//   <script type="module" src="/businessvault-app/assets/index-C_crfPiU.js">
// The hash rotates on every content change, so extracting it from the live
// index.html gives us a version fingerprint without any server-side support.
// GitHub Pages is a static host — no headers we control, no /version endpoint.
//
// When we check:
//   1) On `visibilitychange` -> visible. Covers the common case: user
//      switched tabs, we deployed, user comes back. This is when the
//      original bug hit — tab held open for 30 minutes across a deploy.
//   2) Every 5 minutes while the tab is visible. Belt for users who leave
//      the tab foregrounded and never switch away.
//   3) On `online`. Recovering from an offline gap often coincides with a
//      deploy having landed.
//
// Guards:
//   - Only reload if the user is idle-ish (no unsaved-changes gating here —
//     the app is IndexedDB-first, every mutation persists synchronously, so
//     there is nothing in-flight to lose). But we skip the reload when the
//     path is `/pos` or `/invoices/*/edit` or `/invoices/new` — those are
//     interactive forms with in-memory line-item state that hasn't been
//     committed yet. On those routes, we log and defer; the next navigation
//     will trip lazyWithReload (or the next preflight, once the user leaves
//     the form).
//   - Only reload once per session per detected version. The `sessionStorage`
//     flag `bv:preflight-reloaded-to` records the target hash so we don't
//     bounce if the fetch briefly serves a stale/CDN-inconsistent index.
//   - Network failures are silent — we can't distinguish "user is offline"
//     from "Pages is having a bad time"; either way, no reload.

import { log } from './log';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const RELOADED_TO_KEY = 'bv:preflight-reloaded-to';

// Routes with unsaved in-memory state — defer reload until user leaves.
const UNSAFE_PATH_PATTERNS: RegExp[] = [
  /\/pos$/,
  /\/invoices\/new$/,
  /\/invoices\/[^/]+\/edit$/,
  /\/purchases\/new$/,
  /\/onboarding$/,
];

let bootHash: string | null = null;
let indexUrl: string | null = null;
let started = false;
let inFlight = false;

// Extract the hashed entry-bundle filename from an index.html document.
// The Vite template emits exactly one `<script type="module" ... src="...">`
// pointing at `assets/index-<hash>.js`. We normalize to just the
// `assets/index-<hash>.js` suffix — same shape whether the deploy sits at
// the domain root or under a subpath like `/businessvault-app/`, so the
// fingerprint compares consistently against the boot hash we extract from
// the live document.
export function extractEntryHash(html: string): string | null {
  // Look for a type=module script tag anywhere, then pull the assets suffix.
  const scriptMatch = html.match(
    /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/,
  );
  if (!scriptMatch) return null;
  const suffix = scriptMatch[1].match(/assets\/index-[A-Za-z0-9_-]+\.js$/);
  return suffix ? suffix[0] : null;
}

function currentPathIsUnsafe(): boolean {
  const path = window.location.pathname;
  return UNSAFE_PATH_PATTERNS.some((re) => re.test(path));
}

async function fetchDeployedHash(): Promise<string | null> {
  if (!indexUrl) return null;
  // `cache: 'no-store'` bypasses HTTP cache; the `?_=` cachebuster defends
  // against intermediary caches (some corporate proxies ignore no-store).
  const bust = `${indexUrl}${indexUrl.includes('?') ? '&' : '?'}_=${encodeURIComponent(new Date().toISOString())}`;
  const res = await fetch(bust, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) return null;
  const text = await res.text();
  return extractEntryHash(text);
}

async function check(reason: string): Promise<void> {
  if (inFlight || !bootHash) return;
  inFlight = true;
  try {
    const deployedHash = await fetchDeployedHash();
    if (!deployedHash) {
      // Silent — network hiccup or unexpected HTML shape. Don't spam logs.
      return;
    }
    if (deployedHash === bootHash) return;

    const alreadyReloadedTo = sessionStorage.getItem(RELOADED_TO_KEY);
    if (alreadyReloadedTo === deployedHash) {
      // We already tried to reload to this exact hash this session and
      // still ended up on a different one — CDN inconsistency; leave it.
      log.warn('preflight', 'version differs but already reloaded to target', {
        reason,
        bootHash,
        deployedHash,
        alreadyReloadedTo,
      });
      return;
    }

    if (currentPathIsUnsafe()) {
      log.info('preflight', 'new version detected but deferring — unsafe path', {
        reason,
        bootHash,
        deployedHash,
        path: window.location.pathname,
      });
      return;
    }

    log.warn('preflight', 'new version deployed — reloading', {
      reason,
      bootHash,
      deployedHash,
    });
    sessionStorage.setItem(RELOADED_TO_KEY, deployedHash);
    void log.flush();
    window.location.reload();
  } catch (err) {
    // Network / DNS / offline — expected, ignore.
    log.info('preflight', 'version check failed (network)', {
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight = false;
  }
}

// Kick off the preflight loop. Idempotent — calling twice is a no-op.
// Called once from main.tsx on app boot. Grabs the current entry-hash from
// the live document so we have a fingerprint to compare against.
export function installVersionPreflight(): void {
  if (started) return;
  started = true;

  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="assets/index-"]',
  );
  if (!script?.src) {
    // Dev mode or unexpected DOM — nothing to compare, bail.
    log.info('preflight', 'no entry-bundle script found — preflight disabled', null);
    return;
  }

  const src = script.src;
  const m = src.match(/(assets\/index-[A-Za-z0-9_-]+\.js)/);
  if (!m) {
    log.info('preflight', 'entry-bundle src has unexpected shape — preflight disabled', {
      src,
    });
    return;
  }
  bootHash = m[1];
  // Resolve index.html relative to the entry script (handles subpath deploys
  // like /businessvault-app/ on GitHub Pages).
  indexUrl = new URL('../index.html', src).toString();

  log.info('preflight', 'installed', { bootHash, indexUrl });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void check('visibilitychange');
    }
  });
  window.addEventListener('online', () => void check('online'));
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void check('interval');
  }, CHECK_INTERVAL_MS);
}

// Test hooks — reset module state between tests.
export const _resetForTest = (): void => {
  bootHash = null;
  indexUrl = null;
  started = false;
  inFlight = false;
};
