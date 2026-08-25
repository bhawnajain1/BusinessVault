import { exportLogsAsJsonl, log } from './log';

// Triggers a browser download of the in-memory log ring as a .jsonl file.
// Callable from any UI surface — Settings, RestoreWizard error banner, or
// the "no business yet" fallback — so users can share logs whenever
// something goes wrong, not only after onboarding succeeds.
export async function downloadDebugLogs(hours: number): Promise<void> {
  try {
    log.info('logs', 'user requested log export', { hours });
    const jsonl = await exportLogsAsJsonl(hours * 60 * 60 * 1000);
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `businessvault-debug-${stamp}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    log.error('logs', 'log export failed', { error: e });
  }
}
