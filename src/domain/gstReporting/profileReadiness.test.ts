import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Business, GstAato, GstProfile } from '../../db/types';
import { computeGstinCheckChar } from '../../lib/gst';
import { calculateMonthlyGst } from './calculateMonthlyGst';
import { canonicalGstSources } from './GstMonthlyReportService';
import { monthPeriod, quarterPeriod } from './periods';
import { gstProfileReadiness } from './profileReadiness';
import type { GstMonthlySources } from './types';

const base = '27AAAAA0000A1Z';
const gstin = base + computeGstinCheckChar(base);
const stamp = { created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', entity_version: 1 };
function profile(values: Partial<GstProfile> = {}): GstProfile {
  return { ...stamp, id: 'profile', business_id: 'b', gstin, legal_name: 'Synthetic Books', state_code: '27', registration_type: 'REGULAR',
    registration_start_date: null, registration_end_date: null, filing_frequency: 'MONTHLY', gst_reporting_enabled: 1,
    effective_from: '2026-04-01', effective_to: null, active: 1, ...values };
}
function sources(profiles: GstProfile[], profileHistory: GstProfile[] = []): GstMonthlySources {
  return {
    business: { ...stamp, id: 'b', name: 'Synthetic Books', gstin, state_code: '27' } as Business,
    profiles, profileHistory,
    aato: [{ ...stamp, id: 'aato', business_id: 'b', financial_year: '2025-26', aato_paise: 10000000, source: 'USER_CONFIRMED', confirmed_at: stamp.created_at } as GstAato],
    customers: [], suppliers: [], invoices: [], invoiceLines: [], purchases: [], purchaseLines: [], salesReturns: [], salesReturnItems: [], originalInvoices: [],
    metadata: [], itcEntries: [], adjustments: [], expenses: [], advances: [], legacyAudits: [],
  };
}
const october = monthPeriod('b', gstin, '2026-10');
function profileIssues(s: GstMonthlySources, period = october) {
  return calculateMonthlyGst(s, period, stamp.created_at).issues.filter(i => i.code.startsWith('GST_PROFILE') || i.code.startsWith('GST_REGISTRATION'));
}
const codes = (s: GstMonthlySources, period = october) => profileIssues(s, period).map(i => i.code);

describe('GST profile readiness', () => {
  it('passes a REGULAR active enabled profile covering the month and records it as evidence', () => {
    const result = calculateMonthlyGst(sources([profile()]), october, stamp.created_at);
    expect(codes(sources([profile()]))).toEqual([]);
    expect(result.sourceManifest.some(m => m.entity_type === 'GST_PROFILE' && m.entity_id === 'profile')).toBe(true);
  });

  it('reports a missing profile with the save correction', () => {
    expect(profileIssues(sources([]))).toEqual([expect.objectContaining({
      code: 'GST_PROFILE_MISSING', severity: 'BLOCKING_ERROR', message: 'No saved GST profile exists for this business.',
      recommended_correction: 'Open GST profile summary, confirm the registration details and click Save profile.',
    })]);
  });

  it.each([
    [{ registration_type: 'COMPOSITION' as const }, 'GST_PROFILE_NOT_REGULAR'],
    [{ gst_reporting_enabled: 0 as const }, 'GST_PROFILE_DISABLED'],
    [{ gstin: '29AAAAA0000A1Z5' }, 'GST_PROFILE_GSTIN_MISMATCH'],
  ])('flags %o as %s', (values, code) => {
    expect(codes(sources([profile(values)]))).toEqual([code]);
  });

  it('reports an inactive profile as INACTIVE, not MISSING', () => {
    expect(codes(sources([], [profile({ active: 0 })]))).toEqual(['GST_PROFILE_INACTIVE']);
    // Inactive rows passed in the active list are filtered the same way.
    expect(codes(sources([profile({ active: 0 })]))).toEqual(['GST_PROFILE_INACTIVE']);
    // Saved snapshot hashes must not change because profile history is now loaded.
    expect(codes(sources([profile()], [profile()]))).toEqual([]);
    expect(canonicalGstSources(sources([], [profile({ active: 0 })]))).toEqual(canonicalGstSources(sources([])));
  });

  it('explains a MONTHLY/QRMP frequency mismatch', () => {
    expect(profileIssues(sources([profile({ filing_frequency: 'QRMP' })]))).toEqual([expect.objectContaining({
      code: 'GST_PROFILE_FREQUENCY_MISMATCH',
      message: 'The selected filing frequency is MONTHLY, but the saved profile is QRMP.',
      recommended_correction: 'Select QRMP or update and save the GST profile.',
    })]);
  });

  it('flags effective-from after the period start', () => {
    expect(profileIssues(sources([profile({ effective_from: '2026-10-15' })]))).toEqual([expect.objectContaining({
      code: 'GST_PROFILE_EFFECTIVE_DATE_GAP', field: 'effective_from',
      message: 'The GST profile does not cover the complete October 2026 tax period.',
      recommended_correction: 'Set Effective from on or before 01 October 2026 and leave Effective to blank for an ongoing registration.',
    })]);
  });

  it('treats effective-to as exclusive: before the next period start is a gap, on it covers the month', () => {
    expect(profileIssues(sources([profile({ effective_to: '2026-10-31' })]))).toEqual([expect.objectContaining({ code: 'GST_PROFILE_EFFECTIVE_DATE_GAP', field: 'effective_to' })]);
    expect(codes(sources([profile({ effective_to: '2026-11-01' })]))).toEqual([]);
  });

  it('reports a profile outside the period as a date gap, not MISSING', () => {
    expect(profileIssues(sources([], [profile({ effective_from: '2027-01-01' })]))).toEqual([expect.objectContaining({ code: 'GST_PROFILE_EFFECTIVE_DATE_GAP', field: 'effective_from' })]);
    expect(profileIssues(sources([], [profile({ effective_to: '2026-07-01' })]))).toEqual([expect.objectContaining({ code: 'GST_PROFILE_EFFECTIVE_DATE_GAP', field: 'effective_to' })]);
  });

  it('reports two overlapping active profiles as MULTIPLE', () => {
    expect(codes(sources([profile(), profile({ id: 'second', effective_from: '2026-09-01' })]))).toEqual(['GST_PROFILE_MULTIPLE']);
  });

  it('accepts a continuous non-overlapping transition on a period boundary', () => {
    const before = profile({ id: 'before', effective_to: '2026-10-01', filing_frequency: 'QRMP' });
    const after = profile({ id: 'after', effective_from: '2026-10-01' });
    expect(codes(sources([before, after]))).toEqual([]);
    expect(codes(sources([before, after]), monthPeriod('b', gstin, '2026-09', 'QRMP'))).toEqual([]);
    const october = calculateMonthlyGst(sources([before, after]), monthPeriod('b', gstin, '2026-10'), stamp.created_at);
    expect(october.sourceManifest.filter(m => m.entity_type === 'GST_PROFILE').map(m => m.entity_id)).toEqual(['after']);
  });

  it('blocks a transition part-way through a period without calling it an overlap', () => {
    const before = profile({ id: 'before', effective_to: '2026-10-15' });
    const after = profile({ id: 'after', effective_from: '2026-10-15' });
    expect(codes(sources([before, after]))).toEqual(['GST_PROFILE_EFFECTIVE_DATE_GAP']);
  });

  it('accepts an ongoing profile with null end dates for a whole quarter', () => {
    const q3 = quarterPeriod('b', gstin, '2026-27', 3);
    expect(codes(sources([profile({ filing_frequency: 'QRMP', effective_to: null, registration_end_date: null })]), q3)).toEqual([]);
  });

  it('treats registration end as inclusive: ending on the last day of the month covers that month', () => {
    expect(codes(sources([profile({ registration_end_date: '2026-10-31' })]))).toEqual([]);
    expect(profileIssues(sources([profile({ registration_end_date: '2026-10-30' })]))).toEqual([expect.objectContaining({
      code: 'GST_REGISTRATION_DATE_GAP', field: 'registration_end_date',
      recommended_correction: 'Set Registration end (inclusive) on or after 31 October 2026, or leave it blank for an ongoing registration.',
    })]);
    expect(codes(sources([profile({ registration_start_date: '2026-10-02' })]))).toEqual(['GST_REGISTRATION_DATE_GAP']);
  });

  it('keeps AATO as a separate validation from profile readiness', () => {
    const s = sources([profile()]); s.aato = [];
    const all = calculateMonthlyGst(s, october, stamp.created_at).issues.map(i => i.code);
    expect(all).toContain('AATO_UNKNOWN');
    expect(codes(s)).toEqual([]);
    expect(gstProfileReadiness([profile()], october).problems).toEqual([]);
  });
});
