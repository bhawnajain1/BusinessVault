// Unit tests for the version-preflight reloader.
//
// The module has two testable seams:
//   - extractEntryHash(html): pure — full coverage without any mocks.
//   - install + check: exercised end-to-end by mocking fetch, sessionStorage,
//     window.location.reload, and document.querySelector.
//
// We can't directly test the visibilitychange handler firing (jsdom's
// document.visibilityState is read-only in some versions), so we test the
// check() path by triggering the exact event listener installVersionPreflight
// registers. The reload decision — hash comparison, unsafe-path check,
// already-reloaded guard, network failure — is all in check(), so covering
// check() covers what matters.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  extractEntryHash,
  installVersionPreflight,
  _resetForTest,
} from './versionPreflight';

const RELOADED_TO_KEY = 'bv:preflight-reloaded-to';
const OLD_HASH = 'assets/index-OLDHASH1.js';
const NEW_HASH = 'assets/index-NEWHASH2.js';

function makeIndexHtml(entryPath: string): string {
  return `<!doctype html><html><head>
    <title>BV</title>
    <script type="module" crossorigin src="/businessvault-app/${entryPath}"></script>
    <link rel="stylesheet" href="/businessvault-app/assets/index-DIeM6tUD.css">
  </head><body><div id="root"></div></body></html>`;
}

function seedBootScript(hashPath: string): void {
  document.head.innerHTML = `
    <script type="module" crossorigin src="https://bhawnajain1.github.io/businessvault-app/${hashPath}"></script>
  `;
}

describe('extractEntryHash', () => {
  it('extracts the Vite entry-bundle path from the deployed index.html shape', () => {
    const html = makeIndexHtml(OLD_HASH);
    expect(extractEntryHash(html)).toBe(OLD_HASH);
  });

  it('handles single-quoted attributes', () => {
    const html = `<script type='module' src='/x/assets/index-abc123.js'></script>`;
    expect(extractEntryHash(html)).toBe('assets/index-abc123.js');
  });

  it('handles crossorigin and extra attributes in any order', () => {
    const html = `<script async crossorigin type="module" defer src="/x/assets/index-XyZ_9-Aa.js"></script>`;
    expect(extractEntryHash(html)).toBe('assets/index-XyZ_9-Aa.js');
  });

  it('returns null when no entry-bundle script is present', () => {
    expect(extractEntryHash('<html><head></head><body></body></html>')).toBeNull();
  });

  it('returns null on a random non-Vite script tag', () => {
    expect(
      extractEntryHash(
        '<script type="module" src="/x/assets/some-other-CHUNK.js"></script>',
      ),
    ).toBeNull();
  });

  it('ignores non-module script tags', () => {
    // A classic script tag pointing at the assets folder should NOT match —
    // Vite's entry script is always type=module.
    const html = `<script src="/x/assets/index-abc.js"></script>`;
    expect(extractEntryHash(html)).toBeNull();
  });
});

describe('installVersionPreflight + check flow', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let visibilityListener: (() => void) | null;

  beforeEach(() => {
    _resetForTest();
    sessionStorage.clear();
    document.head.innerHTML = '';
    visibilityListener = null;

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    reloadSpy = vi.fn();
    // window.location.reload is not writable in jsdom — replace the whole
    // location with a stub. Grug: use defineProperty because the real
    // location object won't accept property assignment.
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        pathname: '/businessvault-app/',
        reload: reloadSpy,
      },
    });

    // Capture the visibilitychange listener the module registers so we can
    // fire it directly without depending on jsdom's visibility simulation.
    const origAddEvent = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((event, fn) => {
      if (event === 'visibilitychange') {
        visibilityListener = fn as () => void;
      }
      origAddEvent(event, fn as EventListener);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
  }

  it('is a no-op if there is no entry-bundle script in the document', () => {
    installVersionPreflight();
    // No script seeded → module bails, no listener registered.
    expect(visibilityListener).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('registers a visibilitychange listener when the entry script is present', () => {
    seedBootScript(OLD_HASH);
    installVersionPreflight();
    expect(visibilityListener).toBeInstanceOf(Function);
  });

  it('is idempotent — installing twice registers listeners once', () => {
    seedBootScript(OLD_HASH);
    const addSpy = vi.spyOn(document, 'addEventListener');
    installVersionPreflight();
    installVersionPreflight();
    const visCalls = addSpy.mock.calls.filter(
      ([evt]) => evt === 'visibilitychange',
    );
    expect(visCalls.length).toBe(1);
  });

  it('does NOT reload when the deployed hash matches the boot hash', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(OLD_HASH),
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads exactly once when the deployed hash differs', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(NEW_HASH),
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOADED_TO_KEY)).toBe(NEW_HASH);
  });

  it('does NOT reload a second time to the same target hash', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(NEW_HASH),
    } as unknown as Response);
    sessionStorage.setItem(RELOADED_TO_KEY, NEW_HASH);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('defers reload on unsafe path (/pos)', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        pathname: '/businessvault-app/pos',
        reload: reloadSpy,
      },
    });
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(NEW_HASH),
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).not.toHaveBeenCalled();
    // Guard flag NOT set — next check on a safe path should still reload.
    expect(sessionStorage.getItem(RELOADED_TO_KEY)).toBeNull();
  });

  it('defers reload on unsafe path (/invoices/:id/edit)', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        pathname: '/businessvault-app/invoices/abc-123/edit',
        reload: reloadSpy,
      },
    });
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(NEW_HASH),
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does not check when the tab is hidden on visibilitychange fire', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(NEW_HASH),
    } as unknown as Response);
    setVisibility('hidden');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('stays silent on network failure — no reload, no throw', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    setVisibility('visible');
    installVersionPreflight();
    await expect(
      (async () => {
        visibilityListener?.();
        await new Promise((r) => setTimeout(r, 0));
      })(),
    ).resolves.toBeUndefined();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('stays silent when the fetched HTML has no entry-bundle script', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => '<html><head></head><body>Under maintenance</body></html>',
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('stays silent on a non-2xx response', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: false,
      text: async () => 'nope',
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('uses cache: no-store and appends a cachebuster query param', async () => {
    seedBootScript(OLD_HASH);
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => makeIndexHtml(OLD_HASH),
    } as unknown as Response);
    setVisibility('visible');
    installVersionPreflight();
    visibilityListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchSpy.mock.calls[0];
    expect(String(urlArg)).toMatch(/index\.html\?_=/);
    expect((initArg as RequestInit).cache).toBe('no-store');
  });
});
