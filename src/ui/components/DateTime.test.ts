import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDateTimeCsv, formatTime } from './DateTime';

describe('DateTime helpers', () => {
  it('formats a saved timestamp in local time', () => {
    const iso = new Date(2026, 9, 12, 16, 35).toISOString();
    expect(formatTime(iso).toLowerCase()).toBe('4:35 pm');
    expect(formatDateTimeCsv(iso)).toBe('2026-10-12 16:35');
    expect(formatDateTime(iso)).toMatch(/12 Oct 2026/);
  });

  it('returns empty strings for missing or invalid timestamps', () => {
    expect(formatTime(null)).toBe('');
    expect(formatDateTime('not-a-date')).toBe('');
    expect(formatDateTimeCsv(undefined)).toBe('');
  });
});
