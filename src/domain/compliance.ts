import { log } from '../lib/log';

export type EInvoiceStatus = 'not_recorded' | 'local_unverified';

export function validateHsnSac(
  code: string | undefined | null,
  isService: boolean,
  context: string,
): void {
  const value = (code ?? '').trim();
  if (!value) return;
  const valid = isService ? /^\d{6}$/.test(value) : /^(?:\d{4}|\d{6}|\d{8})$/.test(value);
  if (valid) return;
  log.warn('compliance', 'HSN/SAC validation failed', { context, isService });
  throw new Error(
    isService
      ? `${context} SAC must be exactly 6 digits`
      : `${context} HSN must be 4, 6, or 8 digits`,
  );
}
