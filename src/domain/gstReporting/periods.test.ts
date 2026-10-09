import { describe, expect, it } from 'vitest';
import { dateInPeriod, financialYearForDate, isDateOnly, monthPeriod, quarterPeriod, selectedMonthPeriods, validateTaxPeriod } from './periods';
import { minimumHsnDigits, rulesForDate } from './rules';

describe('GST period and date-effective rules', () => {
  it('validates real date-only values without timezone month shifts', () => {
    expect(isDateOnly('2024-02-29')).toBe(true); expect(isDateOnly('2025-02-29')).toBe(false);
    expect(isDateOnly('2025-05-01T00:00:00Z')).toBe(false);
    const period = monthPeriod('b', 'g', '2025-12');
    expect(period.nextPeriodStart).toBe('2026-01-01');
    expect(dateInPeriod('2025-12-01', period)).toBe(true); expect(dateInPeriod('2026-01-01', period)).toBe(false);
    expect(financialYearForDate('2025-03-31')).toBe('2024-25'); expect(financialYearForDate('2025-04-01')).toBe('2025-26');
  });
  it('distinguishes QRMP month analysis and quarter boundaries', () => {
    expect(quarterPeriod('b', 'g', '2025-26', 4)).toMatchObject({ periodStart: '2026-01-01', nextPeriodStart: '2026-04-01', periodType: 'QUARTER', periodKey: 'FY2025-26-Q4' });
    expect(validateTaxPeriod(quarterPeriod('b', 'g', '2025-26', 2))).toBe(true);
    expect(selectedMonthPeriods('b', 'g', ['2025-06', '2025-05'], 'QRMP').map(p => p.periodKey)).toEqual(['2025-05', '2025-06']);
    expect(() => selectedMonthPeriods('b', 'g', ['2025-05', '2025-05'])).toThrow('Duplicate');
    expect(() => monthPeriod('b', 'g', '2025-13')).toThrow();
  });
  it('centralizes effective B2CL, May HSN and AATO thresholds', () => {
    expect(rulesForDate('2024-07-31')!.b2clThresholdPaise).toBe(25000000);
    expect(rulesForDate('2024-08-01')!.b2clThresholdPaise).toBe(10000000);
    expect(rulesForDate('2025-05-01')!.splitHsnByRecipient).toBe(true);
    expect(minimumHsnDigits(null)).toBeNull(); expect(minimumHsnDigits(5_000_000_000)).toBe(4); expect(minimumHsnDigits(5_000_000_001)).toBe(6);
    expect(minimumHsnDigits(5_000_000_001, '2021-03-31')).toBeNull();
  });
});
