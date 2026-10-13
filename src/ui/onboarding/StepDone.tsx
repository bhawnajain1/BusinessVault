interface Props {
  businessName: string;
  folderPath: string;
  driveFolderId: string | null;
  storage: 'google-drive' | 'local-folder';
  onFinish: () => void;
}

const SYNC_STATES: ReadonlyArray<{ label: string; desc: string; color: string }> = [
  { label: 'LOCAL_ONLY', desc: 'Just saved on this device.', color: 'bg-slate-100 text-slate-700' },
  { label: 'QUEUED', desc: 'Waiting to upload.', color: 'bg-amber-100 text-amber-800' },
  { label: 'SYNCING', desc: 'Uploading now.', color: 'bg-indigo-100 text-indigo-800' },
  { label: 'SYNCED', desc: 'Safely in your Drive.', color: 'bg-green-100 text-green-800' },
  { label: 'CONFLICT', desc: 'Same record edited on two devices — needs review.', color: 'bg-rose-100 text-rose-800' },
  { label: 'FAILED', desc: 'Upload failed after retries — action required.', color: 'bg-red-100 text-red-800' },
];

export default function StepDone({
  businessName,
  folderPath,
  driveFolderId,
  storage,
  onFinish,
}: Props) {
  const driveUrl = driveFolderId
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(driveFolderId)}`
    : null;

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-2xl font-semibold text-slate-900">
        You're set up, {businessName}.
      </h1>
      <p className="mt-2 text-slate-600">
        Your business folder is ready at{' '}
        <code className="rounded bg-slate-100 px-1 text-slate-800">{folderPath}</code>.
        Everything you enter here saves locally first, then syncs.
      </p>

      {storage === 'google-drive' && driveUrl && (
        <a
          href={driveUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-6 inline-block rounded border border-indigo-300 bg-white px-4 py-2 text-indigo-700 hover:bg-indigo-50"
        >
          Open My Google Drive Folder
        </a>
      )}

      <div className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Sync states you'll see
        </h2>
        <ul className="mt-3 space-y-2">
          {SYNC_STATES.map((s) => (
            <li key={s.label} className="flex items-start gap-3">
              <span className={'inline-block rounded px-2 py-0.5 text-xs font-mono ' + s.color}>
                {s.label}
              </span>
              <span className="text-sm text-slate-600">{s.desc}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8 flex justify-end">
        <button
          type="button"
          onClick={onFinish}
          className="rounded bg-indigo-600 px-4 py-2 text-white"
        >
          Start using BusinessVault
        </button>
      </div>
    </div>
  );
}
