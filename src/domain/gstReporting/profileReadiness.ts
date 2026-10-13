import type { GstProfile } from '../../db/types';
import type { GstTaxPeriod } from './types';

// One readiness rule set shared by the calculation engine (blocking issues)
// and the GST Reports profile checklist, so both always agree.
//
// Date boundaries:
// - effective_from / registration_start_date are inclusive start dates.
// - effective_to is EXCLUSIVE: the profile stops applying on that day, so a
//   follow-on profile starts on the same date (continuous transition).
// - registration_end_date is INCLUSIVE: it is the last day the registration
//   was valid. A registration ending 31 October 2026 covers October 2026.
export type GstProfileIssueCode =
  | 'GST_PROFILE_MISSING' | 'GST_PROFILE_MULTIPLE' | 'GST_PROFILE_NOT_REGULAR' | 'GST_PROFILE_DISABLED'
  | 'GST_PROFILE_INACTIVE' | 'GST_PROFILE_GSTIN_MISMATCH' | 'GST_PROFILE_FREQUENCY_MISMATCH'
  | 'GST_PROFILE_EFFECTIVE_DATE_GAP' | 'GST_REGISTRATION_DATE_GAP';

export interface GstProfileProblem {
  code: GstProfileIssueCode;
  field: string | null;
  message: string;
  correction: string;
}

type ReadinessPeriod = Pick<GstTaxPeriod, 'businessId' | 'gstinSnapshot' | 'filingFrequency' | 'periodStart' | 'nextPeriodStart'>;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 2026-10-01 -> "01 October 2026"
export function gstDisplayDate(date: string): string {
  return `${date.slice(8, 10)} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// Last calendar day before nextPeriodStart, e.g. 2026-11-01 -> 2026-10-31.
export function lastDayOfPeriod(period: Pick<GstTaxPeriod, 'nextPeriodStart'>): string {
  const end = new Date(`${period.nextPeriodStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

// "October 2026" for a month, "October–December 2026" for a quarter.
function periodLabel(period: ReadinessPeriod): string {
  const last = lastDayOfPeriod(period);
  const first = `${MONTHS[Number(period.periodStart.slice(5, 7)) - 1]}`;
  const final = `${MONTHS[Number(last.slice(5, 7)) - 1]} ${last.slice(0, 4)}`;
  if (period.periodStart.slice(0, 7) === last.slice(0, 7)) return final;
  return period.periodStart.slice(0, 4) === last.slice(0, 4) ? `${first}–${final}` : `${first} ${period.periodStart.slice(0, 4)}–${final}`;
}

function touchesPeriod(profile: GstProfile, period: ReadinessPeriod): boolean {
  return profile.effective_from < period.nextPeriodStart && (!profile.effective_to || profile.effective_to > period.periodStart);
}

/**
 * `covering` is the active profile rows touching the period (what the engine
 * records as evidence). `problems` is empty only when exactly one enabled
 * REGULAR profile covers the whole period with matching GSTIN and frequency.
 * AATO is deliberately not checked here; it is a separate validation.
 */
export function gstProfileReadiness(profiles: GstProfile[], period: ReadinessPeriod): { covering: GstProfile[]; problems: GstProfileProblem[] } {
  const label = periodLabel(period);
  const own = profiles.filter(p => p.business_id === period.businessId && touchesPeriod(p, period));
  const covering = own.filter(p => p.active);
  const problems: GstProfileProblem[] = [];
  const problem = (code: GstProfileIssueCode, field: string | null, message: string, correction: string) => problems.push({ code, field, message, correction });

  if (covering.length === 0) {
    if (own.length) problem('GST_PROFILE_INACTIVE', 'active', `The saved GST profile for the ${label} tax period is inactive.`,
      'Open GST profile summary, edit the profile, tick Active profile and click Save profile.');
    else problem('GST_PROFILE_MISSING', null, 'No saved GST profile exists for this business.',
      'Open GST profile summary, confirm the registration details and click Save profile.');
    return { covering, problems };
  }
  if (covering.length > 1) {
    const overlapping = covering.some((a, i) => covering.slice(i + 1).some(b =>
      a.effective_from < (b.effective_to ?? '9999-12-31') && b.effective_from < (a.effective_to ?? '9999-12-31')));
    if (overlapping) problem('GST_PROFILE_MULTIPLE', null, `${covering.length} active GST profiles overlap the ${label} tax period.`,
      'Deactivate the duplicate profile or set its Effective to date so only one active profile covers each period.');
    else problem('GST_PROFILE_EFFECTIVE_DATE_GAP', 'effective_from', `The GST profile changes part-way through the ${label} tax period.`,
      `Start the new profile on ${gstDisplayDate(period.periodStart)} or ${gstDisplayDate(period.nextPeriodStart)} so one profile covers the whole period.`);
    return { covering, problems };
  }

  const profile = covering[0];
  if (profile.registration_type !== 'REGULAR') problem('GST_PROFILE_NOT_REGULAR', 'registration_type',
    `The saved GST profile is ${profile.registration_type}; GSTR-1 and Draft GSTR-3B workings need a REGULAR registration.`,
    'If the business is a regular taxpayer, set Registration type to REGULAR and save the GST profile.');
  if (!profile.gst_reporting_enabled) problem('GST_PROFILE_DISABLED', 'gst_reporting_enabled', 'GST reporting is disabled on the saved GST profile.',
    'Tick Enable GST reporting and save the GST profile.');
  if (profile.gstin.toUpperCase() !== period.gstinSnapshot.toUpperCase()) problem('GST_PROFILE_GSTIN_MISMATCH', 'gstin',
    `The saved GST profile GSTIN ${profile.gstin || '(blank)'} does not match the selected business GSTIN ${period.gstinSnapshot || '(blank)'}.`,
    'Correct the business GSTIN, or save a GST profile for the selected business GSTIN.');
  if (profile.filing_frequency !== period.filingFrequency) problem('GST_PROFILE_FREQUENCY_MISMATCH', 'filing_frequency',
    `The selected filing frequency is ${period.filingFrequency}, but the saved profile is ${profile.filing_frequency}.`,
    `Select ${profile.filing_frequency} or update and save the GST profile.`);
  if (profile.effective_from > period.periodStart) problem('GST_PROFILE_EFFECTIVE_DATE_GAP', 'effective_from',
    `The GST profile does not cover the complete ${label} tax period.`,
    `Set Effective from on or before ${gstDisplayDate(period.periodStart)} and leave Effective to blank for an ongoing registration.`);
  else if (profile.effective_to && profile.effective_to < period.nextPeriodStart) problem('GST_PROFILE_EFFECTIVE_DATE_GAP', 'effective_to',
    `The GST profile does not cover the complete ${label} tax period.`,
    `Set Effective to (exclusive) on or after ${gstDisplayDate(period.nextPeriodStart)}, or leave it blank for an ongoing registration.`);
  if (profile.registration_start_date && profile.registration_start_date > period.periodStart) problem('GST_REGISTRATION_DATE_GAP', 'registration_start_date',
    `The GST registration does not cover the complete ${label} tax period.`,
    `Set Registration start on or before ${gstDisplayDate(period.periodStart)}, or leave it blank.`);
  else if (profile.registration_end_date && profile.registration_end_date < lastDayOfPeriod(period)) problem('GST_REGISTRATION_DATE_GAP', 'registration_end_date',
    `The GST registration does not cover the complete ${label} tax period.`,
    `Set Registration end (inclusive) on or after ${gstDisplayDate(lastDayOfPeriod(period))}, or leave it blank for an ongoing registration.`);
  return { covering, problems };
}
