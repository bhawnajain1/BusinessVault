import { describe, expect, it, vi } from 'vitest';
import { validateHsnSac } from './compliance';

describe('validateHsnSac', () => {
  it('accepts optional goods HSN lengths', () => {
    expect(() => validateHsnSac('', false, 'Invoice line')).not.toThrow();
    expect(() => validateHsnSac('1234', false, 'Invoice line')).not.toThrow();
    expect(() => validateHsnSac('123456', false, 'Invoice line')).not.toThrow();
    expect(() => validateHsnSac('12345678', false, 'Invoice line')).not.toThrow();
  });

  it('accepts optional six-digit SAC for services', () => {
    expect(() => validateHsnSac('998314', true, 'Item')).not.toThrow();
    expect(() => validateHsnSac(null, true, 'Item')).not.toThrow();
  });

  it('rejects malformed HSN/SAC values and logs only safe context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateHsnSac('ABC123', false, 'Invoice line 1')).toThrow(
      'Invoice line 1 HSN must be 4, 6, or 8 digits',
    );
    expect(() => validateHsnSac('12345', true, 'Item')).toThrow(
      'Item SAC must be exactly 6 digits',
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('ABC123'));
    warn.mockRestore();
  });
});
