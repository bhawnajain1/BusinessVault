import type { GstTaxPeriod } from './types';

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function financialYearForDate(date: string): string {
  if (!isDateOnly(date)) throw new Error('Expected a valid YYYY-MM-DD date');
  const year = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 4 ? 1 : 0);
  return `${year}-${String(year + 1).slice(-2)}`;
}

export function precedingFinancialYear(financialYear: string): string {
  if (!/^\d{4}-\d{2}$/.test(financialYear)) throw new Error('Expected YYYY-YY financial year');
  const year = Number(financialYear.slice(0, 4)) - 1;
  return `${year}-${String(year + 1).slice(-2)}`;
}

export function monthPeriod(
  businessId: string, gstinSnapshot: string, periodKey: string,
  filingFrequency: GstTaxPeriod['filingFrequency'] = 'MONTHLY',
): GstTaxPeriod {
  if (!/^\d{4}-\d{2}$/.test(periodKey) || !isDateOnly(`${periodKey}-01`)) {
    throw new Error('Expected a valid YYYY-MM tax month');
  }
  const year = Number(periodKey.slice(0, 4));
  const month = Number(periodKey.slice(5));
  const nextPeriodStart = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
  return { businessId, gstinSnapshot, financialYear: financialYearForDate(`${periodKey}-01`),
    filingFrequency, periodType: 'MONTH', periodKey, periodStart: `${periodKey}-01`, nextPeriodStart };
}

export function quarterPeriod(businessId: string, gstin: string, financialYear: string, quarter: number): GstTaxPeriod {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error('Quarter must be 1 through 4');
  precedingFinancialYear(financialYear);
  const year = Number(financialYear.slice(0, 4));
  const start = quarter === 4 ? `${year + 1}-01` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}`;
  const first = monthPeriod(businessId, gstin, start, 'QRMP');
  const last = monthPeriod(businessId, gstin, `${start.slice(0, 4)}-${String(Number(start.slice(5)) + 2).padStart(2, '0')}`, 'QRMP');
  return { ...first, financialYear, periodType: 'QUARTER', periodKey: `FY${financialYear}-Q${quarter}`, nextPeriodStart: last.nextPeriodStart };
}

export function dateInPeriod(date: string, period: GstTaxPeriod): boolean {
  return isDateOnly(date) && date >= period.periodStart && date < period.nextPeriodStart;
}

export function selectedMonthPeriods(businessId: string, gstin: string, keys: string[], frequency: GstTaxPeriod['filingFrequency'] = 'MONTHLY'): GstTaxPeriod[] {
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate tax months');
  return [...keys].sort().map(key => monthPeriod(businessId, gstin, key, frequency));
}

export function validateTaxPeriod(period: GstTaxPeriod): boolean {
  try {
    if (period.periodType === 'MONTH') {
      const expected = monthPeriod(period.businessId, period.gstinSnapshot, period.periodKey, period.filingFrequency);
      return expected.periodStart === period.periodStart && expected.nextPeriodStart === period.nextPeriodStart && expected.financialYear === period.financialYear;
    }
    const match = /^FY(\d{4}-\d{2})-Q([1-4])$/.exec(period.periodKey);
    if (!match || period.filingFrequency !== 'QRMP') return false;
    const expected = quarterPeriod(period.businessId, period.gstinSnapshot, match[1], Number(match[2]));
    return expected.periodStart === period.periodStart && expected.nextPeriodStart === period.nextPeriodStart && expected.financialYear === period.financialYear;
  } catch { return false; }
}
