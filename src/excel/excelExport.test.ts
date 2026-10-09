/**
 * Regression test for formula-injection prefix coverage in Excel export.
 *
 * Defect: FORMULA_PREFIXES was missing '\t' and '\r'. Attackers could inject
 * a leading tab/CR into a text field which, once opened in Excel, could still
 * be interpreted as a formula.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import example from '../../docs/fixtures/gst-working-example.json';
import { BusinessVaultDB } from '../db/database';
import type { Business } from '../db/types';
import type { MonthlyGstCalculation } from '../domain/gstReporting/types';
import { GstMonthlyReportService } from '../domain/gstReporting/GstMonthlyReportService';
import { safeCell, buildBusinessExcelExport } from './excelExport';

vi.mock('../domain/AccountingService', () => ({
  profitAndLoss: vi.fn(async () => ({ from: '2025-05-01', to: '2025-06-30', by_account: [], revenue_paise: 0, other_income_paise: 0, cogs_paise: 0, gross_profit_paise: 0, operating_expenses_paise: 0, net_profit_paise: 0 })),
  balanceSheet: vi.fn(async () => ({ as_of: '2025-06-30', assets: { by_account: [], total_paise: 0 }, liabilities: { by_account: [], total_paise: 0 }, equity: { by_account: [], total_paise: 0 }, balanced: true, difference_paise: 0 })),
  trialBalance: vi.fn(async () => []),
}));

describe('excelExport safeCell — formula-injection sanitization', () => {
  it('prefixes standard formula sigils', () => {
    expect(safeCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(safeCell('+1+1')).toBe("'+1+1");
    expect(safeCell('-2')).toBe("'-2");
    expect(safeCell('@cmd')).toBe("'@cmd");
  });

  it("prefixes '\\t' and '\\r' (regression — previously missing)", () => {
    expect(safeCell('\tSUM(A1)')).toBe("'\tSUM(A1)");
    expect(safeCell('\rEVIL()')).toBe("'\rEVIL()");
  });

  it('leaves benign values alone', () => {
    expect(safeCell('Acme Ltd')).toBe('Acme Ltd');
    expect(safeCell(42)).toBe(42);
    expect(safeCell(null)).toBe(null);
    expect(safeCell(undefined)).toBe(null);
    expect(safeCell('')).toBe('');
  });
});

it('keeps the general GST Summary sheet but obtains complete month workings from the supplied DB service', async () => {
  const db = new BusinessVaultDB(`gst-general-export-${Date.now()}`);
  const calculation = example.calculations[0] as MonthlyGstCalculation;
  const calculate = vi.spyOn(GstMonthlyReportService.prototype, 'calculateMonths').mockImplementation(async (_id, months) => months.map(month => ({ ...calculation, period: { ...calculation.period, periodKey: month } })));
  const workspace = vi.spyOn(GstMonthlyReportService.prototype, 'loadWorkspace').mockResolvedValue({ businesses: [], profiles: [], aato: [], savedRuns: [], itcEntries: [], reviewPurchases: [], auditLog: [] });
  try {
    await db.businesses.put({ id: calculation.businessId, name: 'Synthetic Example Shop', gstin: 'SYNTHETIC-NOT-A-GSTIN', state_code: '27' } as Business);
    const result = await buildBusinessExcelExport(calculation.businessId, { db, fromDate: new Date('2025-05-17T00:00:00Z'), toDate: new Date('2025-06-04T00:00:00Z'), asOf: new Date('2025-06-04T00:00:00Z') });
    expect(calculate.mock.calls.map(call => call[1])).toEqual([['2025-05'], ['2025-06']]);
    expect(workspace).toHaveBeenCalledWith(calculation.businessId);
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(result.blob);
    });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('GST Summary')!;
    const headers = sheet.getRow(1).values as string[];
    expect(headers).not.toContain('tax_rate_pct');
    expect(sheet.rowCount).toBe(13);
    expect(sheet.getCell(2, headers.indexOf('Tax Period')).value).toBe('2025-05');
    expect(sheet.getCell(2, headers.indexOf('total')).value).toBe(1.18);
    expect(sheet.getCell(2, headers.indexOf('status')).value).toBe('INCOMPLETE');
    expect(sheet.getCell(2, headers.indexOf('notes')).value).toContain('Complete calendar-month working');
    expect(sheet.getCell(2, headers.indexOf('notes')).value).toContain('Open GST Reports');
    expect(sheet.getCell(2, headers.indexOf('source_data_hash')).value).toBe(calculation.sourceDataHash);
  } finally { calculate.mockRestore(); workspace.mockRestore(); await db.delete(); }
});
