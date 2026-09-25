interface Props {
  businessName: string;
  status: string;
  error: string | null;
  onRetry?: () => void;
  onBack?: () => void;
}

export default function StepConnecting({
  businessName,
  status,
  error,
  onRetry,
  onBack,
}: Props) {
  return (
    <div className="max-w-lg mx-auto p-6 text-center">
      <div className="mt-8 flex justify-center">
        <div
          className={
            'h-12 w-12 rounded-full border-4 border-slate-200 ' +
            (error ? 'border-t-red-500' : 'animate-spin border-t-indigo-500')
          }
        />
      </div>

      <h1 className="mt-6 text-xl font-semibold text-slate-900">
        {error ? 'Setup failed' : `Creating BusinessVault - ${businessName}/ in your Google Drive...`}
      </h1>
      <p className="mt-2 text-sm text-slate-600">{status}</p>

      {error && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-left text-sm text-red-700">
          {error}
        </div>
      )}

      {error && (
        <div className="mt-6 flex justify-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded border border-slate-300 px-4 py-2 text-slate-700"
            >
              Back
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded bg-indigo-600 px-4 py-2 text-white"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
