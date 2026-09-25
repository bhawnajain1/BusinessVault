import { describe, expect, it } from 'vitest';
import { ONBOARDING_COMPLETE_PATH } from './Onboarding';

describe('onboarding completion', () => {
  it('opens the dashboard as the default home page', () => {
    expect(ONBOARDING_COMPLETE_PATH).toBe('/');
  });
});
