import { describe, expect, it } from 'vitest';
import { roundOffToNearestRupee } from './gst';

describe('roundOffToNearestRupee', () => {
  it('rounds below 50 paise down to the current rupee', () => {
    expect(roundOffToNearestRupee(10049)).toEqual({
      final_paise: 10000,
      round_off_paise: -49,
    });
  });

  it('rounds exactly 50 paise up to the next rupee', () => {
    expect(roundOffToNearestRupee(10050)).toEqual({
      final_paise: 10100,
      round_off_paise: 50,
    });
  });

  it('rounds more than 50 paise up to the next rupee', () => {
    expect(roundOffToNearestRupee(10099)).toEqual({
      final_paise: 10100,
      round_off_paise: 1,
    });
  });

  it('does not reduce a total that is already a whole rupee', () => {
    expect(roundOffToNearestRupee(10100)).toEqual({
      final_paise: 10100,
      round_off_paise: 0,
    });
  });
});
