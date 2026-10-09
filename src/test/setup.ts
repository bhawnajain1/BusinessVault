import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach } from 'vitest';
import { __resetPokeChannelForTests } from '../sync/pokeChannel';

// jsdom's Crypto wrapper rejects ArrayBuffers created by Node's Blob and
// Response implementations on Node 20. Use Node's Web Crypto consistently.
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });

// Poke listeners are module-level. If a test throws before its worker's
// stop() runs, the listener leaks into the next test — and because the
// sync_events creating-hook now fires the poke synchronously on tx commit,
// a bulkAdd in the next test re-enters the stale listener.
afterEach(() => {
  __resetPokeChannelForTests();
});
