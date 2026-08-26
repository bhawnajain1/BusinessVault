import { describe, it, expect } from 'vitest';
import { deriveDisplayStatus } from './BackupSettings';
import type {
  ConnectionStatus,
  IntegrityReport,
} from '../../storage/CustomerStorageProvider';

// Regression tests for the "false DISCONNECTED banner" bug reported after a
// GIS reconnect + page reload. See BackupSettings.tsx:deriveDisplayStatus for
// the precedence spec.

const CONNECTED: ConnectionStatus = { state: 'CONNECTED', account: 'x@y.com' };
const DISCONNECTED: ConnectionStatus = { state: 'DISCONNECTED' };
const OK_INTEGRITY: IntegrityReport = {
  businessId: 'biz1',
  checkedAt: '2026-08-26T14:50:24.000Z',
  ok: true,
  filesChecked: 3,
  issues: [],
};
const BAD_INTEGRITY: IntegrityReport = {
  businessId: 'biz1',
  checkedAt: '2026-08-26T14:50:24.000Z',
  ok: false,
  filesChecked: 3,
  issues: [
    {
      severity: 'error',
      code: 'HASH_MISMATCH',
      path: 'current/journal.jsonl',
      detail: 'sha256 mismatch',
    },
  ],
};

describe('deriveDisplayStatus — precedence spec', () => {
  it('returns the sync worker health when provider is CONNECTED and integrity is ok', () => {
    expect(deriveDisplayStatus(CONNECTED, 'HEALTHY', OK_INTEGRITY)).toBe('HEALTHY');
    expect(deriveDisplayStatus(CONNECTED, 'SYNCING', OK_INTEGRITY)).toBe('SYNCING');
    expect(deriveDisplayStatus(CONNECTED, 'OFFLINE', null)).toBe('OFFLINE');
    expect(deriveDisplayStatus(CONNECTED, 'ERROR', null)).toBe('ERROR');
  });

  it('DISCONNECTED from the provider overrides health.status', () => {
    // Bug scenario A: sync worker still thinks it's HEALTHY but the user
    // signed out — banner must appear.
    expect(deriveDisplayStatus(DISCONNECTED, 'HEALTHY', null)).toBe('DISCONNECTED');
    expect(deriveDisplayStatus(DISCONNECTED, 'SYNCING', null)).toBe('DISCONNECTED');
  });

  it('INTEGRITY_FAILURE wins over provider CONNECTED + HEALTHY sync', () => {
    expect(deriveDisplayStatus(CONNECTED, 'HEALTHY', BAD_INTEGRITY)).toBe('INTEGRITY_FAILURE');
  });

  it('DISCONNECTED wins over INTEGRITY_FAILURE — user must reconnect before we can even talk about integrity', () => {
    expect(deriveDisplayStatus(DISCONNECTED, 'HEALTHY', BAD_INTEGRITY)).toBe('DISCONNECTED');
  });

  it('null conn (still loading) falls through to health.status', () => {
    // The mount-time race: provider registry not populated yet. We should
    // NOT show DISCONNECTED — the polled health value carries the truth
    // once the sync worker starts emitting.
    expect(deriveDisplayStatus(null, 'HEALTHY', null)).toBe('HEALTHY');
    expect(deriveDisplayStatus(null, 'SYNCING', null)).toBe('SYNCING');
  });

  it('the reported regression: CONNECTED provider + HEALTHY worker must NOT display DISCONNECTED', () => {
    // Reproduces the 2026-08-26 bug: after Reconnect + page reload the
    // effect eventually read connectionStatus() → {state:'CONNECTED'} and
    // health.status → 'HEALTHY', but the banner still said DISCONNECTED
    // because a stale one-shot read of `conn` was frozen in state. The
    // fix is a 2s poll upstream of this fn; this test guards the fn
    // contract so future refactors don't reintroduce the stale-input path.
    const result = deriveDisplayStatus(
      { state: 'CONNECTED', account: 'bjbacchhawat@gmail.com' },
      'HEALTHY',
      null,
    );
    expect(result).toBe('HEALTHY');
    expect(result).not.toBe('DISCONNECTED');
  });
});
