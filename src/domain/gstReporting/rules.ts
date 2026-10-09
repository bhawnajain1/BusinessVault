import { isDateOnly } from './periods';

export const GST_RULE_SET_VERSION = 'businessvault-gst-2025.05-v2';

export interface GstRuleSet {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  description: string;
  officialSourceReference: string;
  officialSourceUrls: readonly string[];
  b2clThresholdPaise: number;
  splitHsnByRecipient: boolean;
  documentSeriesRequired: boolean;
}

export const GST_RULES: readonly GstRuleSet[] = [
  { id: 'pre-2024-08', effectiveFrom: '2017-07-01', effectiveTo: '2024-08-01',
    description: 'Interstate unregistered B2CL threshold strictly above INR 250,000',
    officialSourceReference: 'CGST Rules, rule 59 / FORM GSTR-1; Notification 12/2024-Central Tax (10 July 2024)',
    officialSourceUrls: ['https://cbic-gst.gov.in/pdf/central-tax/12-2024-ct-eng.pdf'],
    b2clThresholdPaise: 25_000_000, splitHsnByRecipient: false, documentSeriesRequired: false },
  { id: '2024-08', effectiveFrom: '2024-08-01', effectiveTo: '2025-05-01',
    description: 'Interstate unregistered B2CL threshold strictly above INR 100,000',
    officialSourceReference: 'Notification 12/2024-Central Tax (10 July 2024), FORM GSTR-1 amendments',
    officialSourceUrls: ['https://cbic-gst.gov.in/pdf/central-tax/12-2024-ct-eng.pdf'],
    b2clThresholdPaise: 10_000_000, splitHsnByRecipient: false, documentSeriesRequired: false },
  { id: '2025-05', effectiveFrom: '2025-05-01', effectiveTo: null,
    description: 'Separate B2B/B2C HSN summaries and documents-issued readiness',
    officialSourceReference: 'GST Portal advisory: Table 12 HSN reporting Phase III from May 2025 return period',
    officialSourceUrls: ['https://tutorial.gst.gov.in/userguide/returns/GSTR1.htm'],
    b2clThresholdPaise: 10_000_000, splitHsnByRecipient: true, documentSeriesRequired: true },
];

export const HSN_RULE = {
  effectiveFrom: '2021-04-01', thresholdPaise: 5_000_000_000,
  lowerMinimumDigits: 4, higherMinimumDigits: 6,
  officialSourceReference: 'Notification 78/2020-Central Tax (15 October 2020)',
  officialSourceUrls: ['https://cbic-gst.gov.in/pdf/central-tax/78-2020-ct-eng.pdf'],
  description: 'HSN minimum 4 or 6 digits based on preceding-FY AATO; valid full codes remain preserved.',
  effectiveTo: null,
} as const;

export function rulesForDate(date: string): GstRuleSet | null {
  if (!isDateOnly(date)) return null;
  return GST_RULES.find(rule => date >= rule.effectiveFrom && (!rule.effectiveTo || date < rule.effectiveTo)) ?? null;
}

export function minimumHsnDigits(aatoPaise: number | null | undefined, date: string = HSN_RULE.effectiveFrom): number | null {
  if (!isDateOnly(date) || date < HSN_RULE.effectiveFrom) return null;
  if (aatoPaise == null || !Number.isSafeInteger(aatoPaise) || aatoPaise < 0) return null;
  return aatoPaise > HSN_RULE.thresholdPaise ? HSN_RULE.higherMinimumDigits : HSN_RULE.lowerMinimumDigits;
}
