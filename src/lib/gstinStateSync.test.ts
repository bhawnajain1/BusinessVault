import { describe, it, expect } from 'vitest';
import {
  applyGstinChange,
  applyStateChange,
  computeGstinStateStatus,
  inferManuallySet,
  normalizeGstinInput,
} from './gstinStateSync';

const empty = { gstin: '', stateCode: '', stateName: '', stateManuallySet: false };

describe('§12 gstinStateSync — normalizeGstinInput', () => {
  it('uppercases and strips whitespace', () => {
    expect(normalizeGstinInput('  08aahfa 4890p1zk  ')).toBe('08AAHFA4890P1ZK');
  });
});

describe('§12 gstinStateSync — applyGstinChange', () => {
  it('auto-fills state from a valid 2-digit prefix when state is empty', () => {
    const next = applyGstinChange(empty, '08AAHFA4890P1ZK');
    expect(next.stateCode).toBe('08');
    expect(next.stateName).toBe('Rajasthan');
    expect(next.stateManuallySet).toBe(false);
  });

  it('re-derives when GSTIN prefix changes and state was auto-detected', () => {
    const seeded = { ...empty, gstin: '08AAHFA4890P1ZK', stateCode: '08', stateName: 'Rajasthan' };
    const next = applyGstinChange(seeded, '27AAHFA4890P1ZK');
    expect(next.stateCode).toBe('27');
    expect(next.stateName).toBe('Maharashtra');
  });

  it('does NOT overwrite a manually-set state', () => {
    const manual = {
      gstin: '',
      stateCode: '27',
      stateName: 'Maharashtra',
      stateManuallySet: true,
    };
    const next = applyGstinChange(manual, '08AAHFA4890P1ZK');
    expect(next.gstin).toBe('08AAHFA4890P1ZK');
    expect(next.stateCode).toBe('27'); // still manual choice
    expect(next.stateName).toBe('Maharashtra');
    expect(next.stateManuallySet).toBe(true);
  });

  it('clearing GSTIN resets the manual latch', () => {
    const seeded = { ...empty, gstin: '27AAHFA4890P1ZK', stateCode: '27', stateName: 'Maharashtra', stateManuallySet: true };
    const next = applyGstinChange(seeded, '');
    expect(next.gstin).toBe('');
    expect(next.stateManuallySet).toBe(false);
  });

  it('ignores incomplete prefixes (< 2 chars or unknown code)', () => {
    const next = applyGstinChange(empty, '0');
    expect(next.gstin).toBe('0');
    expect(next.stateCode).toBe('');
    const unknown = applyGstinChange(empty, '99XYZ');
    expect(unknown.gstin).toBe('99XYZ');
    // Note: the state-code map does have "99" as "Centre Jurisdiction"; use
    // an actually-unmapped code to test the fallback.
    const bogus = applyGstinChange(empty, 'ZZAAHFA');
    expect(bogus.stateCode).toBe('');
  });
});

describe('§12 gstinStateSync — applyStateChange', () => {
  it('latches manuallySet on a valid selection', () => {
    const next = applyStateChange({ ...empty, gstin: '27AAHFA4890P1ZK' }, '08');
    expect(next.stateCode).toBe('08');
    expect(next.stateName).toBe('Rajasthan');
    expect(next.stateManuallySet).toBe(true);
  });

  it('clearing the state also clears the manual latch', () => {
    const manual = { ...empty, stateCode: '08', stateName: 'Rajasthan', stateManuallySet: true };
    const next = applyStateChange(manual, '');
    expect(next.stateCode).toBe('');
    expect(next.stateManuallySet).toBe(false);
  });
});

describe('§12 gstinStateSync — computeGstinStateStatus', () => {
  it('reports detected when GSTIN prefix matches selected state', () => {
    const s = computeGstinStateStatus('08AAHFA4890P1ZK', '08');
    expect(s.detectedFromGstin?.name).toBe('Rajasthan');
    expect(s.detectedMatchesSelected).toBe(true);
    expect(s.mismatch).toBe(false);
  });

  it('reports mismatch when GSTIN prefix disagrees with selected state', () => {
    const s = computeGstinStateStatus('08AAHFA4890P1ZK', '27');
    expect(s.detectedFromGstin?.name).toBe('Rajasthan');
    expect(s.detectedMatchesSelected).toBe(false);
    expect(s.mismatch).toBe(true);
  });

  it('reports detected-only when no state selected yet', () => {
    const s = computeGstinStateStatus('08AAHFA4890P1ZK', '');
    expect(s.detectedFromGstin?.name).toBe('Rajasthan');
    expect(s.detectedMatchesSelected).toBe(false);
    expect(s.mismatch).toBe(false);
  });

  it('returns nothing when GSTIN is too short to have a prefix', () => {
    const s = computeGstinStateStatus('', '08');
    expect(s.detectedFromGstin).toBeNull();
  });
});

describe('§12 gstinStateSync — inferManuallySet (loading a saved record)', () => {
  it('returns true when the persisted state disagrees with the GSTIN prefix', () => {
    expect(inferManuallySet('08AAHFA4890P1ZK', '27')).toBe(true);
  });

  it('returns false when GSTIN and state agree', () => {
    expect(inferManuallySet('08AAHFA4890P1ZK', '08')).toBe(false);
  });

  it('returns true when a state is set but GSTIN is empty (so nothing to auto-detect from)', () => {
    expect(inferManuallySet('', '08')).toBe(true);
  });

  it('returns false when both are empty', () => {
    expect(inferManuallySet('', '')).toBe(false);
  });
});
