import { describe, expect, it } from 'vitest';
import { addDaysYmd } from './date';

describe('addDaysYmd', () => {
  it('adds 15 days across a month boundary', () => {
    expect(addDaysYmd('2026-08-19', 15)).toBe('2026-09-03');
  });

  it('handles leap-year February dates', () => {
    expect(addDaysYmd('2028-02-15', 15)).toBe('2028-03-01');
  });
});
