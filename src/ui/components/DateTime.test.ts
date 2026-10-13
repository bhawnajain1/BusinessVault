import { describe, expect, it } from 'vitest';
import { formatDateTime, formatTime } from './DateTime';

describe('DateTime helpers', () => {
  it('formats a saved timestamp as "YYYY-MM-DD h:mm am/pm" in local time', () => {
    expect(formatDateTime(new Date(2026, 9, 5, 11, 14).toISOString())).toBe('2026-10-05 11:14 am');
    expect(formatDateTime(new Date(2026, 9, 12, 16, 35).toISOString())).toBe('2026-10-12 4:35 pm');
    expect(formatDateTime(new Date(2026, 9, 12, 0, 5).toISOString())).toBe('2026-10-12 12:05 am');
    expect(formatTime(new Date(2026, 9, 12, 12, 0).toISOString())).toBe('12:00 pm');
  });

  it('returns empty strings for missing or invalid timestamps', () => {
    expect(formatTime(null)).toBe('');
    expect(formatDateTime('not-a-date')).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });
});
