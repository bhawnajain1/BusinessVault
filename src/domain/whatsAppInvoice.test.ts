import { describe, expect, it } from 'vitest';
import type { Business, Customer, Invoice } from '../db/types';
import { buildInvoiceWhatsAppUrl } from './whatsAppInvoice';

const invoice = {
  id: 'invoice-1',
  business_id: 'business-1',
  invoice_number: 'INV-001',
  invoice_date: '2026-10-01',
  due_date: '2026-10-16',
  customer_id: 'customer-1',
  customer_state_code: '29',
  place_of_supply: '29',
  is_interstate: 0,
  financial_year: '2026-27',
  subtotal_paise: 10000,
  discount_paise: 0,
  taxable_paise: 10000,
  cgst_paise: 900,
  sgst_paise: 900,
  igst_paise: 0,
  cess_paise: 0,
  round_off_paise: 0,
  round_off_mode: 'none',
  pre_round_total_paise: 11800,
  total_paise: 11800,
  paid_paise: 0,
  balance_paise: 11800,
  status: 'issued',
  reversed_by_invoice_id: null,
  reverses_invoice_id: null,
  notes: '',
  terms: '',
  pdf_attachment_id: null,
  journal_entry_id: 'journal-1',
  created_at: '2026-10-01T12:00:00.000Z',
  updated_at: '2026-10-01T12:00:00.000Z',
  entity_version: 1,
} satisfies Invoice;

describe('buildInvoiceWhatsAppUrl', () => {
  it('uses an Indian country code for a ten-digit customer number', () => {
    const customer = { phone: '98765 43210', name: 'Ravi Kumar' } as Customer;
    const business = { name: 'Sharma Electronics', legal_name: '' } as Business;

    const url = buildInvoiceWhatsAppUrl({ business, customer, invoice, pdfUrl: 'https://invoice.example/invoice/abc' });

    expect(url).toContain('https://wa.me/919876543210?text=');
    expect(decodeURIComponent(url!.split('text=')[1])).toContain('INV-001');
    expect(decodeURIComponent(url!.split('text=')[1])).toContain('https://invoice.example/invoice/abc');
  });

  it('does not build a URL for a missing or invalid number', () => {
    expect(buildInvoiceWhatsAppUrl({ business: null, customer: null, invoice, pdfUrl: 'https://invoice.example/invoice/abc' })).toBeNull();
    expect(buildInvoiceWhatsAppUrl({ business: null, customer: { phone: '123' } as Customer, invoice, pdfUrl: 'https://invoice.example/invoice/abc' })).toBeNull();
  });
});
