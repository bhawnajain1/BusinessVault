import { db } from '../../db';
import { getDeviceId } from '../../lib/device';
import { GstMonthlyReportService } from './GstMonthlyReportService';

// Resolve the device before opening a durable transaction on the business DB.
async function service(): Promise<GstMonthlyReportService> {
  return new GstMonthlyReportService(db, await getDeviceId());
}

export const gstMonthlyReportService = {
  loadWorkspace: async (...args: Parameters<GstMonthlyReportService['loadWorkspace']>) => (await service()).loadWorkspace(...args),
  loadSavedReport: async (...args: Parameters<GstMonthlyReportService['loadSavedReport']>) => (await service()).loadSavedReport(...args),
  calculateMonths: async (...args: Parameters<GstMonthlyReportService['calculateMonths']>) => (await service()).calculateMonths(...args),
  calculateQuarter: async (...args: Parameters<GstMonthlyReportService['calculateQuarter']>) => (await service()).calculateQuarter(...args),
  saveNote: async (...args: Parameters<GstMonthlyReportService['saveNote']>) => (await service()).saveNote(...args),
  confirmNilPeriod: async (...args: Parameters<GstMonthlyReportService['confirmNilPeriod']>) => (await service()).confirmNilPeriod(...args),
  saveProfile: async (...args: Parameters<GstMonthlyReportService['saveProfile']>) => (await service()).saveProfile(...args),
  setAato: async (...args: Parameters<GstMonthlyReportService['setAato']>) => (await service()).setAato(...args),
  saveDocumentMetadata: async (...args: Parameters<GstMonthlyReportService['saveDocumentMetadata']>) => (await service()).saveDocumentMetadata(...args),
  reviewItc: async (...args: Parameters<GstMonthlyReportService['reviewItc']>) => (await service()).reviewItc(...args),
  addAdjustment: async (...args: Parameters<GstMonthlyReportService['addAdjustment']>) => (await service()).addAdjustment(...args),
  saveReport: async (...args: Parameters<GstMonthlyReportService['saveReport']>) => (await service()).saveReport(...args),
};
