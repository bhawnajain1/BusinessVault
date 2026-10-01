import type { Business, Customer, Invoice } from '../db/types';

function toWhatsAppPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

function formatInr(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(paise / 100);
}

export function buildInvoiceWhatsAppUrl(input: {
  business: Business | null | undefined;
  customer: Customer | null | undefined;
  invoice: Invoice;
  pdfUrl: string;
}): string | null {
  const phone = toWhatsAppPhone(input.customer?.phone ?? '');
  if (!phone || !input.pdfUrl) return null;

  const customerName = input.customer?.name || 'Customer';
  const message = [
    `Hi ${customerName},`,
    '',
    'Thank you for your business.',
    '',
    `Please find your invoice ${input.invoice.invoice_number} below:`,
    '',
    input.pdfUrl,
    '',
    'You can open or download the invoice using the link above.',
    '',
    'Thank you.',
  ].filter(Boolean).join('\n');

  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

export function openInvoiceWhatsApp(input: {
  business: Business | null | undefined;
  customer: Customer | null | undefined;
  invoice: Invoice;
  pdfUrl: string;
}): boolean {
  const url = buildInvoiceWhatsAppUrl(input);
  if (!url) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
