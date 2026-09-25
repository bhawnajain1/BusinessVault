import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginAppOperation,
  getAppOperation,
  useAppOperation,
} from './operationLock';

afterEach(() => {
  const operation = getAppOperation();
  if (operation) operation.cancel();
});

describe('operation lock', () => {
  it('publishes one active operation and releases it', () => {
    const release = beginAppOperation({
      kind: 'restore',
      label: 'Restore',
      cancelable: true,
    });
    expect(getAppOperation()?.kind).toBe('restore');
    release();
    expect(getAppOperation()).toBeNull();
  });

  it('does not allow concurrent destructive operations', () => {
    const release = beginAppOperation({ kind: 'start-fresh', label: 'Start Fresh', cancelable: false });
    expect(() => beginAppOperation({ kind: 'restore', label: 'Restore', cancelable: true })).toThrow();
    release();
  });

  it('updates subscribed hooks', () => {
    const { result } = renderHook(() => useAppOperation());
    expect(result.current).toBeNull();
    let release: () => void;
    act(() => {
      release = beginAppOperation({ kind: 'restore', label: 'Restore', cancelable: true });
    });
    expect(result.current?.kind).toBe('restore');
    act(() => release!());
    expect(result.current).toBeNull();
  });
});
