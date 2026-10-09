import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import GstDataTable from './GstDataTable';

describe('GstDataTable', () => {
  it('uses a captioned semantic table and readable display labels', () => {
    render(<GstDataTable title="ITC review" headers={['Status', 'Amount']} rows={[["ELIGIBLE_IN_BOOKS", '₹0.00']]} />);

    expect(screen.getByRole('table', { name: 'ITC review' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy();
    expect(screen.getByText('Eligible in books')).toBeTruthy();
    expect(screen.queryByText('ELIGIBLE_IN_BOOKS')).toBeNull();
    expect(screen.getByText('₹0.00')).toBeTruthy();
  });

  it('paginates presentation rows without mutating the supplied rows', () => {
    const rows = Array.from({ length: 26 }, (_, index) => [`Invoice ${index + 1}`, String(index + 1)]);
    render(<GstDataTable title="Source transactions" headers={['Document', 'Count']} rows={rows} />);

    expect(screen.getByText('1–25 of 26')).toBeTruthy();
    expect(screen.queryByText('Invoice 26')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Invoice 26')).toBeTruthy();
    expect(rows).toHaveLength(26);
    expect(rows[0][0]).toBe('Invoice 1');
  });

  it('renders an intentional empty state', () => {
    render(<GstDataTable title="Validation issues" headers={['Severity', 'Issue']} rows={[]} />);
    expect(screen.getByText('No rows are available for the selected report period.')).toBeTruthy();
  });
});
