import { describe, expect, it } from 'vitest';
import { DRIVE_REQUIRED_SCOPES, hasRequiredDriveScopes } from './gis';

describe('Google Drive OAuth scopes', () => {
  it('accepts a token containing both required Drive scopes', () => {
    expect(hasRequiredDriveScopes(`openid email ${DRIVE_REQUIRED_SCOPES.join(' ')}`)).toBe(true);
  });

  it('rejects an identity-only token', () => {
    expect(hasRequiredDriveScopes('openid email profile')).toBe(false);
  });

  it('rejects a token missing either Drive scope', () => {
    expect(hasRequiredDriveScopes(DRIVE_REQUIRED_SCOPES[0])).toBe(false);
    expect(hasRequiredDriveScopes(DRIVE_REQUIRED_SCOPES[1])).toBe(false);
  });

  it('rejects an empty or missing scope value', () => {
    expect(hasRequiredDriveScopes('')).toBe(false);
    expect(hasRequiredDriveScopes()).toBe(false);
  });
});
