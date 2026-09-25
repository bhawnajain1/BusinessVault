// Lazy-import wrapper that recovers from stale-chunk-after-deploy errors.
//
// Problem: App.tsx uses React.lazy() for every route. Each Vite build emits
// hash-suffixed chunks (e.g. InvoiceForm-CHaK4dxT.js). A tab held open across
// a deploy has the OLD chunk-name map, so navigating to a not-yet-visited
// route triggers import() → 404 on the old filename → promise rejects →
// React unmounts the Suspense subtree → black page until the user refreshes.
//
// Evidence this actually happens: 2026-08-27 07:05:34 debug bundle
//   {"level":"error","source":"window",
//    "msg":"Uncaught TypeError: Failed to fetch dynamically imported module:
//           https://bhawnajain1.github.io/businessvault-app/assets/InvoiceForm-CHaK4dxT.js"}
//
// Fix: catch the specific "failed to fetch dynamically imported module" /
// ChunkLoadError shape, do a hard reload (which fetches the current
// index.html + its fresh chunk map). Guard with sessionStorage so a genuine
// build corruption doesn't loop forever — after one reload attempt within a
// session, we surface the error instead of reloading again.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { log } from './log';

const RELOAD_FLAG_KEY = 'bv:chunk-reload-attempted';

// The message string varies by browser and by CDN — matching on any of these
// substrings is safer than by error class (Vite's dynamic import doesn't
// always produce a real ChunkLoadError instance).
function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'string'
        ? err
        : String((err as { message?: unknown }).message ?? err);
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Loading chunk') ||
    msg.includes('ChunkLoadError') ||
    // Some browsers use "error loading dynamically imported module"
    msg.includes('error loading dynamically imported module')
  );
}

// The recovery logic split out so it can be unit-tested without React's
// lazy() plumbing. Same shape as the factory lazy() calls: a zero-arg async
// function that resolves to `{ default: Component }` (or rejects, or in the
// reload path returns a never-resolving promise).
export async function loadWithChunkRecovery<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
  label: string | undefined,
  reload: () => void,
): Promise<{ default: T }> {
  try {
    return await loader();
  } catch (err) {
    if (!isChunkLoadError(err)) {
      log.error('chunk-load', 'lazy import failed (non-chunk error)', {
        label,
        error: err instanceof Error ? err : { message: String(err) },
      });
      throw err;
    }

    const alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG_KEY);
    if (alreadyReloaded) {
      // We already tried a reload this session and it still failed. Don't
      // loop — let the ErrorBoundary show the "Something went wrong" panel.
      log.error('chunk-load', 'chunk still missing after reload attempt', {
        label,
        error: err instanceof Error ? err : { message: String(err) },
        reloadFlagSeenAt: alreadyReloaded,
      });
      throw err;
    }

    log.warn('chunk-load', 'stale chunk detected — reloading', {
      label,
      error: err instanceof Error ? err : { message: String(err) },
    });
    sessionStorage.setItem(RELOAD_FLAG_KEY, new Date().toISOString());
    // Flush the log buffer before the browser tears the tab down, so this
    // event actually lands in the debug bundle.
    void log.flush();
    reload();
    // The reload is about to unload the tab, but we still need to return
    // something to satisfy the type. Return a never-resolving promise so
    // React stays in the Suspense fallback until the reload lands.
    return new Promise<never>(() => {
      /* pending forever until reload */
    });
  }
}

export function lazyWithReload<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
  label?: string,
): LazyExoticComponent<T> {
  return lazy(() =>
    loadWithChunkRecovery(loader, label, () => {
      // Hard reload: bypass the bfcache so a fresh index.html is fetched
      // (some browsers serve a stale document from bfcache which just
      // reproduces the same broken chunk map).
      window.location.reload();
    }),
  );
}

// Exposed for tests + for the ErrorBoundary's "chunk error?" branch.
export const _isChunkLoadError = isChunkLoadError;
