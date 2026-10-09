import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import GstSummaryPage from './GstSummaryPage';
import { monthPeriod, quarterPeriod } from '../../domain/gstReporting/periods';
import type { GstAmounts, GstSummary, MonthlyGstCalculation, NormalizedGstDocument } from '../../domain/gstReporting/types';
import { computeTotals } from '../pos/POSScreen';

const mocks = vi.hoisted(() => ({ loadWorkspace: vi.fn(), loadSavedReport: vi.fn(), calculateMonths: vi.fn(), calculateQuarter: vi.fn(), saveNote: vi.fn(), confirmNilPeriod: vi.fn(), saveProfile: vi.fn(), setAato: vi.fn(), saveDocumentMetadata: vi.fn(), reviewItc: vi.fn(), addAdjustment: vi.fn(), saveReport: vi.fn(), excel: vi.fn(), csv: vi.fn(), pdf: vi.fn(), json: vi.fn(), setBusiness: vi.fn() }));
vi.mock('../../lib/business', () => ({ setCurrentBusinessId: mocks.setBusiness }));
vi.mock('../../domain/gstReporting', () => ({ gstMonthlyReportService: mocks }));
vi.mock('../../domain/gstReporting/exports', () => ({ downloadGstr1CaWorkbook: mocks.excel, downloadMonthlyGstExcel: mocks.excel, downloadMonthlyGstCsv: mocks.csv, downloadMonthlyGstPdf: mocks.pdf, downloadMonthlyGstJson: mocks.json, downloadPurchaseCaWorkbook: mocks.excel }));
vi.mock('../hooks/useActiveBusiness', () => ({ useActiveBusiness: () => ({ businessId: 'business-a', deviceId: 'device-a', loading: false, error: null }) }));

const empty: GstAmounts = { taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0, pre_round_total_paise: 0, round_off_paise: 0, total_paise: 0 };
const summary: GstSummary = { ...empty, document_count: 0, party_count: 0, detail_row_count: 0, source_entity_ids: [] };
function calculation(key: string): MonthlyGstCalculation {
  return {
    businessName: 'Synthetic business', schemaVersion: 1, ruleSetVersion: 'test-rule', businessId: 'business-a', gstinSnapshot: '',
    period: monthPeriod('business-a', '', key), generatedAt: '2026-10-01T00:00:00Z', sourceDataHash: key, status: 'INCOMPLETE',
    sourceManifest: [], outwardDocuments: [], inwardDocuments: [], outwardRateRows: [], inwardRateRows: [], outwardHsnRows: [], inwardHsnRows: [], outwardNotes: [], inwardNotes: [], booksItcRows: [],
    gstr1Sections: { summaries: {}, documents: {}, rateRows: {}, hsnB2b: [], hsnB2c: [] }, gstr3bSections: { fields: [], interstateSupplies: [], disclaimer: 'Indicative working only.' }, documentSeries: [], issues: [], reconciliations: [],
    totals: { outwardGross: summary, outwardNotes: summary, outwardNet: summary, inwardGross: summary, inwardNotes: summary, inwardNet: summary,
      booksItc: { UNREVIEWED: empty, ELIGIBLE_IN_BOOKS: empty, INELIGIBLE: empty, TEMPORARILY_REVERSED: empty, PERMANENTLY_REVERSED: empty, RECLAIMABLE: empty, RECLAIMED: empty, TOTAL_BOOKS_TAX: empty, NET_APPROVED: empty }, outputLiability: empty, rcmLiability: empty, indicativeWorkingBalance: empty },
  };
}
function RouteLocation() { return <output aria-label="Current route">{useLocation().pathname}</output>; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function reportPage() { return screen.getByRole('heading', { name: 'GST Reports' }).closest('[aria-busy]')!; }
async function finished() { await waitFor(() => expect(reportPage().getAttribute('aria-busy')).toBe('false')); }
async function open() {
  render(<MemoryRouter><GstSummaryPage /><RouteLocation /></MemoryRouter>);
  await waitFor(() => expect(mocks.loadWorkspace).toHaveBeenCalled());
  await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalled());
  await finished();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.excel.mockResolvedValue(undefined);
  mocks.csv.mockResolvedValue(undefined);
  mocks.pdf.mockResolvedValue(undefined);
  mocks.json.mockResolvedValue(undefined);
  mocks.loadWorkspace.mockResolvedValue({ businesses: [{ id: 'business-a', name: 'Synthetic business', gstin: '', state_code: '27' }, { id: 'business-b', name: 'Second business', gstin: '', state_code: '29' }], profiles: [], aato: [], savedRuns: [] });
  mocks.calculateMonths.mockImplementation(async (_business: string, keys: string[]) => keys.map(calculation));
  mocks.calculateQuarter.mockImplementation(async (business: string, year: string, quarter: number) => ({ ...calculation(`${year.slice(0, 4)}-04`), businessId: business, period: quarterPeriod(business, '', year, quarter) }));
  mocks.setBusiness.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('GST report workspace', () => {
  it('automatically calculates the selected current month only after the business workspace loads', async () => {
    const workspace = await mocks.loadWorkspace();
    mocks.loadWorkspace.mockClear();
    const pending = deferred<typeof workspace>();
    mocks.loadWorkspace.mockImplementationOnce(() => pending.promise);
    render(<MemoryRouter><GstSummaryPage /></MemoryRouter>);
    await waitFor(() => expect(mocks.loadWorkspace).toHaveBeenCalledWith('business-a'));
    expect(mocks.calculateMonths).not.toHaveBeenCalled();
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    await act(async () => pending.resolve(workspace));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenLastCalledWith('business-a', [key], 'MONTHLY'));
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(1);
    await finished();
    expect((screen.getByLabelText(key) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Current tax month') as HTMLSelectElement).value).toBe(key);
    expect(screen.queryByRole('button', { name: /Calculate selected months|Recalculate/ })).toBeNull();
  });

  it.each(['success', 'error'] as const)('keeps the latest month results when an older calculation settles with %s', async outcome => {
    await open();
    const initialKey = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const alternatives = screen.getAllByRole('checkbox').map(input => input.closest('label')!.textContent!.trim()).filter(label => /^\d{4}-\d{2}$/.test(label) && label !== initialKey);
    const old = deferred<MonthlyGstCalculation[]>();
    const latest = deferred<MonthlyGstCalculation[]>();
    mocks.calculateMonths.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    fireEvent.click(screen.getByLabelText(alternatives[0]));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    expect(reportPage().getAttribute('aria-busy')).toBe('true');
    for (const label of ['Business', 'Financial year', 'Filing frequency', 'Select all months', alternatives[1]]) {
      expect(screen.getByLabelText(label).matches(':disabled')).toBe(false);
    }
    fireEvent.click(screen.getByLabelText(alternatives[1]));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(3));
    const keys = mocks.calculateMonths.mock.lastCall![1] as string[];
    expect(keys).toEqual([initialKey, ...alternatives.slice(0, 2)].sort());
    const results = keys.map(key => {
      const r = calculation(key);
      r.totals.outwardNet = { ...summary, taxable_paise: 22200 };
      return r;
    });
    await act(async () => latest.resolve(results));
    await finished();
    expect(screen.getAllByRole('button', { name: 'Outward Taxable: 222.00. Show contributing sources' })).toHaveLength(3);
    const status = within(reportPage() as HTMLElement).getByRole('status').textContent;
    await act(async () => {
      if (outcome === 'error') old.reject(new Error('Obsolete source error'));
      else {
        const r = calculation(initialKey);
        r.totals.outwardNet = { ...summary, taxable_paise: 11100 };
        old.resolve([r]);
      }
    });
    expect(screen.getAllByRole('button', { name: 'Outward Taxable: 222.00. Show contributing sources' })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Outward Taxable: 111.00. Show contributing sources' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(within(reportPage() as HTMLElement).getByRole('status').textContent).toBe(status);
    expect(reportPage().getAttribute('aria-busy')).toBe('false');
  });

  it.each(['success', 'error'] as const)('does not let stale %s or finally clear the latest calculation busy state', async outcome => {
    await open();
    const key = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const old = deferred<MonthlyGstCalculation[]>();
    const latest = deferred<MonthlyGstCalculation[]>();
    mocks.calculateMonths.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'MONTHLY' } });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(3));
    await act(async () => {
      if (outcome === 'error') old.reject(new Error('Obsolete source error'));
      else old.resolve([calculation(key)]);
    });
    expect(reportPage().getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(screen.queryByLabelText('Current tax month')).toBeNull();
    await act(async () => latest.resolve([calculation(key)]));
    await finished();
    expect((screen.getByLabelText('Current tax month') as HTMLSelectElement).value).toBe(key);
  });

  it('preserves the latest error when an older calculation succeeds', async () => {
    await open();
    const key = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const old = deferred<MonthlyGstCalculation[]>();
    const latest = deferred<MonthlyGstCalculation[]>();
    mocks.calculateMonths.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'MONTHLY' } });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(3));
    await act(async () => latest.reject(new Error('Latest source unavailable')));
    await finished();
    await act(async () => old.resolve([calculation(key)]));
    expect(screen.getByRole('alert').textContent).toBe('Latest source unavailable');
    expect(screen.queryByLabelText('Current tax month')).toBeNull();
    expect(reportPage().getAttribute('aria-busy')).toBe('false');
  });

  it.each(['success', 'error'] as const)('keeps an empty selection clear when a pending calculation settles with %s', async outcome => {
    await open();
    const key = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const pending = deferred<MonthlyGstCalculation[]>();
    mocks.calculateMonths.mockImplementationOnce(() => pending.promise);
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByLabelText(key));
    await finished();
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === 'error') pending.reject(new Error('Obsolete empty-selection error'));
      else pending.resolve([calculation(key)]);
    });
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Current tax month')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Excel (current month)' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(reportPage().getAttribute('aria-busy')).toBe('false');
  });

  it('automatically recalculates frequency and new-FY month selections without reloading the profile', async () => {
    await open();
    const key = mocks.calculateMonths.mock.lastCall![1][0] as string;
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenLastCalledWith('business-a', [key], 'QRMP'));
    await finished();
    const year = Number((screen.getByLabelText('Financial year') as HTMLInputElement).value) - 1;
    const calls = mocks.calculateMonths.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Financial year'), { target: { value: String(year) } });
    await finished();
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(calls);
    expect(screen.queryByLabelText('Current tax month')).toBeNull();
    fireEvent.click(screen.getByLabelText(`${year}-04`));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenLastCalledWith('business-a', [`${year}-04`], 'QRMP'));
    await finished();
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Current tax month') as HTMLSelectElement).value).toBe(`${year}-04`);
  });

  it('refreshes after a durable AATO write, blocking writes and exports but not report selection while calculating', async () => {
    await open();
    const initialCall = mocks.calculateMonths.mock.lastCall!;
    const pending = deferred<MonthlyGstCalculation[]>();
    const write = deferred<void>();
    mocks.setAato.mockImplementationOnce(() => write.promise);
    mocks.calculateMonths.mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByText('GST profile and preceding FY AATO'));
    fireEvent.change(screen.getByLabelText(/Aggregate Annual Turnover for FY .* \(₹\)/), { target: { value: '4000000.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save AATO' }));
    await waitFor(() => expect(mocks.setAato).toHaveBeenCalled());
    expect(mocks.setAato.mock.calls[0][0]).toMatchObject({ aato_paise: 400000000 });
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve());
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    expect(mocks.calculateMonths).toHaveBeenLastCalledWith(...initialCall);
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2);
    expect(reportPage().getAttribute('aria-busy')).toBe('true');
    for (const label of ['Business', 'Financial year', 'Filing frequency', 'Select all months']) {
      expect(screen.getByLabelText(label).matches(':disabled')).toBe(false);
    }
    for (const name of ['Save profile', 'Save AATO', 'Download Excel (current month)', 'Download Excel (selected months)', 'Save reviewed snapshot', 'Finalize working snapshot']) {
      expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true);
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Purchase / Books ITC' }));
    expect(screen.getByRole('button', { name: 'Save ITC review' }).matches(':disabled')).toBe(true);
    const refreshed = calculation(initialCall[1][0]);
    refreshed.totals.outwardNet = { ...summary, taxable_paise: 43210 };
    await act(async () => pending.resolve([refreshed]));
    await finished();
    fireEvent.click(screen.getByRole('tab', { name: 'Monthly Overview' }));
    expect(screen.getByRole('button', { name: 'Outward Taxable: 432.10. Show contributing sources' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download Excel (current month)' }).matches(':disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Save AATO' }).matches(':disabled')).toBe(false);
  });

  it('does not recalculate after a failed durable edit', async () => {
    await open();
    mocks.setAato.mockRejectedValueOnce(new Error('AATO could not be saved'));
    fireEvent.click(screen.getByText('GST profile and preceding FY AATO'));
    fireEvent.change(screen.getByLabelText(/Aggregate Annual Turnover for FY .* \(₹\)/), { target: { value: '1000.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save AATO' }));
    await screen.findByText('AATO could not be saved');
    await finished();
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(1);
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it('includes native cess in POS line totals and pre-round/header total using banker rounding', () => {
    const cart = [{ key: 'native', item: { tax_rate_bps: 1800, cess_rate_bps: 2500 }, qty: 1, unitPricePaise: 101, discountPaise: 0, cessRateBps: 5000 }] as Parameters<typeof computeTotals>[0];
    const result = computeTotals(cart, null, null, null);
    expect(result.computed[0]).toMatchObject({ taxable: 101, cess: 50, lineTotal: 169 });
    expect(result).toMatchObject({ net: 101, gst: 18, cess: 50, subtotalBeforeRound: 169, roundOff: 31, total: 200 });
    // Editing retains the cart's persisted 50% snapshot, not the master's 25%.
    expect(result.computed[0].cart.cessRateBps).toBe(5000);
  });

  it('sums quarter purchase and ITC figures from existing monthly paise totals', async () => {
    mocks.calculateMonths.mockImplementation(async (_b: string, keys: string[]) => keys.map(key => {
      const r = calculation(key); r.totals.inwardNet = { ...summary, igst_paise: 100 }; r.totals.booksItc.NET_APPROVED = { ...empty, igst_paise: 40 }; return r;
    }));
    await open(); fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select quarter months' }));
    await screen.findByText('All three months calculated independently.');
    expect(screen.getByRole('button', { name: 'Quarter PURCHASE_NET IGST: 3.00. Show contributing sources' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Quarter NET_APPROVED IGST: 1.20. Show contributing sources' })).toBeTruthy();
  });
  it('uses output liability rather than outward-book tax and excludes supplier 9(5) drill-down', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]);
      r.totals.outwardNet = { ...summary, igst_paise: 1800 };
      r.totals.outputLiability = { ...empty, igst_paise: 900 };
      r.outwardDocuments = [{ ...purchase(keys[0]), source_entity_type: 'INVOICE', source_entity_id: 'liable', document_number: 'LIABLE' }, { ...purchase(keys[0]), source_entity_type: 'INVOICE', source_entity_id: 'supplier95', document_number: 'SUPPLIER95', classification: 'ECO_9_5_SUPPLIER' }];
      return [r];
    });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('button', { name: 'Output IGST: 9.00. Show contributing sources' }));
    expect(screen.getByRole('link', { name: 'LIABLE' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'SUPPLIER95' })).toBeNull();
  });

  it('drills each tax-only overview card into only its contributing sources', async () => {
    mocks.calculateMonths.mockImplementationOnce(async () => {
      const r = calculation('2026-08');
      r.totals.outputLiability = { ...empty, igst_paise: 1800 };
      r.totals.booksItc.NET_APPROVED = { ...empty, igst_paise: 900 };
      r.totals.indicativeWorkingBalance = { ...empty, igst_paise: 900 };
      r.outwardDocuments = [{ ...purchase('2026-08'), source_entity_type: 'INVOICE', source_entity_id: 'output', document_number: 'OUTPUT', igst_paise: 1800 }];
      r.booksItcRows = [{ source_entity_type: 'PURCHASE', source_entity_id: 'itc', ledger_entry_id: 'itc-entry', tax_period_key: '2026-08', source_period_key: '2026-08', tax_head: 'IGST', status: 'ELIGIBLE_IN_BOOKS', category: 'OTHER_ITC', books_tax_paise: 900, eligible_paise: 900, temporarily_reversed_paise: 0, permanently_reversed_paise: 0, reclaimable_paise: 0, reclaimed_paise: 0, approved_paise: 900, reason: '', related_prior_entry_id: null }];
      return [r];
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Output GST/ }));
    expect(screen.getByRole('link', { name: 'OUTPUT' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Monthly Overview' }));
    fireEvent.click(screen.getByRole('button', { name: /Books ITC/ }));
    expect(screen.queryByRole('link', { name: 'OUTPUT' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Monthly Overview' }));
    fireEvent.click(screen.getByRole('button', { name: /Indicative liability/ }));
    expect(screen.getByRole('link', { name: 'OUTPUT' })).toBeTruthy();
  });

  it('drills ITC by amount component and tax head, not status, and includes historical balance evidence', async () => {
    const row = { source_entity_type: 'PURCHASE', source_entity_id: 'temporary', ledger_entry_id: 'temp', tax_period_key: '2026-08', source_period_key: '2026-07', tax_head: 'IGST' as const, status: 'TEMPORARILY_REVERSED' as const, category: 'OTHER_ITC', books_tax_paise: 0, eligible_paise: 900, temporarily_reversed_paise: 500, permanently_reversed_paise: 0, reclaimable_paise: 500, reclaimed_paise: 0, approved_paise: 400, reason: 'Review', related_prior_entry_id: null };
    mocks.calculateMonths.mockImplementationOnce(async () => {
      const r = calculation('2026-08');
      r.booksItcRows = [row, { ...row, source_entity_id: 'cgst', tax_head: 'CGST' }, { ...row, source_entity_id: 'reclaim', status: 'RECLAIMED', eligible_paise: 100, reclaimed_paise: 100, temporarily_reversed_paise: 0, approved_paise: 100 }];
      r.totals.booksItc.ELIGIBLE_IN_BOOKS = { ...empty, igst_paise: 900, cgst_paise: 900 };
      r.totals.indicativeWorkingBalance = { ...empty, igst_paise: -500 };
      r.sourceManifest = r.booksItcRows.map((entry, i) => ({ entity_type: 'ITC_SOURCE_PURCHASE', entity_id: entry.source_entity_id, entity_version: 1, document_date: '2026-07-01', report_effect: 'CONTEXT', metadata_version: null, content: { header: { ...empty, id: entry.source_entity_id, business_id: 'business-a', bill_date: '2026-07-01', bill_number: `OLD-${i}`, igst_paise: 900 }, lines: [], metadata: null } }));
      return [r];
    });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('button', { name: 'ELIGIBLE_IN_BOOKS IGST: 9.00. Show contributing sources' }));
    const references = screen.getByRole('table', { name: 'Historical ITC source references (not current purchase-book totals)' });
    expect(references.textContent).toContain('OLD-0'); expect(references.textContent).not.toContain('OLD-1'); expect(references.textContent).not.toContain('OLD-2');
    fireEvent.click(screen.getByRole('tab', { name: 'Monthly Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'INDICATIVE_BALANCE IGST: -5.00. Show contributing sources' }));
    const balance = screen.getByRole('table', { name: 'Historical ITC source references (not current purchase-book totals)' });
    expect(balance.textContent).toContain('OLD-0'); expect(balance.textContent).toContain('OLD-2'); expect(balance.textContent).not.toContain('OLD-1');
  });

  it('opens and exports the original immutable snapshot without replacing the edited live calculation', async () => {
    const saved = { ...calculation('2026-08'), sourceDataHash: 'original-hash', savedReportRunId: 'saved-run', savedStatus: 'FINALIZED_WORKING' as const };
    saved.totals = { ...saved.totals, outwardNet: { ...summary, taxable_paise: 10000 } };
    saved.outwardDocuments = [{ ...purchase('2026-08'), source_entity_type: 'INVOICE', source_entity_id: 'original', document_number: 'ORIGINAL' }];
    mocks.loadSavedReport.mockResolvedValue(saved);
    mocks.loadWorkspace.mockResolvedValue({ businesses: [{ id: 'business-a', name: 'Synthetic business' }], profiles: [], aato: [], savedRuns: [{ id: 'saved-run', tax_period_key: '2026-08', status: 'FINALIZED_WORKING', source_data_hash: 'original-hash' }], auditLog: [{ id: 'audit', action: 'gst_report_run.saved', entity_type: 'gst_report_run', entity_id: 'saved-run', actor: 'device:test', at: '2026-08-31', before: null, after: {} }] });
    mocks.calculateMonths.mockImplementationOnce(async () => { const live = calculation('2026-08'); live.totals = { ...live.totals, outwardNet: { ...summary, taxable_paise: 25000 } }; return [live]; });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('tab', { name: 'Saved Reviews / Audit' }));
    expect(screen.getByRole('table', { name: 'GST audit log' }).textContent).toContain('gst_report_run.saved');
    fireEvent.click(screen.getByRole('button', { name: 'Open saved snapshot saved-run' }));
    await screen.findByText('Read-only saved snapshot: FINALIZED_WORKING / 2026-08');
    expect(mocks.loadSavedReport).toHaveBeenCalledWith('business-a', 'saved-run');
    expect(screen.getByRole('button', { name: 'Outward Taxable: 100.00. Show contributing sources' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download Excel (saved snapshot)' }));
    await waitFor(() => expect(mocks.excel).toHaveBeenCalledWith([saved]));
    expect(screen.getByRole('button', { name: 'Save reviewed snapshot' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' }));
    expect(screen.getByRole('button', { name: 'Edit classification' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByText('Add independent GST credit / debit note'));
    expect(screen.getByRole('button', { name: 'Save independent GST note' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Purchase / Books ITC' }));
    expect(screen.getByRole('button', { name: 'Save ITC review' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Return to live working' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Monthly Overview' }));
    expect(screen.getByRole('button', { name: 'Outward Taxable: 250.00. Show contributing sources' })).toBeTruthy();
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid source evidence visible when no normalized document exists', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]); r.issues = [{ code: 'UNSAFE_AMOUNT', severity: 'BLOCKING_ERROR', tax_period_key: keys[0], source_entity_type: 'INVOICE', source_entity_id: 'invalid', document_number: 'INVALID', field: 'total_paise', message: 'Unsafe source', recommended_correction: 'Correct source', amount_impact: null }];
      r.sourceManifest = [{ entity_type: 'INVOICE', entity_id: 'invalid', entity_version: 1, document_date: null, report_effect: 'EXCLUDED', metadata_version: null, content: { id: 'invalid', reason: 'Malformed source retained' } }]; return [r];
    });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('tab', { name: 'Validation Issues' }));
    fireEvent.click(screen.getByRole('button', { name: 'INVALID' }));
    const evidence = screen.getByRole('table', { name: 'Contributing source manifest / audit evidence' });
    fireEvent.click(within(evidence).getByText('View source evidence'));
    expect(evidence.textContent).toContain('Malformed source retained');
  });
  function purchase(key: string): NormalizedGstDocument {
    return { ...empty, igst_paise: 900, source_entity_type: 'PURCHASE', source_entity_id: 'purchase', source_entity_version: 1, tax_period_key: key, document_type: 'TAX_INVOICE', document_number: 'BILL-01', document_date: `${key}-01`, party_id: 'supplier', party_name: 'Synthetic supplier', party_gstin: '', recipient_category: 'REGISTERED', place_of_supply: '27', is_interstate: true, classification: 'B2B', effect_sign: 1, included: true, exclusion_reason: null, cancelled: false, original_source_entity_id: null, original_document_number: null, original_period_key: null, amendment_kind: null, ecommerce_operator_gstin: null, reverse_charge: false, line_count: 1 };
  }
  async function openItc() {
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('tab', { name: 'Purchase / Books ITC' }));
    fireEvent.change(screen.getByLabelText('Purchase source'), { target: { value: 'purchase' } });
    fireEvent.change(screen.getByLabelText('Original eligible amount (integer paise)'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Reversal / reclaim amount (integer paise)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Review reason'), { target: { value: 'Explicit CA review' } });
  }

  it('does not save the unchanged UNREVIEWED default', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => [{ ...calculation(keys[0]), inwardDocuments: [purchase(keys[0])] }]);
    await openItc(); fireEvent.click(screen.getByRole('button', { name: 'Save ITC review' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already unreviewed'));
    expect(mocks.reviewItc).not.toHaveBeenCalled();
  });

  it('links a superseding eligible review to the effective unreviewed entry', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]); r.inwardDocuments = [purchase(keys[0])];
      r.sourceManifest = [{ entity_type: 'GST_ITC_LEDGER', entity_id: 'unreviewed', entity_version: 1, document_date: null, report_effect: 'CONTEXT', metadata_version: null, content: { id: 'unreviewed', business_id: 'business-a', source_entity_type: 'PURCHASE', source_entity_id: 'purchase', tax_head: 'IGST', tax_period_key: keys[0], status: 'UNREVIEWED' } }];
      return [r];
    });
    await openItc(); fireEvent.change(screen.getByLabelText('Review status'), { target: { value: 'ELIGIBLE_IN_BOOKS' } });
    fireEvent.change(screen.getByLabelText('Explicit ITC category'), { target: { value: 'OTHER_ITC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ITC review' }));
    await waitFor(() => expect(mocks.reviewItc).toHaveBeenCalled());
    expect(mocks.reviewItc.mock.calls[0][0]).toMatchObject({ related_prior_entry_id: 'unreviewed', status: 'ELIGIBLE_IN_BOOKS' });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    expect(mocks.calculateMonths).toHaveBeenLastCalledWith(...mocks.calculateMonths.mock.calls[0]);
    await finished();
  });

  it('offers historical workspace and manifest purchases once without adding current-book totals', async () => {
    const old = { ...empty, id: 'purchase', business_id: 'business-a', bill_number: 'JULY-BILL', bill_date: '2026-07-01', igst_paise: 900 };
    mocks.loadWorkspace.mockResolvedValue({ businesses: [{ id: 'business-a', name: 'Synthetic business' }], profiles: [], aato: [], savedRuns: [], itcSourcePurchases: [old], itcEntries: [{ id: 'reversal', business_id: 'business-a', source_entity_type: 'PURCHASE', source_entity_id: 'purchase', tax_head: 'IGST', tax_period_key: '2026-07', status: 'TEMPORARILY_REVERSED' }] });
    mocks.calculateMonths.mockImplementation(async () => {
      const r = calculation('2026-08');
      r.sourceManifest = [{ entity_type: 'ITC_SOURCE_PURCHASE', entity_id: 'purchase', entity_version: 1, document_date: old.bill_date, report_effect: 'CONTEXT', metadata_version: null, content: { header: old, lines: [], metadata: null } }];
      return [r];
    });
    await openItc();
    expect(screen.getAllByRole('option', { name: 'JULY-BILL (2026-07-01)' })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Review status'), { target: { value: 'RECLAIMED' } });
    fireEvent.change(screen.getByLabelText('Explicit ITC category'), { target: { value: 'OTHER_ITC' } });
    fireEvent.change(screen.getByLabelText('Reversal / reclaim amount (integer paise)'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Prior temporary reversal entry ID (required for reclaim)'), { target: { value: 'reversal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ITC review' }));
    await waitFor(() => expect(mocks.reviewItc).toHaveBeenCalled());
    expect(mocks.reviewItc.mock.calls[0][0]).toMatchObject({ source_period_key: '2026-07', tax_period_key: '2026-08', books_tax_paise: 0, related_prior_entry_id: 'reversal', reclaimed_paise: 400 });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    await finished();
    fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' }));
    expect(screen.getByRole('table', { name: 'Contributing documents' }).textContent).not.toContain('JULY-BILL');
    expect(screen.getByRole('table', { name: 'Historical ITC source references (not current purchase-book totals)' }).textContent).toContain('JULY-BILL');
  });

  it('loads an earlier source by ID through the workspace service', async () => {
    await openItc();
    const workspace = mocks.loadWorkspace.mock.results[0];
    const initial = await workspace.value;
    mocks.loadWorkspace.mockResolvedValueOnce({ ...initial, reviewPurchases: [{ ...empty, id: 'july', business_id: 'business-a', bill_number: 'JULY', bill_date: '2026-07-01' }] });
    fireEvent.change(screen.getByLabelText('Historical purchase source ID'), { target: { value: 'july' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load historical purchase' }));
    await screen.findByText('Historical purchase reference loaded. Current-month purchase totals are unchanged.');
    expect(mocks.loadWorkspace).toHaveBeenLastCalledWith('business-a', ['july']);
    expect(screen.getByRole('option', { name: 'JULY (2026-07-01)' })).toBeTruthy();
    expect(mocks.reviewItc).not.toHaveBeenCalled();
  });

  it('rejects an effective reviewed duplicate instead of superseding it', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]); r.inwardDocuments = [purchase(keys[0])];
      r.sourceManifest = [{ entity_type: 'GST_ITC_LEDGER', entity_id: 'reviewed', entity_version: 1, document_date: null, report_effect: 'CONTEXT', metadata_version: null, content: { id: 'reviewed', business_id: 'business-a', source_entity_type: 'PURCHASE', source_entity_id: 'purchase', tax_head: 'IGST', tax_period_key: keys[0], status: 'ELIGIBLE_IN_BOOKS' } }];
      return [r];
    });
    await openItc(); fireEvent.change(screen.getByLabelText('Review status'), { target: { value: 'ELIGIBLE_IN_BOOKS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ITC review' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('effective reviewed ITC entry'));
    expect(mocks.reviewItc).not.toHaveBeenCalled();
  });

  it('reads uppercase metadata evidence and preserves fields/version on classification save', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]); r.inwardDocuments = [purchase(keys[0])];
      r.sourceManifest = [{ entity_type: 'GST_DOCUMENT_METADATA', entity_id: 'metadata', entity_version: 4, document_date: null, report_effect: 'CONTEXT', metadata_version: null, content: {
        id: 'metadata', business_id: 'business-a', source_entity_type: 'PURCHASE', source_entity_id: 'purchase', document_type: 'TAX_INVOICE', supply_category: 'DOMESTIC', recipient_category: 'REGISTERED', shipping_bill_number: 'PRESERVED', entity_version: 4, created_at: 'created', updated_at: 'updated',
      } }]; return [r];
    });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit classification' }));
    expect((screen.getByLabelText('Supply / explicit zero-tax category') as HTMLSelectElement).value).toBe('DOMESTIC');
    fireEvent.click(screen.getByRole('button', { name: 'Save source classification' }));
    await waitFor(() => expect(mocks.saveDocumentMetadata).toHaveBeenCalled());
    expect(mocks.saveDocumentMetadata.mock.calls[0][0]).toMatchObject({ id: 'metadata', expectedVersion: 4, shipping_bill_number: 'PRESERVED' });
    expect(mocks.saveDocumentMetadata.mock.calls[0][0]).not.toHaveProperty('entity_version');
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    expect(mocks.calculateMonths).toHaveBeenLastCalledWith(...mocks.calculateMonths.mock.calls[0]);
    await finished();
  });

  it('only offers valid adjustment table/head combinations and rejects tampered fields', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]);
      const base = { books_derived_paise: 0, gstr1_working_paise: null, approved_books_itc_paise: null, calculated_paise: 0, ca_adjustment_paise: 0, final_working_paise: 0, source_status: 'SALES_BOOKS' as const, source_document_count: 0, source_entity_ids: [], adjustment_ids: [], notes: '' };
      r.gstr3bSections.fields = [{ ...base, table_code: '5', measure: 'taxable_paise' }, { ...base, table_code: '3.1(a)', measure: 'igst_paise' }, { ...base, table_code: '5.1', measure: 'cgst_paise' }];
      return [r];
    });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('tab', { name: 'Draft GSTR-3B' }));
    const tables = screen.getByLabelText('Table code') as HTMLSelectElement;
    expect([...tables.options].map(o => o.value)).toEqual(['5', '3.1(a)', '5.1']);
    fireEvent.change(tables, { target: { value: '5.1' } });
    const heads = screen.getByLabelText('Adjustment tax head') as HTMLSelectElement;
    expect([...heads.options].map(o => o.value)).toEqual(['CGST']);
    fireEvent.change(screen.getByLabelText('Signed adjustment (integer paise)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Adjustment reason'), { target: { value: 'CA correction' } });
    const invalid = document.createElement('option'); invalid.value = 'IGST'; heads.add(invalid);
    fireEvent.change(heads, { target: { value: 'IGST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add CA adjustment' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('supported table and tax head'));
    expect(mocks.addAdjustment).not.toHaveBeenCalled();
  });

  it('automatically recalculates after saving a supported CA adjustment', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]);
      r.gstr3bSections.fields = [{ table_code: '3.1(a)', measure: 'igst_paise', books_derived_paise: 0, gstr1_working_paise: null, approved_books_itc_paise: null, calculated_paise: 0, ca_adjustment_paise: 0, final_working_paise: 0, source_status: 'SALES_BOOKS', source_document_count: 0, source_entity_ids: [], adjustment_ids: [], notes: '' }];
      return [r];
    });
    await open();
    fireEvent.click(screen.getByRole('tab', { name: 'Draft GSTR-3B' }));
    fireEvent.change(screen.getByLabelText('Signed adjustment (integer paise)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Adjustment reason'), { target: { value: 'CA correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add CA adjustment' }));
    await waitFor(() => expect(mocks.addAdjustment).toHaveBeenCalled());
    expect(mocks.addAdjustment.mock.lastCall![0]).toMatchObject({ table_code: '3.1(a)', tax_head: 'IGST', adjustment_paise: 100 });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    expect(mocks.calculateMonths).toHaveBeenLastCalledWith(...mocks.calculateMonths.mock.calls[0]);
    await finished();
  });

  it('synchronizes selected business before navigating to a sales return source', async () => {
    mocks.calculateMonths.mockImplementation(async (_b: string, keys: string[]) => [{ ...calculation(keys[0]), outwardDocuments: [{ ...purchase(keys[0]), source_entity_type: 'SALES_RETURN', source_entity_id: 'return', document_number: 'CREDIT-01' }] }]);
    await open(); fireEvent.change(screen.getByLabelText('Business'), { target: { value: 'business-b' } });
    await waitFor(() => expect(mocks.loadWorkspace).toHaveBeenLastCalledWith('business-b'));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenLastCalledWith('business-b', mocks.calculateMonths.mock.calls[0][1], 'MONTHLY'));
    await finished();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' }));
    let resolve!: () => void;
    mocks.setBusiness.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('link', { name: 'CREDIT-01' }));
    expect(mocks.setBusiness).toHaveBeenCalledWith('business-b');
    expect(screen.getByLabelText('Current route').textContent).toBe('/');
    resolve();
    await waitFor(() => expect(screen.getByLabelText('Current route').textContent).toBe('/returns/return'));
  });
  it('selects all FY months chronologically without merging statutory periods', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Select all months'));
    await waitFor(() => expect(mocks.calculateMonths.mock.lastCall?.[1]).toHaveLength(12));
    await finished();
    const keys = mocks.calculateMonths.mock.lastCall![1] as string[];
    expect(keys).toHaveLength(12); expect(new Set(keys).size).toBe(12); expect(keys).toEqual([...keys].sort());
    expect(keys[0].slice(5)).toBe('04'); expect(keys[11].slice(5)).toBe('03');
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    expect(screen.getByRole('table', { name: 'Independent monthly comparison (not a combined return period)' })).toBeTruthy();
  });

  it('shows a selected-months analysis total without merging monthly return workings', async () => {
    mocks.calculateMonths.mockImplementation(async (_business: string, keys: string[]) => keys.map((key, index) => ({
      ...calculation(key),
      totals: { ...calculation(key).totals, outwardNet: { ...summary, taxable_paise: (index + 1) * 10_000, document_count: index + 1, source_entity_ids: [`invoice-${key}`] } },
    })));
    await open();
    const firstKey = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const otherKey = screen.getAllByRole('checkbox').map(input => input.closest('label')!.textContent!.trim()).find(label => /^\d{4}-\d{2}$/.test(label) && label !== firstKey)!;
    fireEvent.click(screen.getByLabelText(otherKey));
    await finished();
    expect(screen.getByRole('heading', { name: 'Selected-months analysis' })).toBeTruthy();
    expect(screen.getByText('Total across 2 independently calculated months. This is for review only, not a combined GST return period.')).toBeTruthy();
    expect(screen.getByText('300.00')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Independent monthly comparison (not a combined return period)' })).toBeTruthy();
  });

  it('clears results without calculating an empty selection', async () => {
    await open();
    const key = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const calls = mocks.calculateMonths.mock.calls.length;
    fireEvent.click(screen.getByLabelText(key));
    await finished();
    expect(mocks.calculateMonths).toHaveBeenCalledTimes(calls);
    expect(screen.queryByLabelText('Current tax month')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Excel (current month)' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Calculate selected months|Recalculate/ })).toBeNull();
    expect(within(screen.getByRole('table', { name: 'Independent monthly comparison (not a combined return period)' })).queryAllByRole('button')).toHaveLength(0);
  });

  it('announces calculation failures without leaving busy controls', async () => {
    mocks.calculateMonths.mockRejectedValueOnce(new Error('GST source unavailable'));
    await open();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('GST source unavailable'));
    expect(reportPage().getAttribute('aria-busy')).toBe('false');
    expect(screen.getByLabelText('Filing frequency').matches(':disabled')).toBe(false);
  });

  it('keeps QRMP monthly calculations distinct from quarter analysis', async () => {
    await open(); fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    fireEvent.change(screen.getByLabelText('Quarter'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select quarter months' }));
    await screen.findByText('All three months calculated independently.');
    const call = mocks.calculateMonths.mock.lastCall!; expect(call[2]).toBe('QRMP');
    expect((call[1] as string[]).map(k => k.slice(5))).toEqual(['01', '02', '03']);
    expect(screen.getByRole('heading', { name: /quarter analysis, not a statutory return/ })).toBeTruthy();
  });

  it('exports only the chosen result scope and announces export errors', async () => {
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    mocks.excel.mockRejectedValueOnce(new Error('Export could not be prepared'));
    fireEvent.click(screen.getByRole('button', { name: 'Download Excel (current month)' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Export could not be prepared'));
    expect(mocks.excel.mock.calls[0][0]).toHaveLength(1); expect(mocks.saveReport).not.toHaveBeenCalled();
  });

  it('clears prior-business calculations and export actions on business change', async () => {
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    const pending = deferred<MonthlyGstCalculation[]>();
    mocks.calculateMonths.mockImplementationOnce(() => pending.promise);
    fireEvent.change(screen.getByLabelText('Business'), { target: { value: 'business-b' } });
    await waitFor(() => expect(mocks.loadWorkspace).toHaveBeenLastCalledWith('business-b'));
    await waitFor(() => expect(mocks.calculateMonths.mock.lastCall?.[0]).toBe('business-b'));
    expect(screen.queryByRole('button', { name: 'Download Excel (current month)' })).toBeNull();
    expect(screen.queryByLabelText('Current tax month')).toBeNull();
    const key = mocks.calculateMonths.mock.lastCall![1][0] as string;
    await act(async () => pending.resolve([{ ...calculation(key), businessId: 'business-b' }]));
    await finished();
    expect(screen.getByRole('button', { name: 'Download Excel (current month)' }).matches(':disabled')).toBe(false);
  });

  it('filters amount drill-downs to contributing source IDs', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_business: string, keys: string[]) => {
      const r = calculation(keys[0]);
      r.totals.outwardNet = { ...summary, taxable_paise: 12345, source_entity_ids: ['included'] };
      r.outwardDocuments = ['included', 'other'].map(id => ({ ...empty, source_entity_type: 'INVOICE' as const, source_entity_id: id, source_entity_version: 1, tax_period_key: keys[0], document_type: 'TAX_INVOICE', document_number: id, document_date: `${keys[0]}-01`, party_id: 'customer', party_name: 'Synthetic customer', party_gstin: '', recipient_category: 'UNREGISTERED', place_of_supply: '27', is_interstate: false, classification: 'B2CS' as const, effect_sign: 1 as const, included: true, exclusion_reason: null, cancelled: false, original_source_entity_id: null, original_document_number: null, original_period_key: null, amendment_kind: null, ecommerce_operator_gstin: null, reverse_charge: false, line_count: 1 }));
      return [r];
    });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('button', { name: /Outward Taxable: 123.45/ }));
    expect(screen.getByRole('link', { name: 'included' }).getAttribute('href')).toBe('/invoices/included');
    expect(screen.queryByRole('link', { name: 'other' })).toBeNull();
  });

  it('preserves profile fields and expectedVersion, then automatically refreshes the preview', async () => {
    const profile = { id: 'profile', business_id: 'business-a', gstin: '', legal_name: 'Historical legal name', state_code: '27', registration_type: 'REGULAR', registration_start_date: '2020-04-01', registration_end_date: null, filing_frequency: 'MONTHLY', gst_reporting_enabled: 1, effective_from: '2020-04-01', effective_to: null, active: 1, entity_version: 7, created_at: 'created', updated_at: 'updated' };
    mocks.loadWorkspace.mockResolvedValue({ businesses: [{ id: 'business-a', name: 'Synthetic business', gstin: '', state_code: '27' }], profiles: [profile], aato: [], savedRuns: [] });
    mocks.saveProfile.mockResolvedValue({ ...profile, entity_version: 8 });
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByText('GST profile and preceding FY AATO'));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2));
    await finished();
    expect(mocks.saveProfile.mock.calls[0][0]).toMatchObject({ id: 'profile', expectedVersion: 7, legal_name: 'Historical legal name', registration_start_date: '2020-04-01' });
    expect(mocks.saveProfile.mock.calls[0][0]).not.toHaveProperty('created_at');
    expect(mocks.saveProfile.mock.calls[0][0]).not.toHaveProperty('entity_version');
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.calculateMonths).toHaveBeenLastCalledWith(...mocks.calculateMonths.mock.calls[0]);
    expect(screen.getByRole('button', { name: 'Download Excel (current month)' }).matches(':disabled')).toBe(false);
  });

  it('requires confirmation for immutable snapshots and never calls filing', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_business: string, keys: string[]) => [{ ...calculation(keys[0]), status: 'READY_FOR_CA_REVIEW' }]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await open();
    await screen.findByText('Calculated independent monthly workings. No return has been filed.');
    fireEvent.click(screen.getByRole('button', { name: 'Finalize working snapshot' }));
    expect(mocks.saveReport).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Finalize working snapshot' }));
    await screen.findByText('Saved FINALIZED_WORKING snapshot. No return has been filed.');
    expect(mocks.saveReport.mock.calls[0][1]).toBe('FINALIZED_WORKING');
    expect(confirm.mock.calls[0][0]).toContain('cannot be edited or undone');
    confirm.mockRestore();
  });

  it.each(['OUTWARD', 'INWARD'] as const)('saves an independent %s note with historical lines, exact headers and optional linkage', async direction => {
    await open(); fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' }));
    fireEvent.click(screen.getByText('Add independent GST credit / debit note'));
    fireEvent.change(screen.getByLabelText('Note direction'), { target: { value: direction } });
    for (const [label, value] of [['Note number', 'CN-0001'], ['Note party source ID', 'party-1'], ['Note POS state code', '27'], ['Line 1 description', 'Historical goods'], ['Line 1 HSN / SAC', '12345678'], ['Line 1 UQC', 'NOS'], ['Line 1 GST rate (basis points)', '1800'], ['Line 1 Taxable (integer paise)', '10001'], ['Line 1 IGST (integer paise)', '1800'], ['Note round-off (signed integer paise)', '-1']]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    if (direction === 'INWARD') fireEvent.change(screen.getByLabelText('Note supplier state code'), { target: { value: '29' } });
    fireEvent.click(screen.getByLabelText('Note interstate supply'));
    fireEvent.click(screen.getByRole('button', { name: 'Save independent GST note' }));
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));
    expect(mocks.saveNote.mock.lastCall![0]).toMatchObject({ direction, note_number: 'CN-0001', note_type: 'CREDIT_NOTE', party_id: 'party-1', is_interstate: 1,
      taxable_paise: 10001, igst_paise: 1800, pre_round_total_paise: 11801, round_off_paise: -1, total_paise: 11800, original_source_entity_id: null,
      lines: [{ id: 'line-1', line_no: 1, description: 'Historical goods', hsn: '12345678', uqc_code: 'NOS', qty_micros: 1000000, tax_rate_bps: 1800, line_total_paise: 11801 }] });
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2)); await finished();
  });

  it('requires complete nil-book confirmation and uses the current hash and frequency', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]); r.status = 'DRAFT'; r.issues = [{ code: 'NIL_PERIOD_NOT_CONFIRMED', severity: 'WARNING', tax_period_key: keys[0], source_entity_type: 'REPORT', source_entity_id: keys[0], document_number: null, field: null, message: 'Confirm completeness', recommended_correction: 'Confirm', amount_impact: null }]; return [r];
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await open(); const key = mocks.calculateMonths.mock.lastCall![1][0];
      fireEvent.click(screen.getByLabelText(/I confirm all source transactions/));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm nil period completeness' }));
      expect(mocks.confirmNilPeriod).not.toHaveBeenCalled();
      confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Confirm nil period completeness' }));
      await waitFor(() => expect(mocks.confirmNilPeriod).toHaveBeenCalledWith('business-a', key, key, 'MONTHLY'));
      await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2)); await finished();
    } finally { confirm.mockRestore(); }
  });

  it('saves taxable and detailed external adjustments with supporting files and cumulative working values', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => {
      const r = calculation(keys[0]); const base = { books_derived_paise: 0, gstr1_working_paise: null, approved_books_itc_paise: null, calculated_paise: 100, ca_adjustment_paise: 30, final_working_paise: 130, source_status: 'MANUAL_CA_ADJUSTMENT' as const, source_document_count: 0, source_entity_ids: [], adjustment_ids: [], notes: '' };
      r.gstr3bSections.fields = [{ ...base, table_code: '3.1(a)', measure: 'taxable_paise' }, { ...base, table_code: '5.1.INTEREST', measure: 'igst_paise' }, { ...base, table_code: '6.1.CASH', measure: 'igst_paise' }]; return [r];
    });
    await open(); fireEvent.click(screen.getByRole('tab', { name: 'Draft GSTR-3B' }));
    expect(screen.getByRole('option', { name: '5.1.INTEREST' })).toBeTruthy(); expect(screen.getByRole('option', { name: '6.1.CASH' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'TAXABLE' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Signed adjustment (integer paise)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Adjustment reason'), { target: { value: 'CA documented correction' } });
    const file = new File(['evidence'], 'support.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Supporting file (optional)'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add CA adjustment' }));
    await waitFor(() => expect(mocks.addAdjustment).toHaveBeenCalledTimes(1));
    expect(mocks.addAdjustment.mock.lastCall![0]).toMatchObject({ measure: 'taxable_paise', original_paise: 100, adjusted_paise: 150, adjustment_paise: 20, supportingFile: { filename: 'support.txt', mimeType: 'text/plain', blob: file } });
    await finished();
  });

  it('preserves IFF, advance-offset and special-recipient metadata and rejects malformed JSON without a write', async () => {
    mocks.calculateMonths.mockImplementationOnce(async (_b: string, keys: string[]) => [{ ...calculation(keys[0]), inwardDocuments: [purchase(keys[0])] }]);
    await open(); fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' })); fireEvent.click(screen.getByRole('button', { name: 'Edit classification' }));
    const fields = [['IFF-reported month', '2026-07'], ['Recipient UIN (not GSTIN)', 'SYNTHETIC-UIN'], ['Recipient identity reviewed at (ISO timestamp)', '2026-07-31T12:00:00Z'], ['Recipient identity review reason', 'Reviewed recipient identity'], ['Advance GST historical lines (JSON)', '{"lines":[]}'], ['Final-invoice advance offsets (JSON)', '[{"advance_id":"advance-1","taxable_paise":100,"igst_paise":0,"cgst_paise":0,"sgst_paise":0,"cess_paise":0}]']];
    for (const [label, value] of fields) fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
    fireEvent.change(screen.getByLabelText('Previously reported integer-paise values (JSON)'), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save source classification' })); await screen.findByText('Previously reported values must be valid JSON.');
    expect(mocks.saveDocumentMetadata).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Previously reported integer-paise values (JSON)'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save source classification' }));
    await waitFor(() => expect(mocks.saveDocumentMetadata).toHaveBeenCalledTimes(1));
    expect(mocks.saveDocumentMetadata.mock.lastCall![0]).toMatchObject({ iff_reported_period: '2026-07', recipient_uin: 'SYNTHETIC-UIN', recipient_identity_review_reason: 'Reviewed recipient identity', advance_gst_json: '{"lines":[]}', advance_adjustments_json: fields[5][1] }); await finished();
  });

  it('exports selected-month CSV independently from current-month CSV', async () => {
    await open(); fireEvent.click(screen.getByLabelText('Select all months')); await finished();
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV registers (selected months)' }));
    await waitFor(() => expect(mocks.csv).toHaveBeenCalledTimes(1)); await finished();
    expect(mocks.csv.mock.lastCall![0]).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV registers (current month)' }));
    await waitFor(() => expect(mocks.csv).toHaveBeenCalledTimes(2)); expect(mocks.csv.mock.lastCall![0]).toHaveLength(1); await finished();
  });

  it('opens the grouped export menu and restores focus after Escape', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Download GSTR-1 Excel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download GSTR-2 Excel' })).toBeTruthy();
    const trigger = screen.getByRole('button', { name: 'Export' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Export GST reports' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Download Complete GST Working' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Export GST reports' }), { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Export GST reports' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('exports the current calculation through both CA workbook actions', async () => {
    await open();
    const current = mocks.calculateMonths.mock.lastCall![1][0] as string;
    const result = calculation(current);
    mocks.calculateMonths.mockResolvedValueOnce([result]);
    fireEvent.click(screen.getByRole('button', { name: 'Download GSTR-1 Excel' }));
    await waitFor(() => expect(mocks.excel).toHaveBeenCalledWith([result]));
    fireEvent.click(screen.getByRole('button', { name: 'Download GSTR-2 Excel' }));
    await waitFor(() => expect(mocks.excel).toHaveBeenCalledTimes(2));
    expect(mocks.excel.mock.calls[1]).toEqual([[result]]);
  });

  it('shows generation state only on the CA workbook button being downloaded', async () => {
    const pending = deferred<void>();
    mocks.excel.mockReturnValueOnce(pending.promise);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Download GSTR-1 Excel' }));
    expect(screen.getByRole('button', { name: 'Generating GSTR-1…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download GSTR-2 Excel' }).matches(':disabled')).toBe(true);
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download GSTR-1 Excel' })).toBeTruthy());
  });

  it('uses accessible tabs with arrow-key navigation', async () => {
    await open();
    const overview = screen.getByRole('tab', { name: 'Monthly Overview' });
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'GSTR-1 Working' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('gst-tab-1');
  });

  it('explicitly refreshes live sources through calculation without a durable write', async () => {
    await open(); fireEvent.click(screen.getByRole('button', { name: /Calculate reports/ }));
    await waitFor(() => expect(mocks.calculateMonths).toHaveBeenCalledTimes(2)); await finished();
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(1); expect(mocks.saveReport).not.toHaveBeenCalled();
  });

  it('rejects an unsafe historical note line total and retains the entered evidence', async () => {
    await open(); fireEvent.click(screen.getByRole('tab', { name: 'Source Transactions' })); fireEvent.click(screen.getByText('Add independent GST credit / debit note'));
    for (const [label, value] of [['Note number', 'CN-0002'], ['Note party source ID', 'party-1'], ['Note POS state code', '27'], ['Line 1 description', 'Historical goods'], ['Line 1 HSN / SAC', '1234'], ['Line 1 UQC', 'NOS'], ['Line 1 GST rate (basis points)', '1800'], ['Line 1 Taxable (integer paise)', String(Number.MAX_SAFE_INTEGER)], ['Line 1 IGST (integer paise)', '1']]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save independent GST note' })); await screen.findByText('Line 1 total exceeds safe integer range.');
    expect(mocks.saveNote).not.toHaveBeenCalled(); expect((screen.getByLabelText('Note number') as HTMLInputElement).value).toBe('CN-0002'); expect(mocks.calculateMonths).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'error'] as const)('ignores obsolete QRMP quarter %s while the latest quarter remains busy', async outcome => {
    await open(); const old = deferred<MonthlyGstCalculation>(); const latest = deferred<MonthlyGstCalculation>();
    mocks.calculateQuarter.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    fireEvent.change(screen.getByLabelText('Filing frequency'), { target: { value: 'QRMP' } });
    await waitFor(() => expect(mocks.calculateQuarter).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Quarter'), { target: { value: '2' } });
    await waitFor(() => expect(mocks.calculateQuarter).toHaveBeenCalledTimes(2));
    const year = mocks.calculateQuarter.mock.lastCall![1];
    const q = { ...calculation('2026-07'), period: quarterPeriod('business-a', '', year, 2) };
    q.gstr1Sections.quarterPendingDocuments = [{ ...purchase('2026-07'), source_entity_type: 'INVOICE', document_number: 'PENDING-Q2' }];
    await act(async () => { if (outcome === 'error') old.reject(new Error('Old quarter unavailable')); else old.resolve({ ...q, period: quarterPeriod('business-a', '', year, 1) }); });
    expect(reportPage().getAttribute('aria-busy')).toBe('true'); expect(screen.getByRole('alert').textContent).toBe('');
    await act(async () => latest.resolve(q)); await finished();
    fireEvent.click(screen.getByRole('button', { name: 'Open separate QRMP quarter working' }));
    const table = screen.getByRole('table', { name: 'Quarter GSTR-1 pending documents (already-IFF-reported sources excluded)' }); expect(table.textContent).toContain('PENDING-Q2');
    fireEvent.click(screen.getByRole('button', { name: 'Download Excel (current quarter)' })); await waitFor(() => expect(mocks.excel).toHaveBeenCalledWith([q])); await finished();
  });
});
