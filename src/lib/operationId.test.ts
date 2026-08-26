import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { newOperationId, withOperation } from './operationId';
import { db } from '../db';
import { log } from './log';

describe('§14 operationId — newOperationId', () => {
  it('returns a fresh 26-char ULID each call', () => {
    const a = newOperationId();
    const b = newOperationId();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford base32 ULID
    expect(a).not.toBe(b);
  });

  it('two IDs allocated close in time share a common time prefix', () => {
    const a = newOperationId();
    const b = newOperationId();
    // ULID first 10 chars = 48-bit timestamp (Crockford base32); the low 16
    // chars are random. Within the same ms, the timestamp prefix is equal;
    // across a ms boundary, b's prefix is lex >= a's. So the prefix ordering
    // is monotonic even when the full-string ordering is not (random low
    // bits can flip either way within the same ms).
    expect(b.slice(0, 10) >= a.slice(0, 10)).toBe(true);
  });
});

describe('§14 operationId — withOperation', () => {
  beforeEach(async () => {
    await db.debug_logs.clear();
  });

  afterEach(async () => {
    await log.flush();
  });

  it('generates an operationId when none passed and threads it to body', async () => {
    let seen = '';
    await withOperation('invoice.create', undefined, async (opId) => {
      seen = opId;
      return 'ok';
    });
    expect(seen).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('reuses caller-supplied operationId', async () => {
    const preset = newOperationId();
    let seen = '';
    await withOperation('invoice.recycle', { operationId: preset }, async (opId) => {
      seen = opId;
      return null;
    });
    expect(seen).toBe(preset);
  });

  it('logs .start and .success bracketing the body on success', async () => {
    const preset = newOperationId();
    await withOperation('invoice.recycle', { operationId: preset }, async () => 'done');
    await log.flush();
    const rows = await db.debug_logs.toArray();
    const events = rows.map((r) => r.msg);
    expect(events).toContain('invoice.recycle');
    // Both start and success reference the same operationId.
    const startRow = rows.find((r) => r.source === 'invoice.recycle.start');
    const successRow = rows.find((r) => r.source === 'invoice.recycle.success');
    expect(startRow?.ctx as { operationId: string } | null).toEqual({ operationId: preset });
    expect(successRow?.ctx as { operationId: string } | null).toEqual({ operationId: preset });
  });

  it('logs .failure with the error and rethrows', async () => {
    const boom = new Error('boom');
    await expect(
      withOperation('payment.refund', undefined, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await log.flush();
    const all = await db.debug_logs.toArray();
    const failure = all.find((r) => r.source === 'payment.refund.failure');
    expect(failure).toBeDefined();
    expect((failure!.ctx as { operationId?: string })?.operationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('the SAME operationId links nested log.info calls in the body', async () => {
    const spy = vi.spyOn(log, 'info');
    const preset = newOperationId();
    await withOperation('invoice.recycle', { operationId: preset }, async (opId) => {
      log.info('accounting.journal_reversed', 'reverse', { operationId: opId });
      log.info('party.balance_recalculated', 'recalc', { operationId: opId });
    });
    const nested = spy.mock.calls.filter(([source]) =>
      source === 'accounting.journal_reversed' || source === 'party.balance_recalculated',
    );
    for (const call of nested) {
      expect((call[2] as { operationId: string }).operationId).toBe(preset);
    }
    spy.mockRestore();
  });
});
