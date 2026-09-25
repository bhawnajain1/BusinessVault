// Unit tests for the chunk-load recovery logic.
//
// The wrapper's important behaviors:
//   1. Non-chunk errors bubble through unchanged.
//   2. Chunk-load error + no prior reload attempt → set sessionStorage flag,
//      call reload(). Returned promise never resolves so React stays in
//      Suspense until the reload lands.
//   3. Chunk-load error + prior reload attempt → do NOT reload again;
//      re-throw so the ErrorBoundary shows a message.
//
// We test loadWithChunkRecovery directly (it takes an injectable reload fn)
// rather than going through React.lazy — avoids poking at private React
// internals and stays hermetic.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _isChunkLoadError,
  loadWithChunkRecovery,
} from './lazyWithReload';
import type { ComponentType } from 'react';

const RELOAD_FLAG = 'bv:chunk-reload-attempted';

const DummyComponent: ComponentType<unknown> = () => null;

describe('_isChunkLoadError', () => {
  it('matches the exact Vite/Chrome shape from the debug log', () => {
    const err = new TypeError(
      'Failed to fetch dynamically imported module: https://example.com/assets/Foo-CHaK4dxT.js',
    );
    expect(_isChunkLoadError(err)).toBe(true);
  });

  it('matches classic Webpack ChunkLoadError', () => {
    const err = new Error('Loading chunk 42 failed.');
    err.name = 'ChunkLoadError';
    expect(_isChunkLoadError(err)).toBe(true);
  });

  it('matches "Loading chunk" without a formal name', () => {
    expect(_isChunkLoadError(new Error('Loading chunk 3 failed.'))).toBe(true);
  });

  it('matches Firefox "error loading dynamically imported module"', () => {
    expect(
      _isChunkLoadError(
        new Error('error loading dynamically imported module'),
      ),
    ).toBe(true);
  });

  it('accepts a plain string error too', () => {
    expect(
      _isChunkLoadError(
        'Failed to fetch dynamically imported module: /assets/Bar.js',
      ),
    ).toBe(true);
  });

  it('does NOT match unrelated TypeErrors', () => {
    expect(_isChunkLoadError(new TypeError("Cannot read 'foo' of null"))).toBe(
      false,
    );
  });

  it('does NOT match a random Error', () => {
    expect(_isChunkLoadError(new Error('something else'))).toBe(false);
  });

  it('handles null / undefined', () => {
    expect(_isChunkLoadError(null)).toBe(false);
    expect(_isChunkLoadError(undefined)).toBe(false);
  });
});

describe('loadWithChunkRecovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('resolves normally when the loader succeeds', async () => {
    const reload = vi.fn();
    const loader = vi
      .fn()
      .mockResolvedValue({ default: DummyComponent });
    const result = await loadWithChunkRecovery(loader, 'HappyRoute', reload);
    expect(result.default).toBe(DummyComponent);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
  });

  it('bubbles a non-chunk error unchanged and does not reload', async () => {
    const reload = vi.fn();
    const boom = new Error('component blew up during import');
    const loader = vi.fn().mockRejectedValue(boom);
    await expect(
      loadWithChunkRecovery(loader, 'BoomRoute', reload),
    ).rejects.toThrow('component blew up during import');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
  });

  it('on a fresh chunk error: sets flag and calls reload', async () => {
    const reload = vi.fn();
    const chunkErr = new TypeError(
      'Failed to fetch dynamically imported module: https://example.com/assets/Foo-abc.js',
    );
    const loader = vi.fn().mockRejectedValue(chunkErr);
    // loadWithChunkRecovery returns a never-resolving promise on the reload
    // path — race it against a microtask flush to observe side effects.
    let settled = false;
    const p = loadWithChunkRecovery(loader, 'StaleRoute', reload).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Yield enough microtasks for the async catch block to run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_FLAG)).not.toBeNull();
    expect(settled).toBe(false); // promise stays pending
    void p;
  });

  it('on a chunk error with prior reload attempt: does NOT reload, throws', async () => {
    const reload = vi.fn();
    sessionStorage.setItem(RELOAD_FLAG, '2026-08-27T00:00:00Z');
    const chunkErr = new TypeError(
      'Failed to fetch dynamically imported module: /assets/Foo-abc.js',
    );
    const loader = vi.fn().mockRejectedValue(chunkErr);
    await expect(
      loadWithChunkRecovery(loader, 'GivingUpRoute', reload),
    ).rejects.toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });
});
