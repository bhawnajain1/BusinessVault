import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ulid } from 'ulid';
import { db } from '../../db';
import { setCurrentBusinessId } from '../../lib/business';
import { seedChartOfAccounts } from '../../domain/coa';
import { seedDefaultMasters } from '../../domain/defaults';
import { appendSyncEvent } from '../../domain/syncEventLog';
import { getDeviceId } from '../../lib/device';
import type { CustomerStorageProvider } from '../../storage/CustomerStorageProvider';
import { GoogleDriveStorageProvider } from '../../drive/GoogleDriveStorageProvider';
import { LocalFolderStorageProvider } from '../../storage/LocalFolderStorageProvider';
import { adoptConnectedProvider } from '../../sync/bootProvider';
import StepBusinessDetails from './StepBusinessDetails';
import StepConnecting from './StepConnecting';
import StepConnectStorage from './StepConnectStorage';
import StepDone from './StepDone';
import StepWelcome from './StepWelcome';
import {
  formToBusiness,
  initialForm,
  sanitizeBusinessFolderName,
  type OnboardingForm,
  type OnboardingStep,
  type StorageChoice,
} from './state';

const FORM_STASH_KEY = 'bv.onboarding.form';
const STEP_STASH_KEY = 'bv.onboarding.step';

function loadFormFromStash(): { form: OnboardingForm; step: OnboardingStep } | null {
  try {
    const raw = sessionStorage.getItem(FORM_STASH_KEY);
    const step = sessionStorage.getItem(STEP_STASH_KEY) as OnboardingStep | null;
    if (!raw || !step) return null;
    return { form: JSON.parse(raw) as OnboardingForm, step };
  } catch {
    return null;
  }
}

function saveFormToStash(form: OnboardingForm, step: OnboardingStep): void {
  try {
    sessionStorage.setItem(FORM_STASH_KEY, JSON.stringify(form));
    sessionStorage.setItem(STEP_STASH_KEY, step);
  } catch {
    // sessionStorage may be blocked; onboarding still works in-memory.
  }
}

function clearFormStash(): void {
  try {
    sessionStorage.removeItem(FORM_STASH_KEY);
    sessionStorage.removeItem(STEP_STASH_KEY);
  } catch {
    // ignore
  }
}

interface ConnectingState {
  storage: StorageChoice;
  status: string;
  error: string | null;
  folderPath: string | null;
  providerFolderId: string | null;
  driveEmail: string | null;
}

export default function Onboarding() {
  const navigate = useNavigate();

  const stashed = useMemo(() => loadFormFromStash(), []);
  const [form, setForm] = useState<OnboardingForm>(() => stashed?.form ?? initialForm());
  const [step, setStep] = useState<OnboardingStep>(() => stashed?.step ?? 'welcome');
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Persist across reload / OAuth round-trip.
  useEffect(() => {
    saveFormToStash(form, step);
  }, [form, step]);

  const patchForm = useCallback((patch: Partial<OnboardingForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  // Ref so the connect-and-init effect can read latest form without re-firing.
  const formRef = useRef(form);
  formRef.current = form;

  const runInitialize = useCallback(
    async (
      choice: StorageChoice,
      localFolderHandle?: FileSystemDirectoryHandle,
    ) => {
      const currentForm = formRef.current;
      const businessId = ulid();
      const folderName = sanitizeBusinessFolderName(currentForm.name || 'Sharma Electronics');
      const nowIso = new Date().toISOString();

      setConnecting({
        storage: choice,
        status:
          choice === 'google-drive'
            ? `Creating BusinessVault/${folderName}/ in your Google Drive...`
            : `Creating BusinessVault/${folderName}/ in your local folder...`,
        error: null,
        folderPath: null,
        providerFolderId: null,
        driveEmail: null,
      });
      setStep('connecting');

      try {
        const provider = await getStorageProvider(choice, localFolderHandle);

        setConnecting((c) =>
          c ? { ...c, status: 'Creating folder structure and README...' } : c,
        );
        const init = await provider.initializeBusiness({
          businessId,
          businessName: folderName,
        });

        setConnecting((c) =>
          c ? { ...c, status: 'Saving business locally and seeding accounts...' } : c,
        );

        const email =
          choice === 'google-drive'
            ? (await provider.connectionStatus()).account ?? null
            : null;

        const businessRow = formToBusiness(
          {
            ...currentForm,
            driveFolderId: choice === 'google-drive' ? init.providerFolderId : null,
            driveEmail: email,
          },
          businessId,
          nowIso,
        );

        const deviceId = await getDeviceId();

        // Rebind Drive tokens BEFORE persisting the business row: if a rebind
        // failure aborted this after commit, we'd leave a business row whose
        // drive_folder_id is set but has no tokens keyed to its id — the next
        // boot would routes to Drive and land in needs-permission. Doing it
        // first means either both succeed, or neither is visible on disk.
        // (drive_tokens lives in a separate IndexedDB so we can't include it
        // in the transaction below.)
        if (choice === 'google-drive' && provider instanceof GoogleDriveStorageProvider) {
          const { rebindDriveTokensToBusiness } = await import('./driveGlue');
          await rebindDriveTokensToBusiness(businessId);
        }

        // Business row + system CoA + default masters must land atomically.
        // A crash between them leaves an unusable business row on disk.
        // seedChartOfAccounts/seedDefaultMasters open their own inner
        // transactions on overlapping tables — Dexie coalesces those into
        // this outer scope since we cover all tables they touch.
        await db.transaction(
          'rw',
          [
            db.businesses,
            db.accounts,
            db.units,
            db.categories,
            db.warehouses,
            db.sync_events,
          ],
          async () => {
            await db.businesses.put(businessRow);
            await appendSyncEvent(db, {
              businessId,
              deviceId,
              entityType: 'business',
              entityId: businessId,
              operation: 'created',
              payload: businessRow,
              timestamp: nowIso,
            });
            await seedChartOfAccounts(businessId, { db, deviceId });
            await seedDefaultMasters(businessId, { deviceId });
          },
        );
        await setCurrentBusinessId(businessId);

        // Register the connected provider and start the sync worker so that
        // items/invoices/etc. created in this session actually flush to the
        // customer's storage (journal/*.jsonl, current/*.csv). Drive tokens
        // were rebound above; here we just adopt the connected provider.
        if (choice === 'local-folder' && provider instanceof LocalFolderStorageProvider) {
          adoptConnectedProvider(provider, businessId);
        } else if (choice === 'google-drive' && provider instanceof GoogleDriveStorageProvider) {
          adoptConnectedProvider(provider, businessId);
        }

        setConnecting({
          storage: choice,
          status: 'Ready.',
          error: null,
          folderPath: init.folderPath,
          providerFolderId: init.providerFolderId,
          driveEmail: email,
        });
        setForm((prev) => ({
          ...prev,
          storage: choice,
          driveFolderPath: init.folderPath,
          driveFolderId: choice === 'google-drive' ? init.providerFolderId : null,
          driveEmail: email,
        }));
        setStep('done');
      } catch (err) {
        setConnecting({
          storage: choice,
          status: 'Setup could not complete.',
          error: err instanceof Error ? err.message : String(err),
          folderPath: null,
          providerFolderId: null,
          driveEmail: null,
        });
      }
    },
    [],
  );

  // Legacy: old server-flow used a `?connected=drive` (or `?reconnect=1`)
  // callback URL. Under GIS the popup resolves inline — nothing to resume from
  // the URL. If a stale link still lands here with those params, strip them so
  // a refresh doesn't confuse the user, but do NOT auto-connect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('connected') || params.has('reconnect')) {
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChoose = useCallback(
    async (
      choice: StorageChoice,
      localFolderHandle?: FileSystemDirectoryHandle,
    ) => {
      setConnectError(null);
      if (choice === 'google-drive') {
        try {
          const needsAuth = await providerNeedsAuth('google-drive');
          if (needsAuth) {
            // GIS popup: resolves inline once the user consents. If they cancel
            // the popup, startDriveOAuth throws — surface as error and stay on
            // this step.
            await beginGoogleOAuth();
          }
        } catch (err) {
          setConnectError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      void runInitialize(choice, localFolderHandle);
    },
    [runInitialize],
  );

  const handleFinish = useCallback(() => {
    clearFormStash();
    navigate('/pos');
  }, [navigate]);

  return (
    <div className="min-h-screen bg-slate-50">
      <ProgressBar step={step} />
      {step === 'welcome' && (
        <StepWelcome
          form={form}
          onChange={patchForm}
          onNext={() => setStep('details')}
        />
      )}
      {step === 'details' && (
        <StepBusinessDetails
          form={form}
          onChange={patchForm}
          onBack={() => setStep('welcome')}
          onNext={() => setStep('connect')}
        />
      )}
      {step === 'connect' && (
        <StepConnectStorage
          onChoose={handleChoose}
          onBack={() => setStep('details')}
          error={connectError}
        />
      )}
      {step === 'connecting' && connecting && (
        <StepConnecting
          businessName={sanitizeBusinessFolderName(form.name || 'Sharma Electronics')}
          status={connecting.status}
          error={connecting.error}
          onRetry={() => runInitialize(connecting.storage)}
          onBack={() => setStep('connect')}
        />
      )}
      {step === 'done' && connecting && (
        <StepDone
          businessName={form.name || 'your business'}
          folderPath={connecting.folderPath ?? `BusinessVault/${form.name}`}
          driveFolderId={connecting.providerFolderId}
          storage={connecting.storage}
          onFinish={handleFinish}
        />
      )}
    </div>
  );
}

function ProgressBar({ step }: { step: OnboardingStep }) {
  const order: OnboardingStep[] = ['welcome', 'details', 'connect', 'connecting', 'done'];
  const idx = order.indexOf(step);
  const pct = Math.round(((idx + 1) / order.length) * 100);
  return (
    <div className="h-1 w-full bg-slate-200">
      <div
        className="h-1 bg-indigo-500 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storage-provider glue. Grug-brained: two concrete branches, no factory
// pattern layer. If we add S3 later we add an `else if` here.
// ---------------------------------------------------------------------------

let cachedProvider: { kind: StorageChoice; provider: CustomerStorageProvider } | null = null;

async function getStorageProvider(
  choice: StorageChoice,
  localFolderHandle?: FileSystemDirectoryHandle,
): Promise<CustomerStorageProvider> {
  if (cachedProvider && cachedProvider.kind === choice) return cachedProvider.provider;

  if (choice === 'local-folder') {
    const provider = new LocalFolderStorageProvider();
    // Inject the handle picked inside the user click so connect() doesn't
    // try to open showDirectoryPicker (which would need a fresh gesture).
    if (localFolderHandle) provider.setDirectoryHandle(localFolderHandle);
    await provider.connect({ kind: 'local-folder', rootPath: '' });
    cachedProvider = { kind: 'local-folder', provider };
    return provider;
  }

  // google-drive
  const { buildDriveProvider } = await import('./driveGlue');
  const provider = await buildDriveProvider();
  cachedProvider = { kind: 'google-drive', provider };
  return provider;
}

async function providerNeedsAuth(choice: StorageChoice): Promise<boolean> {
  if (choice !== 'google-drive') return false;
  const { hasValidDriveTokens } = await import('./driveGlue');
  return !(await hasValidDriveTokens());
}

async function beginGoogleOAuth(): Promise<void> {
  const { startDriveOAuth } = await import('./driveGlue');
  // Under GIS this opens the account-picker popup and resolves once the user
  // consents. `returnTo` is unused but preserved for API stability.
  await startDriveOAuth({ returnTo: '/onboarding' });
}
