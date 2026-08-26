// §8 Low-Stock Alerts — device-local preferences.
//
// These flags govern per-DEVICE UX behaviour (does this browser tab pop a
// toast on threshold-crossing? does it beep?). They are NOT business data —
// they don't sync, they don't back up, they don't restore. localStorage is
// the right home: survives reload, cleared by user, no schema bump.
//
// Defaults per spec §8: alerts ON, sound ON on a fresh install. If
// localStorage is unavailable (e.g. private-mode + no storage granted), the
// getters return the defaults and setters silently no-op — nothing here
// should ever throw and break the app.

const KEY_ALERTS_ENABLED = 'bv.lowStockAlertsEnabled';
const KEY_SOUND_ENABLED = 'bv.lowStockSoundEnabled';

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // storage disabled — accept the silent no-op, alerts just won't persist
    // across reloads on this device
  }
}

export function isLowStockAlertsEnabled(): boolean {
  // Explicit '0' means user turned it off. Absent OR '1' means on (default).
  return safeGet(KEY_ALERTS_ENABLED) !== '0';
}

export function setLowStockAlertsEnabled(enabled: boolean): void {
  safeSet(KEY_ALERTS_ENABLED, enabled ? '1' : '0');
}

export function isLowStockSoundEnabled(): boolean {
  return safeGet(KEY_SOUND_ENABLED) !== '0';
}

export function setLowStockSoundEnabled(enabled: boolean): void {
  safeSet(KEY_SOUND_ENABLED, enabled ? '1' : '0');
}
