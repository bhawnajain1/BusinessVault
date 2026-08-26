import { useMemo, useState } from 'react';
import { isValidGstin } from '../../lib/gst';
import { INDIAN_STATES, type OnboardingForm } from './state';
import {
  applyGstinChange,
  applyStateChange,
  inferManuallySet,
  type GstinStatePair,
} from '../../lib/gstinStateSync';
import GstinStateBadge from '../components/GstinStateBadge';

interface Props {
  form: OnboardingForm;
  onChange: (patch: Partial<OnboardingForm>) => void;
  onBack: () => void;
  onNext: () => void;
}

const MONTHS: ReadonlyArray<{ n: number; label: string }> = [
  { n: 1, label: 'January 1' },
  { n: 2, label: 'February 1' },
  { n: 3, label: 'March 1' },
  { n: 4, label: 'April 1' },
  { n: 5, label: 'May 1' },
  { n: 6, label: 'June 1' },
  { n: 7, label: 'July 1' },
  { n: 8, label: 'August 1' },
  { n: 9, label: 'September 1' },
  { n: 10, label: 'October 1' },
  { n: 11, label: 'November 1' },
  { n: 12, label: 'December 1' },
];

export default function StepBusinessDetails({ form, onChange, onBack, onNext }: Props) {
  // Seed the manual-latch from the *initial* form. The initial onboarding form
  // pre-fills state='Karnataka'/state_code='29' with an empty GSTIN — that's a
  // legitimate default from initialForm(), not a manual choice, so the latch
  // starts OFF and the first valid GSTIN typed will auto-fill state.
  const [stateManuallySet, setStateManuallySet] = useState(() =>
    inferManuallySet(form.gstin, form.state_code),
  );

  const gstinError = useMemo(() => {
    const g = form.gstin.trim();
    if (g === '') return null;
    if (!isValidGstin(g)) return 'Invalid GSTIN (must be 15 chars with valid check digit)';
    // Mismatch is now surfaced by GstinStateBadge as a warning that lets the
    // user proceed after acknowledging. Onboarding still refuses to advance
    // because Continue is gated on state_code being set at all.
    return null;
  }, [form.gstin]);

  const canProceed = gstinError === null && form.state_code !== '';

  function pair(): GstinStatePair {
    return {
      gstin: form.gstin,
      stateCode: form.state_code,
      stateName: form.state,
      stateManuallySet,
    };
  }
  function onGstinChange(raw: string) {
    const next = applyGstinChange(pair(), raw);
    setStateManuallySet(next.stateManuallySet);
    onChange({
      gstin: next.gstin,
      state: next.stateName,
      state_code: next.stateCode,
    });
  }
  function onStateChange(code: string) {
    const next = applyStateChange(pair(), code);
    setStateManuallySet(next.stateManuallySet);
    onChange({ state: next.stateName, state_code: next.stateCode });
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Business details</h1>
      <p className="mt-1 text-slate-600">
        These appear on your invoices. You can change everything later in Settings.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-slate-700">
            GSTIN <span className="text-slate-400">(optional)</span>
          </label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 uppercase"
            placeholder="29AABCS1234A1Z5"
            value={form.gstin}
            onChange={(e) => onGstinChange(e.target.value)}
          />
          {gstinError && (
            <p className="mt-1 text-xs text-red-600">{gstinError}</p>
          )}
          <GstinStateBadge gstin={form.gstin} stateCode={form.state_code} />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">State</label>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 bg-white"
            value={form.state_code}
            onChange={(e) => onStateChange(e.target.value)}
          >
            {INDIAN_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} — {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">
            Financial year start
          </label>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 bg-white"
            value={form.financial_year_start_month}
            onChange={(e) =>
              onChange({ financial_year_start_month: Number(e.target.value) })
            }
          >
            {MONTHS.map((m) => (
              <option key={m.n} value={m.n}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Default is April 1 (standard for Indian businesses).
          </p>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-slate-700">
            Address line 1
          </label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            placeholder="1 MG Road"
            value={form.address_line1}
            onChange={(e) => onChange({ address_line1: e.target.value })}
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-slate-700">
            Address line 2 <span className="text-slate-400">(optional)</span>
          </label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            value={form.address_line2}
            onChange={(e) => onChange({ address_line2: e.target.value })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">City</label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            placeholder="Bengaluru"
            value={form.city}
            onChange={(e) => onChange({ city: e.target.value })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">PIN code</label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            placeholder="560001"
            maxLength={6}
            value={form.pincode}
            onChange={(e) => onChange({ pincode: e.target.value.replace(/\D/g, '') })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Phone</label>
          <input
            type="tel"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            placeholder="9999999999"
            value={form.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Email</label>
          <input
            type="email"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            placeholder="owner@example.com"
            value={form.email}
            onChange={(e) => onChange({ email: e.target.value })}
          />
        </div>
      </div>

      <div className="mt-8 flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-slate-300 px-4 py-2 text-slate-700"
        >
          Back
        </button>
        <button
          type="button"
          disabled={!canProceed}
          onClick={onNext}
          className="rounded bg-indigo-600 px-4 py-2 text-white disabled:bg-slate-300"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
