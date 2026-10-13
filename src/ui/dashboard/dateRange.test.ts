import { describe, expect, it } from 'vitest';
import { resolveRange } from './dateRange';

const today = new Date('2026-10-13T09:00:00Z');

describe('resolveRange', () => {
  it('last 6 months starts on the 1st five months back and ends today', () => {
    expect(resolveRange('6m', today)).toMatchObject({
      fromYmd: '2026-05-01',
      toYmd: '2026-10-13',
      months: 6,
    });
  });

  it('financial-year ranges follow the Indian April–March year', () => {
    expect(resolveRange('fy', today)).toMatchObject({ fromYmd: '2026-04-01', toYmd: '2026-10-13', months: 7 });
    expect(resolveRange('last-fy', today)).toMatchObject({ fromYmd: '2025-04-01', toYmd: '2026-03-31', months: 12 });
    expect(resolveRange('fy', new Date('2027-02-10T00:00:00Z')).fromYmd).toBe('2026-04-01');
  });

  it('previous period is the same length and ends the day before', () => {
    const r = resolveRange('this-month', today);
    expect(r).toMatchObject({ fromYmd: '2026-10-01', previousToYmd: '2026-09-30', previousFromYmd: '2026-09-18' });
  });
});
