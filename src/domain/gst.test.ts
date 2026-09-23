import { describe, expect, it } from 'vitest';
import { roundOffToNearestRupee } from './gst';

describe('roundOffToNearestRupee', () => {
  it('rounds fractional totals up to the next rupee', () => {
    expect(roundOffToNearestRupee(10001)).toEqual({
      final_paise: 10100,
      round_off_paise: 99,
    });
  });

  it('does not reduce a total that is already a whole rupee', () => {
    expect(roundOffToNearestRupee(10100)).toEqual({
      final_paise: 10100,
      round_off_paise: 0,
    });
  });
});
