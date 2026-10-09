import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach } from 'vitest';
import { __resetPokeChannelForTests } from '../sync/pokeChannel';

// Node 20 rejects jsdom-realm ArrayBuffers passed to Web Crypto. Normalize
// digest inputs to native Node Buffers while leaving production browser code
// untouched.
const subtle = new Proxy(webcrypto.subtle, {
  get(target, property) {
    if (property === 'digest') return (algorithm: AlgorithmIdentifier, data: BufferSource) =>
      target.digest(algorithm, Buffer.from(new Uint8Array(data as ArrayBuffer)));
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const cryptoForTests = new Proxy(webcrypto, {
  get(target, property) {
    if (property === 'subtle') return subtle;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoForTests });

// Poke listeners are module-level. If a test throws before its worker's
// stop() runs, the listener leaks into the next test — and because the
// sync_events creating-hook now fires the poke synchronously on tx commit,
// a bulkAdd in the next test re-enters the stale listener.
afterEach(() => {
  __resetPokeChannelForTests();
});
