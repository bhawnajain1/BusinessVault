import { useState } from 'react';
import type { StorageChoice } from './state';

interface Props {
  onChoose: (
    choice: StorageChoice,
    localFolderHandle?: FileSystemDirectoryHandle,
  ) => void | Promise<void>;
  onBack: () => void;
  error: string | null;
}

function pickerAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === 'function'
  );
}

export default function StepConnectStorage({ onChoose, onBack, error }: Props) {
  const [pickError, setPickError] = useState<string | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);

  // Runs synchronously from the button click so Chrome still has the user
  // gesture and the folder picker can open. Awaiting anything before this is
  // the reason "Setup could not complete / not connected" happened.
  const onLocalClick = async (): Promise<void> => {
    setPickError(null);
    if (!pickerAvailable()) {
      setPickError(
        'Your browser does not support the File System Access API. Use Chrome, Edge, or Arc.',
      );
      return;
    }
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (o?: {
          mode?: 'readwrite';
        }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      const handle = await picker({ mode: 'readwrite' });
      await onChoose('local-folder', handle);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.toLowerCase().includes('abort')) return; // user cancelled
        setPickError(`Local folder setup failed: ${msg}`);
    }
  };

  return (
    <div className="max-w-lg mx-auto p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Where should we keep your data?</h1>
      <p className="mt-1 text-slate-600">
        BusinessVault stores every record locally on this device first, then
        syncs a portable copy (CSV + event journal) to storage you own. We use
        the minimum permission (drive.file) and can only see files this app
        creates.
      </p>

      {(error || pickError) && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error || pickError}
        </div>
      )}

      <button
        type="button"
        onClick={async () => {
          setDriveBusy(true);
          try {
            await onChoose('google-drive');
          } finally {
            setDriveBusy(false);
          }
        }}
        disabled={driveBusy}
        className="mt-8 w-full rounded-lg bg-indigo-600 px-6 py-6 text-lg font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-60"
      >
        {driveBusy ? 'Opening Google…' : 'Connect Google Drive'}
      </button>
      <p className="mt-2 text-xs text-slate-500">
        We will create a normal, visible folder called BusinessVault/&lt;your
        business&gt;/ in your Google Drive. You can open, download or copy it
        at any time.
      </p>

      <div className="mt-8 flex items-center gap-2">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="text-xs uppercase tracking-wide text-slate-400">or</span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <button
        type="button"
        onClick={() => void onLocalClick()}
        className="mt-6 w-full rounded border border-slate-300 bg-white px-4 py-3 text-slate-700 hover:bg-slate-50"
      >
        Choose local folder…
      </button>
      <p className="mt-2 text-xs text-slate-500">
        Picks a folder on this computer. Nothing is uploaded. Chrome will show
        a permission prompt — click Allow.
      </p>

      <div className="mt-8 flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-slate-300 px-4 py-2 text-slate-700"
        >
          Back
        </button>
      </div>
    </div>
  );
}
