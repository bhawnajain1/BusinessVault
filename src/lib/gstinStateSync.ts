// §12 GSTIN → State auto-detection helper.
//
// GSTIN's first 2 characters are the state code — the same codes CGST/SGST/IGST
// tax logic uses. Deriving state from GSTIN saves a click, catches typos ("I
// wrote 'Karnataka' but my GSTIN starts with 08 (Rajasthan)"), and keeps the
// tax logic honest.
//
// The rules we implement here are what turn a naive auto-fill into a UX that
// actually helps the shopkeeper:
//
//   1. Derive state only from a well-formed 2-digit prefix.
//   2. On FIRST fill (state was empty), just set it — no confirmation needed.
//   3. If the user later manually changes state to something that DOES conflict
//      with the GSTIN's prefix, show a warning — but DO NOT keep overwriting.
//      This is the "do not continuously overwrite manual override" rule from
//      spec §12: once the user has typed a state, they own it until they
//      explicitly clear it.
//   4. If the user hasn't touched state and the GSTIN prefix changes, follow
//      along.
//
// Note this module has NO React import — it's pure logic. The UI surfaces
// (`applyGstinChange`, `applyStateChange`) call it with the current form and
// receive the new form back. That keeps the same rules working identically in
// onboarding, Settings, Customers, and Suppliers without dragging any of them
// into a hook lifecycle.

import { INDIAN_STATES, findStateByCode, stateFromGstin, type IndianState } from './indianStates';

export interface GstinStatePair {
  gstin: string;
  stateCode: string;
  stateName: string;
  /**
   * True once the user has typed in the State selector (or typed a GSTIN
   * whose derived state was then manually overwritten). Once true, GSTIN
   * changes stop overwriting stateCode/stateName even when the GSTIN prefix
   * would produce a valid different state. Reset by clearing GSTIN or state
   * — that's how the user tells us they'd like auto-detect back.
   */
  stateManuallySet: boolean;
}

export interface GstinStateStatus {
  /** State code the GSTIN prefix says the party is in, if the GSTIN is well-formed enough to tell. */
  detectedFromGstin: IndianState | null;
  /** True when a state has been chosen AND it matches the GSTIN prefix. */
  detectedMatchesSelected: boolean;
  /** True when a state has been chosen AND it does NOT match the GSTIN prefix. */
  mismatch: boolean;
}

/**
 * Normalize a GSTIN string as the user types. Upper-cases and trims
 * whitespace; does NOT enforce length or check digit — those belong to
 * validators, not to normalization.
 */
export function normalizeGstinInput(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '');
}

/**
 * Compute the auto-detection status for a given (GSTIN, stateCode) pair.
 * Pure — call this in render to decide which badge/warning to show.
 */
export function computeGstinStateStatus(
  gstin: string,
  stateCode: string,
): GstinStateStatus {
  const detected = stateFromGstin(gstin) ?? null;
  if (!detected) {
    return { detectedFromGstin: null, detectedMatchesSelected: false, mismatch: false };
  }
  if (stateCode === '') {
    return { detectedFromGstin: detected, detectedMatchesSelected: false, mismatch: false };
  }
  const match = detected.code === stateCode;
  return {
    detectedFromGstin: detected,
    detectedMatchesSelected: match,
    mismatch: !match,
  };
}

/**
 * User typed in the GSTIN box. Returns the next form state.
 *
 * - GSTIN is stored normalized.
 * - If we can derive a state AND the user hasn't manually chosen one, adopt
 *   the derived state.
 * - If the user has manually set a state, leave it — mismatch badge (from
 *   computeGstinStateStatus) will surface any conflict without stealing
 *   their input.
 */
export function applyGstinChange(
  cur: GstinStatePair,
  rawGstin: string,
): GstinStatePair {
  const gstin = normalizeGstinInput(rawGstin);
  const derived = stateFromGstin(gstin);
  // Clearing the GSTIN resets the "manually set" latch so a fresh GSTIN
  // starts auto-detecting again. Same for clearing state.
  const manualLatch =
    gstin === '' || cur.stateCode === '' ? false : cur.stateManuallySet;
  if (derived && !manualLatch) {
    return {
      gstin,
      stateCode: derived.code,
      stateName: derived.name,
      stateManuallySet: false,
    };
  }
  return { ...cur, gstin, stateManuallySet: manualLatch };
}

/**
 * User picked a state from the dropdown. Returns the next form state and
 * latches "manually set" so future GSTIN edits won't overwrite it.
 */
export function applyStateChange(
  cur: GstinStatePair,
  stateCode: string,
): GstinStatePair {
  if (stateCode === '') {
    // Clearing the state also clears the manual latch — the field is now
    // available for GSTIN-driven auto-fill again.
    return { ...cur, stateCode: '', stateName: '', stateManuallySet: false };
  }
  const state = findStateByCode(stateCode);
  return {
    ...cur,
    stateCode,
    stateName: state?.name ?? '',
    stateManuallySet: true,
  };
}

/**
 * Convenience — infer the initial "manually set" latch for existing records
 * loaded from the DB. If the record's stateCode differs from what its GSTIN
 * would derive, then whoever created that record manually set the state and
 * we should honour it as manual. Otherwise assume it was auto-detected.
 */
export function inferManuallySet(gstin: string, stateCode: string): boolean {
  if (stateCode === '') return false;
  const derived = stateFromGstin(gstin);
  if (!derived) return true; // no GSTIN prefix to auto-detect from → state was manual
  return derived.code !== stateCode;
}

// Re-export the state list + finder so callers don't have to bounce through
// indianStates.ts — one import for anyone doing GSTIN/state UI.
export { INDIAN_STATES, findStateByCode };
