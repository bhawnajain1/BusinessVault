import type { Business } from '../../db/types';

export type OnboardingStep =
  | 'welcome'
  | 'details'
  | 'connect'
  | 'connecting'
  | 'done';

export type StorageChoice = 'google-drive' | 'local-folder';

export interface OnboardingForm {
  name: string;
  legal_name: string;
  gstin: string;
  state: string;
  state_code: string;
  address_line1: string;
  address_line2: string;
  city: string;
  pincode: string;
  phone: string;
  email: string;
  financial_year_start_month: number;
  storage: StorageChoice | null;
  driveFolderPath: string | null;
  driveFolderId: string | null;
  driveEmail: string | null;
}

export function initialForm(): OnboardingForm {
  return {
    name: '',
    legal_name: '',
    gstin: '',
    state: 'Karnataka',
    state_code: '29',
    address_line1: '',
    address_line2: '',
    city: '',
    pincode: '',
    phone: '',
    email: '',
    financial_year_start_month: 4,
    storage: null,
    driveFolderPath: null,
    driveFolderId: null,
    driveEmail: null,
  };
}

// The centralized Indian state list lives at src/lib/indianStates.ts.
// Re-exported here so existing importers of onboarding/state don't break;
// see feedback_1_to_7.md §12 "Do not duplicate mappings".
export { INDIAN_STATES } from '../../lib/indianStates';

export function computeFinancialYear(
  now: Date,
  startMonth: number,
): string {
  // Indian FY runs April 1 → March 31 by default. E.g. FY 2026-27 = 2026-04-01..2027-03-31.
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1..12
  const startYear = m >= startMonth ? y : y - 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

export function sanitizeBusinessFolderName(name: string): string {
  // Drive tolerates most characters but keep the folder visibly clean.
  return name.trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ');
}

export function formToBusiness(
  form: OnboardingForm,
  id: string,
  now: string,
): Business {
  const gstin = form.gstin.trim() === '' ? null : form.gstin.trim().toUpperCase();
  return {
    id,
    name: form.name.trim(),
    legal_name: form.legal_name.trim() || form.name.trim(),
    gstin,
    pan: gstin ? gstin.slice(2, 12) : null,
    address_line1: form.address_line1.trim(),
    address_line2: form.address_line2.trim(),
    city: form.city.trim(),
    state: form.state,
    state_code: form.state_code,
    pincode: form.pincode.trim(),
    country: 'IN',
    phone: form.phone.trim(),
    email: form.email.trim(),
    financial_year_start_month: form.financial_year_start_month,
    current_financial_year: computeFinancialYear(new Date(), form.financial_year_start_month),
    currency: 'INR',
    logo_ref: null,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: form.driveFolderId,
    drive_connected_email: form.driveEmail,
    schema_version: 1,
    created_at: now,
    updated_at: now,
    entity_version: 1,
  };
}
