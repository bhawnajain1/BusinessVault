import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db';
import type { Business } from '../../db/types';
import { currentBusinessId } from '../../lib/business';
import { INDIAN_STATES } from '../../lib/indianStates';
import {
  applyGstinChange,
  applyStateChange,
  inferManuallySet,
  type GstinStatePair,
} from '../../lib/gstinStateSync';
import GstinStateBadge from '../components/GstinStateBadge';
import { seedDefaultMasters } from '../../domain/defaults';
import { seedChartOfAccounts } from '../../domain/coa';
import { appendSyncEvent } from '../../domain/syncEventLog';
import { getDeviceId } from '../../lib/device';
import { downloadDebugLogs } from '../../lib/downloadLogs';
import { downloadDiagnosticReport } from '../../lib/diagnosticBundle';
import {
  BusinessProfileService,
  SignatureValidationError,
} from '../../domain/BusinessProfileService';
import { log } from '../../lib/log';
import {
  isLowStockAlertsEnabled,
  isLowStockSoundEnabled,
  setLowStockAlertsEnabled,
  setLowStockSoundEnabled,
} from '../../lib/lowStockPrefs';
import { playLowStockSound } from '../../lib/lowStockSound';

interface Counts {
  units: number;
  categories: number;
  warehouses: number;
  customers: number;
  suppliers: number;
  items: number;
  invoices: number;
  accounts: number;
}

export default function Settings() {
  const [business, setBusiness] = useState<Business | null>(null);
  const [form, setForm] = useState<Partial<Business>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [stateManuallySet, setStateManuallySet] = useState(false);

  async function loadCounts(businessId: string) {
    const [units, categories, warehouses, customers, suppliers, items, invoices, accounts] =
      await Promise.all([
        db.units.where('business_id').equals(businessId).count(),
        db.categories.where('business_id').equals(businessId).count(),
        db.warehouses.where('business_id').equals(businessId).count(),
        db.customers.where('business_id').equals(businessId).count(),
        db.suppliers.where('business_id').equals(businessId).count(),
        db.items.where('business_id').equals(businessId).count(),
        db.invoices.where('business_id').equals(businessId).count(),
        db.accounts.where('business_id').equals(businessId).count(),
      ]);
    setCounts({ units, categories, warehouses, customers, suppliers, items, invoices, accounts });
  }

  useEffect(() => {
    (async () => {
      let b: Business | null = null;
      try {
        const id = await currentBusinessId();
        b = (await db.businesses.get(id)) ?? null;
      } catch {
        b = null;
      }
      setBusiness(b);
      if (b) {
        setForm(b);
        setStateManuallySet(inferManuallySet(b.gstin ?? '', b.state_code ?? ''));
        await loadCounts(b.id);
      }
    })();
  }, []);

  async function save() {
    if (!business) return;
    log.info('settings', 'business profile save requested', {
      businessId: business.id,
      changedKeys: Object.keys(form).filter(
        (k) => (form as Record<string, unknown>)[k] !== (business as unknown as Record<string, unknown>)[k],
      ),
    });
    setSaving(true);
    setSaved(false);
    try {
      const patched: Business = {
        ...business,
        ...form,
        updated_at: new Date().toISOString(),
        entity_version: (business.entity_version ?? 0) + 1,
      };
      const deviceId = await getDeviceId();
      await db.transaction(
        'rw',
        [db.businesses, db.sync_events],
        async () => {
          await db.businesses.put(patched);
          await appendSyncEvent(db, {
            businessId: patched.id,
            deviceId,
            entityType: 'business',
            entityId: patched.id,
            operation: 'updated',
            payload: patched,
            timestamp: patched.updated_at,
          });
        },
      );
      setBusiness(patched);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      log.info('settings', 'business profile save committed', {
        businessId: business.id,
        entityVersion: patched.entity_version,
      });
    } finally {
      setSaving(false);
    }
  }

  // Signature block state — mirrors BusinessProfileService operations.
  const [signaturePreviewUrl, setSignaturePreviewUrl] = useState<string | null>(null);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [signatureBusy, setSignatureBusy] = useState(false);
  const signatureInputRef = useRef<HTMLInputElement | null>(null);

  // §8 Low-Stock Alerts — device-local preferences (localStorage-backed).
  // Kept as local state so the toggles feel instant; the setters push to
  // storage synchronously. See src/lib/lowStockPrefs.ts.
  const [lowStockAlerts, setLowStockAlertsState] = useState<boolean>(() =>
    isLowStockAlertsEnabled(),
  );
  const [lowStockSound, setLowStockSoundState] = useState<boolean>(() =>
    isLowStockSoundEnabled(),
  );
  const [testSoundBusy, setTestSoundBusy] = useState(false);

  function handleLowStockAlertsToggle(enabled: boolean) {
    setLowStockAlertsEnabled(enabled);
    setLowStockAlertsState(enabled);
    log.info('settings', 'low stock alerts toggled', { enabled });
  }
  function handleLowStockSoundToggle(enabled: boolean) {
    setLowStockSoundEnabled(enabled);
    setLowStockSoundState(enabled);
    log.info('settings', 'low stock sound toggled', { enabled });
  }
  async function handleTestSound() {
    setTestSoundBusy(true);
    log.info('settings', 'test sound clicked');
    try {
      // `force=true` resumes a suspended AudioContext because this call
      // happens inside a direct click handler — the browser policy that
      // gates the automatic path allows this one.
      await playLowStockSound(true);
    } finally {
      setTestSoundBusy(false);
    }
  }

  // Refresh the preview URL whenever the business's `signature_ref` changes.
  // We hold the object URL in state so React can render it AND clean it up on
  // unmount / next-change; a raw `URL.createObjectURL()` inline would leak.
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    (async () => {
      const ref = business?.signature_ref ?? null;
      if (!ref) {
        setSignaturePreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        return;
      }
      const att = await db.attachments.get(ref);
      if (cancelled) return;
      if (!att || !att.blob) {
        log.warn('settings', 'signature preview missing blob', {
          businessId: business?.id,
          signatureRef: ref,
          hasRow: !!att,
        });
        setSignaturePreviewUrl(null);
        return;
      }
      const url = URL.createObjectURL(att.blob);
      revoked = url;
      setSignaturePreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [business?.id, business?.signature_ref]);

  async function handleSignatureUpload(file: File) {
    if (!business) return;
    setSignatureError(null);
    setSignatureBusy(true);
    log.info('settings', 'signature upload start', {
      businessId: business.id,
      filename: file.name,
      sizeBytes: file.size,
    });
    try {
      const svc = new BusinessProfileService(db);
      const { business: patched } = await svc.uploadSignature(business.id, file);
      const deviceId = await getDeviceId();
      await appendSyncEvent(db, {
        businessId: patched.id,
        deviceId,
        entityType: 'business',
        entityId: patched.id,
        operation: 'updated',
        payload: patched,
        timestamp: patched.updated_at,
      });
      setBusiness(patched);
      setForm((f) => ({
        ...f,
        signature_ref: patched.signature_ref,
        show_signature_on_invoice: patched.show_signature_on_invoice,
      }));
    } catch (e) {
      const msg =
        e instanceof SignatureValidationError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      log.warn('settings', 'signature upload failed', {
        businessId: business.id,
        error: msg,
      });
      setSignatureError(msg);
    } finally {
      setSignatureBusy(false);
      if (signatureInputRef.current) signatureInputRef.current.value = '';
    }
  }

  async function handleSignatureRemove() {
    if (!business) return;
    setSignatureError(null);
    setSignatureBusy(true);
    log.info('settings', 'signature remove start', { businessId: business.id });
    try {
      const svc = new BusinessProfileService(db);
      const patched = await svc.removeSignature(business.id);
      const deviceId = await getDeviceId();
      await appendSyncEvent(db, {
        businessId: patched.id,
        deviceId,
        entityType: 'business',
        entityId: patched.id,
        operation: 'updated',
        payload: patched,
        timestamp: patched.updated_at,
      });
      setBusiness(patched);
      setForm((f) => ({
        ...f,
        signature_ref: null,
        show_signature_on_invoice: 0,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('settings', 'signature remove failed', {
        businessId: business.id,
        error: msg,
      });
      setSignatureError(msg);
    } finally {
      setSignatureBusy(false);
    }
  }

  async function handleShowSignatureToggle(enabled: boolean) {
    if (!business) return;
    setSignatureError(null);
    setSignatureBusy(true);
    log.info('settings', 'signature toggle start', {
      businessId: business.id,
      enabled,
    });
    try {
      const svc = new BusinessProfileService(db);
      const patched = await svc.setShowSignatureOnInvoice(business.id, enabled);
      const deviceId = await getDeviceId();
      await appendSyncEvent(db, {
        businessId: patched.id,
        deviceId,
        entityType: 'business',
        entityId: patched.id,
        operation: 'updated',
        payload: patched,
        timestamp: patched.updated_at,
      });
      setBusiness(patched);
      setForm((f) => ({
        ...f,
        show_signature_on_invoice: patched.show_signature_on_invoice,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('settings', 'signature toggle failed', {
        businessId: business.id,
        error: msg,
      });
      setSignatureError(msg);
    } finally {
      setSignatureBusy(false);
    }
  }

  async function seedMasters() {
    if (!business) return;
    setSeedError(null);
    try {
      await seedDefaultMasters(business.id);
      await loadCounts(business.id);
    } catch (e) {
      setSeedError(e instanceof Error ? e.message : String(e));
    }
  }

  const [repairMsg, setRepairMsg] = useState<string | null>(null);
  async function repairChartOfAccounts() {
    if (!business) return;
    setRepairMsg(null);
    try {
      const before = await db.accounts.where('business_id').equals(business.id).count();
      await seedChartOfAccounts(business.id);
      const after = await db.accounts.where('business_id').equals(business.id).count();
      const added = after - before;
      setRepairMsg(
        added === 0
          ? 'Chart of accounts already complete — nothing to add.'
          : `Added ${added} missing system account${added === 1 ? '' : 's'}.`,
      );
      await loadCounts(business.id);
    } catch (e) {
      setRepairMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!business) {
    // Pre-onboarding fallback. Restore-from-Drive failures land users here
    // (no business row created yet), so we surface Download logs inline —
    // otherwise they cannot export the JSONL trace we'd need to diagnose.
    return (
      <div className="p-6 text-slate-600 max-w-xl space-y-4">
        <p>No business found. Complete onboarding first.</p>
        <div className="flex gap-2">
          <Link
            to="/onboarding"
            className="inline-block rounded bg-slate-900 px-4 py-2 text-sm text-white"
          >
            Go to onboarding
          </Link>
          <Link
            to="/restore"
            className="inline-block rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            Restore from backup
          </Link>
        </div>
        <div className="border-t border-slate-200 pt-4">
          <p className="text-sm text-slate-700 mb-2">
            Trouble with onboarding or restore? Export the local debug log to share when reporting an issue.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => downloadDebugLogs(1)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Last hour
            </button>
            <button
              onClick={() => downloadDebugLogs(24)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Last 24 hours
            </button>
            <button
              onClick={() => downloadDebugLogs(24 * 7)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Last 7 days
            </button>
          </div>
        </div>
      </div>
    );
  }

  const set = <K extends keyof Business>(k: K, v: Business[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="p-6 max-w-3xl flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Business profile</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Business name</span>
            <input
              value={form.name ?? ''}
              onChange={(e) => set('name', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Legal name</span>
            <input
              value={form.legal_name ?? ''}
              onChange={(e) => set('legal_name', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">GSTIN</span>
            <input
              value={form.gstin ?? ''}
              onChange={(e) => {
                const pair: GstinStatePair = {
                  gstin: form.gstin ?? '',
                  stateCode: form.state_code ?? '',
                  stateName: form.state ?? '',
                  stateManuallySet,
                };
                const next = applyGstinChange(pair, e.target.value);
                setStateManuallySet(next.stateManuallySet);
                setForm((f) => ({
                  ...f,
                  gstin: next.gstin,
                  state: next.stateName,
                  state_code: next.stateCode,
                }));
              }}
              placeholder="15-char GSTIN"
              className="w-full border border-slate-300 rounded px-2 py-1.5 uppercase"
            />
            <GstinStateBadge gstin={form.gstin ?? ''} stateCode={form.state_code ?? ''} />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">State</span>
            <select
              value={form.state_code ?? ''}
              onChange={(e) => {
                const pair: GstinStatePair = {
                  gstin: form.gstin ?? '',
                  stateCode: form.state_code ?? '',
                  stateName: form.state ?? '',
                  stateManuallySet,
                };
                const next = applyStateChange(pair, e.target.value);
                setStateManuallySet(next.stateManuallySet);
                setForm((f) => ({
                  ...f,
                  state: next.stateName,
                  state_code: next.stateCode,
                }));
              }}
              className="w-full border border-slate-300 rounded px-2 py-1.5 bg-white"
            >
              <option value="">— Select state —</option>
              {INDIAN_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-slate-700 mb-1">PAN</span>
            <input
              value={form.pan ?? ''}
              onChange={(e) => set('pan', e.target.value.toUpperCase())}
              className="w-full border border-slate-300 rounded px-2 py-1.5 uppercase"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Address line 1</span>
            <input
              value={form.address_line1 ?? ''}
              onChange={(e) => set('address_line1', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-2">
            <span className="block text-slate-700 mb-1">Address line 2</span>
            <input
              value={form.address_line2 ?? ''}
              onChange={(e) => set('address_line2', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">City</span>
            <input
              value={form.city ?? ''}
              onChange={(e) => set('city', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Pincode</span>
            <input
              value={form.pincode ?? ''}
              onChange={(e) => set('pincode', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Phone</span>
            <input
              value={form.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Email</span>
            <input
              value={form.email ?? ''}
              onChange={(e) => set('email', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">Invoice prefix</span>
            <input
              value={form.invoice_prefix ?? ''}
              onChange={(e) => set('invoice_prefix', e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label>
            <span className="block text-slate-700 mb-1">FY start month</span>
            <select
              value={form.financial_year_start_month ?? 4}
              onChange={(e) =>
                set('financial_year_start_month', Number(e.target.value))
              }
              className="w-full border border-slate-300 rounded px-2 py-1.5 bg-white"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {new Date(2000, m - 1, 1).toLocaleString('en-IN', { month: 'long' })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">Authorised Signature</h2>
        <p className="text-xs text-slate-500 mb-3">
          Upload a scanned signature (PNG, JPG, or WebP, up to 2 MB and 2000×2000 px).
          Enable the toggle to print it on new invoices. Historical invoices keep the
          signature they were issued with — replacing this image will NOT change them.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
          <div className="border border-slate-200 rounded bg-slate-50 w-[220px] h-[110px] flex items-center justify-center overflow-hidden">
            {signaturePreviewUrl ? (
              <img
                src={signaturePreviewUrl}
                alt="Authorised signature"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-xs text-slate-400">No signature uploaded</span>
            )}
          </div>
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <input
                ref={signatureInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleSignatureUpload(f);
                }}
              />
              <button
                type="button"
                onClick={() => signatureInputRef.current?.click()}
                disabled={signatureBusy}
                className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50"
              >
                {business.signature_ref ? 'Replace signature' : 'Upload signature'}
              </button>
              {business.signature_ref && (
                <button
                  type="button"
                  onClick={() => void handleSignatureRemove()}
                  disabled={signatureBusy}
                  className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={(business.show_signature_on_invoice ?? 0) === 1}
                disabled={signatureBusy || !business.signature_ref}
                onChange={(e) => void handleShowSignatureToggle(e.target.checked)}
              />
              Show signature on new invoices
            </label>
            {signatureError && (
              <div className="text-xs text-rose-600">{signatureError}</div>
            )}
          </div>
        </div>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">Notifications</h2>
        <p className="text-xs text-slate-500 mb-3">
          Alert when an item's stock drops below its reorder level. Alerts fire
          only on threshold-crossing — once an item is low, it won't beep again
          until stock goes back up and dips a second time.
        </p>
        <div className="flex flex-col gap-2 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={lowStockAlerts}
              onChange={(e) => handleLowStockAlertsToggle(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Low Stock Alerts</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={lowStockSound}
              onChange={(e) => handleLowStockSoundToggle(e.target.checked)}
              disabled={!lowStockAlerts}
              className="h-4 w-4"
            />
            <span className={lowStockAlerts ? '' : 'text-slate-400'}>
              Notification sound
            </span>
          </label>
          <div>
            <button
              type="button"
              onClick={() => void handleTestSound()}
              disabled={testSoundBusy || !lowStockSound || !lowStockAlerts}
              className="mt-1 text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100 disabled:opacity-50"
            >
              {testSoundBusy ? 'Playing…' : 'Test sound'}
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Browsers may block sound until you interact with the page — press
              Test sound once to unlock automatic alerts for this tab.
            </p>
          </div>
        </div>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Master data</h2>
        {counts && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-700">
            <div className="flex justify-between"><dt>Units</dt><dd>{counts.units}</dd></div>
            <div className="flex justify-between"><dt>Categories</dt><dd>{counts.categories}</dd></div>
            <div className="flex justify-between"><dt>Warehouses</dt><dd>{counts.warehouses}</dd></div>
            <div className="flex justify-between"><dt>Customers</dt><dd>{counts.customers}</dd></div>
            <div className="flex justify-between"><dt>Suppliers</dt><dd>{counts.suppliers}</dd></div>
            <div className="flex justify-between"><dt>Items</dt><dd>{counts.items}</dd></div>
            <div className="flex justify-between"><dt>Invoices</dt><dd>{counts.invoices}</dd></div>
            <div className="flex justify-between"><dt>Accounts (CoA)</dt><dd>{counts.accounts}</dd></div>
          </dl>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={seedMasters}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Seed default units / categories / warehouse
          </button>
          <button
            type="button"
            onClick={repairChartOfAccounts}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Repair chart of accounts
          </button>
        </div>
        {seedError && <div className="mt-2 text-sm text-rose-600">{seedError}</div>}
        {repairMsg && (
          <div
            className={`mt-2 text-sm ${repairMsg.startsWith('Error') ? 'text-rose-600' : 'text-emerald-600'}`}
          >
            {repairMsg}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Both are idempotent — they only add rows that are missing. Existing data is untouched.
        </p>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Data & backup</h2>
        <ul className="text-sm space-y-2">
          <li>
            <Link to="/settings/backup" className="text-blue-700 hover:underline">
              Backup status &amp; Google Drive settings →
            </Link>
          </li>
          <li>
            <Link to="/restore" className="text-blue-700 hover:underline">
              Restore business from Drive →
            </Link>
          </li>
        </ul>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Debug logs
        </h2>
        <p className="text-xs text-slate-600 mb-3">
          The app keeps the last ~5000 log entries locally. When reporting a bug,
          download the last 24 hours as a JSONL file and attach it.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => downloadDebugLogs(1)}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Download last 1 hour
          </button>
          <button
            type="button"
            onClick={() => downloadDebugLogs(24)}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Download last 24 hours
          </button>
          <button
            type="button"
            onClick={() => downloadDebugLogs(24 * 7)}
            className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
          >
            Download last 7 days
          </button>
        </div>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Support / Diagnostics
        </h2>
        <p className="text-xs text-slate-600 mb-3">
          Bundles the last 24 hours of debug logs together with app version,
          schema version, browser info, recent audit entries, recent Drive
          backup/restore events, and a trial-balance / receivables snapshot —
          all in one JSON file for support triage. OAuth tokens, passwords,
          and signature blobs are stripped before export.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              void downloadDiagnosticReport();
            }}
            className="text-sm border border-indigo-300 bg-indigo-50 text-indigo-700 rounded px-3 py-1.5 hover:bg-indigo-100"
          >
            Export Diagnostic Report
          </button>
        </div>
      </section>

      <section className="border border-slate-200 rounded p-4 bg-white text-sm text-slate-600">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">About this device</h2>
        <div>Business ID: <code className="text-xs">{business.id}</code></div>
        <div>Schema version: {business.schema_version}</div>
        <div>Current FY: {business.current_financial_year}</div>
      </section>
    </div>
  );
}
