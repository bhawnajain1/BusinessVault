import { db } from '../db';
import type { Invoice } from '../db/types';
import { createDriveApiClient } from '../drive/google';

function fileName(invoice: Invoice): string {
  return `invoice-${invoice.id}.pdf`;
}

export async function uploadInvoicePdf(invoice: Invoice, pdf: Blob): Promise<string> {
  if (!navigator.onLine) throw new Error('You are offline. Connect to the internet before sending an invoice link.');
  const business = await db.businesses.get(invoice.business_id);
  if (!business?.drive_folder_id) {
    throw new Error('Connect Google Drive in Data & Backup before sending an invoice on WhatsApp.');
  }

  const api = createDriveApiClient({ businessId: invoice.business_id });
  try {
    await api.refreshIfNeeded();
    const invoicesFolder = await api.ensureFolder(business.drive_folder_id, 'invoices');
    const existingFileId = invoice.pdf_attachment_id;
    const isReplacement = Boolean(existingFileId);
    const file = isReplacement
      ? await api.updateFileContents(existingFileId!, pdf, 'application/pdf')
      : await api.createFile({
          parentId: invoicesFolder.id,
          name: fileName(invoice),
          mimeType: 'application/pdf',
          body: pdf,
        });
    const url = isReplacement && invoice.shared_pdf_url
      ? invoice.shared_pdf_url
      : await api.createPublicReaderLink(file.id);
    await db.invoices.update(invoice.id, {
      pdf_attachment_id: file.id,
      shared_pdf_url: url,
    });
    return url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DriveNeedsReconnectError')) {
      throw new Error('Reconnect Google Drive in Data & Backup, then try again.');
    }
    throw new Error(`Could not upload the invoice PDF to Google Drive: ${message}`);
  }
}
