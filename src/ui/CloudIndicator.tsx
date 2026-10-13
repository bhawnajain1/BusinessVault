import { useNavigate } from 'react-router-dom';
import { CloudAlert, CloudCheck, RefreshCw } from 'lucide-react';
import { useBackupHealth } from './BackupHealthContext';
import type { BackupHealthStatus } from '../sync/syncWorker';

// Spec §29: three visible states in the header.
//   ☁ ✓  Backed up (HEALTHY)
//   ☁ ↻  Syncing (SYNCING) — animated pulse
//   ☁ !  Backup problem (OFFLINE/DISCONNECTED/ERROR/CONFLICT/INTEGRITY_FAILURE) — amber
// The cloud glyph is spec-mandated; the other symbols are also spec examples.
// Non-interruptive: clicking navigates to Data & Backup (no modal).

type Visual = 'ok' | 'syncing' | 'problem';

function visualFor(status: BackupHealthStatus): Visual {
  if (status === 'HEALTHY') return 'ok';
  if (status === 'SYNCING') return 'syncing';
  return 'problem';
}

function labelFor(status: BackupHealthStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'Backed up';
    case 'SYNCING':
      return 'Syncing';
    case 'OFFLINE':
      return 'Offline — changes queued';
    case 'DISCONNECTED':
      return 'Google Drive disconnected';
    case 'CONFLICT':
      return 'Backup conflict';
    case 'INTEGRITY_FAILURE':
      return 'Backup integrity failure';
    case 'ERROR':
    default:
      return 'Backup problem';
  }
}

export default function CloudIndicator() {
  const nav = useNavigate();
  const health = useBackupHealth();
  const visual = visualFor(health.status);

  const base =
    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold select-none transition-colors';
  const tone =
    visual === 'ok'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
      : visual === 'syncing'
        ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
        : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100';

  const label = labelFor(health.status);
  const Icon = visual === 'ok' ? CloudCheck : visual === 'syncing' ? RefreshCw : CloudAlert;

  return (
    <button
      type="button"
      onClick={() => nav('/settings/backup')}
      className={`${base} ${tone}`}
      aria-label={`Backup status: ${label}. Click to open Data & Backup.`}
      title={label}
      data-testid="cloud-indicator"
      data-status={health.status}
    >
      <Icon className={`h-4 w-4 ${visual === 'syncing' ? 'animate-spin [animation-duration:2s]' : ''}`} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
