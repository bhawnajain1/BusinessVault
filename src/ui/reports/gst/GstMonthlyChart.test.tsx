import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GstMonthlyChart, { chartMonths } from './GstMonthlyChart';

const mocks = vi.hoisted(() => ({ calculateMonths: vi.fn() }));
vi.mock('../../../domain/gstReporting', () => ({ gstMonthlyReportService: mocks }));

function result(key: string, sales: number, purchases: number) {
  return { period: { periodKey: key }, totals: { outwardNet: { taxable_paise: sales }, inwardNet: { taxable_paise: purchases } } };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.calculateMonths.mockImplementation(async (_b: string, keys: string[]) => keys.map((k, i) => result(k, (i + 1) * 10_000, (i + 1) * 4_000)));
});
afterEach(cleanup);

describe('chartMonths', () => {
  it('lists April onwards for the FY, stopping at the current month', () => {
    expect(chartMonths('FY', '2026-27', '2026-06')).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(chartMonths('FY', '2025-26', '2026-10')).toHaveLength(12);
    expect(chartMonths('FY', '2027-28', '2026-10')).toEqual([]);
  });
  it('lists the last six months across a year boundary', () => {
    expect(chartMonths('RECENT', '2026-27', '2027-02')).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('GstMonthlyChart', () => {
  it('loads taxable sales and purchases per month and switches to the recent view', async () => {
    render(<GstMonthlyChart businessId="business-a" financialYear="2025-26" frequency="MONTHLY" revision={0} ready />);
    await screen.findByLabelText('April 2025: taxable sales 100.00, taxable purchases 40.00');
    expect(mocks.calculateMonths).toHaveBeenLastCalledWith('business-a', chartMonths('FY', '2025-26', '9999-12'), 'MONTHLY');
    fireEvent.mouseEnter(screen.getByLabelText('April 2025: taxable sales 100.00, taxable purchases 40.00'));
    expect(screen.getAllByText('Taxable sales').length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: 'Last 6 months' }));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    expect(mocks.calculateMonths.mock.lastCall?.[1]).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Last 6 months' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('waits until the page is ready and reports load failures', async () => {
    const { rerender } = render(<GstMonthlyChart businessId="business-a" financialYear="2025-26" frequency="MONTHLY" revision={0} ready={false} />);
    expect(mocks.calculateMonths).not.toHaveBeenCalled();
    mocks.calculateMonths.mockRejectedValueOnce(new Error('Business not found'));
    rerender(<GstMonthlyChart businessId="business-a" financialYear="2025-26" frequency="MONTHLY" revision={0} ready />);
    expect((await screen.findByRole('alert')).textContent).toContain('Business not found');
  });
});
