import { describe, expect, it } from 'vitest';
import { makeDiagnosticReport } from './diagnosticReport';

describe('makeDiagnosticReport', () => {
  it('keeps successful legacy journal normalization informational', () => {
    const report = makeDiagnosticReport({
      businessId: 'biz1',
      counts: { journal_entries: 1 },
      issues: [
        {
          severity: 'info',
          code: 'LEGACY_JOURNAL_HEADER_TOTALS_REPAIRED',
          message: 'Legacy journal header totals were normalized from their balanced journal lines.',
          detail: { entries: ['je1'] },
        },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toBe(
      'Restore verified: accounting balanced, inventory identity holds, GST reconciles.',
    );
  });
});
