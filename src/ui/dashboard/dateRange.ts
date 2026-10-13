import { useSearchParams } from 'react-router-dom';

// Dashboard date range. Lives in the URL (`/?range=6m`) so the header picker
// and the chart's own picker are always in sync, and a refresh or shared link
// keeps the selection. No context / store needed.

export type RangeKey = 'this-month' | '3m' | '6m' | '12m' | 'fy' | 'last-fy';

export const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'this-month', label: 'This month' },
  { key: '3m', label: 'Last 3 months' },
  { key: '6m', label: 'Last 6 months' },
  { key: '12m', label: 'Last 12 months' },
  { key: 'fy', label: 'This financial year' },
  { key: 'last-fy', label: 'Last financial year' },
];

export const DEFAULT_RANGE: RangeKey = '6m';

export interface DateRange {
  key: RangeKey;
  label: string;
  fromYmd: string;
  toYmd: string;
  months: number; // calendar months covered, inclusive of both ends
  // Same-length window immediately before `fromYmd`, for "vs previous period".
  previousFromYmd: string;
  previousToYmd: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

// `today` is injectable for tests. Dates are handled in UTC to match the
// existing dashboard asOfYmd and AccountingService.profitAndLoss, which both
// read the UTC calendar date.
export function resolveRange(key: RangeKey, today: Date = new Date()): DateRange {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const fyStartYear = m >= 3 ? y : y - 1; // Indian FY starts 1 April
  let from: Date;
  let to: Date = utcDate(y, m, today.getUTCDate());

  if (key === 'this-month') from = utcDate(y, m, 1);
  else if (key === '3m') from = utcDate(y, m - 2, 1);
  else if (key === '12m') from = utcDate(y, m - 11, 1);
  else if (key === 'fy') from = utcDate(fyStartYear, 3, 1);
  else if (key === 'last-fy') {
    from = utcDate(fyStartYear - 1, 3, 1);
    to = utcDate(fyStartYear, 3, 0); // 31 March
  } else from = utcDate(y, m - 5, 1);

  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
  const dayMs = 24 * 60 * 60 * 1000;
  const lengthDays = Math.round((to.getTime() - from.getTime()) / dayMs);
  const previousTo = new Date(from.getTime() - dayMs);
  const previousFrom = new Date(previousTo.getTime() - lengthDays * dayMs);

  return {
    key,
    label: RANGE_OPTIONS.find((o) => o.key === key)?.label ?? 'Last 6 months',
    fromYmd: ymd(from),
    toYmd: ymd(to),
    months,
    previousFromYmd: ymd(previousFrom),
    previousToYmd: ymd(previousTo),
  };
}

function isRangeKey(value: string | null): value is RangeKey {
  return RANGE_OPTIONS.some((o) => o.key === value);
}

export function useDashboardRange(): [DateRange, (key: RangeKey) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('range');
  const key = isRangeKey(raw) ? raw : DEFAULT_RANGE;
  const setKey = (next: RangeKey) => {
    const copy = new URLSearchParams(params);
    if (next === DEFAULT_RANGE) copy.delete('range');
    else copy.set('range', next);
    setParams(copy, { replace: true });
  };
  return [resolveRange(key), setKey];
}
