import { type OnboardingForm } from './state';

interface Props {
  form: OnboardingForm;
  onChange: (patch: Partial<OnboardingForm>) => void;
  onNext: () => void;
}

export default function StepWelcome({ form, onChange, onNext }: Props) {
  const canProceed = form.name.trim().length >= 2;

  return (
    <div className="max-w-lg mx-auto p-6">
      <h1 className="text-3xl font-semibold text-slate-900">Welcome to BusinessVault</h1>
      <p className="mt-2 text-slate-600">
        Your local-first billing and accounting for Indian small businesses. Your
        data stays on this device and syncs to your own Google Drive.
      </p>

      <div className="mt-8">
        <label className="block text-sm font-medium text-slate-700">
          Business name
        </label>
        <input
          type="text"
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="Sharma Electronics"
          autoFocus
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canProceed) onNext();
          }}
        />
        <p className="mt-1 text-xs text-slate-500">
          This becomes the name of your Google Drive folder:
           BusinessVault - {form.name.trim() || 'Sharma Electronics'}/
        </p>
      </div>

      <div className="mt-8 flex justify-end">
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
