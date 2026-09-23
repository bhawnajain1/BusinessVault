import { describe, expect, it } from 'vitest';
import { DEFAULT_INVOICE_TERMS } from './defaults';

describe('DEFAULT_INVOICE_TERMS', () => {
  it('matches the configured invoice terms exactly', () => {
    expect(DEFAULT_INVOICE_TERMS).toBe(
      'Thank you for your business.\n\n' +
        'Payment is due within 15 days of the invoice date. Please include the invoice number with your payment. Any invoice discrepancy should be reported within 7 days. Taxes and TDS will apply as required by law. Returns or cancellations are subject to our agreed policy. ',
    );
  });
});
