// §12 — inline badge that renders next to the GSTIN/State fields.
//
//   ✓ Detected: Rajasthan (08)     — GSTIN prefix + state agree, or state
//                                      hasn't been chosen yet but GSTIN says a
//                                      valid one
//   ⚠ GSTIN 08 (Rajasthan) ≠ Maharashtra (27) — user manually chose a
//                                      state that disagrees with the GSTIN
//                                      prefix. Warn but do not overwrite.
//
// The component is intentionally plain — no context, no state, no icons from
// a lib. Every callsite just passes gstin + stateCode and gets a badge.

import { computeGstinStateStatus, findStateByCode } from '../../lib/gstinStateSync';

interface Props {
  gstin: string;
  stateCode: string;
  className?: string;
}

export default function GstinStateBadge({ gstin, stateCode, className }: Props) {
  const status = computeGstinStateStatus(gstin, stateCode);
  const detected = status.detectedFromGstin;
  if (!detected) return null;
  const cls = className ?? 'mt-1 text-xs';
  if (status.mismatch) {
    const chosen = findStateByCode(stateCode);
    const chosenLabel = chosen ? `${chosen.name} (${chosen.code})` : `code ${stateCode}`;
    return (
      <p className={`${cls} text-amber-700`} role="status">
        {`⚠ GSTIN begins with ${detected.code} (${detected.name}), but selected State is ${chosenLabel}. Please verify.`}
      </p>
    );
  }
  return (
    <p className={`${cls} text-emerald-700`} role="status">
      {`✓ Detected from GSTIN: ${detected.name} (${detected.code})`}
    </p>
  );
}
