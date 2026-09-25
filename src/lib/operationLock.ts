import { useSyncExternalStore } from 'react';

export type AppOperationKind = 'restore' | 'start-fresh';

export interface AppOperation {
  kind: AppOperationKind;
  label: string;
  cancelable: boolean;
  cancel: () => void;
}

let active: AppOperation | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function beginAppOperation(operation: Omit<AppOperation, 'cancel'> & { cancel?: () => void }): () => void {
  if (active) throw new Error(`Cannot start ${operation.kind} while ${active.kind} is running`);
  active = {
    ...operation,
    cancel: operation.cancel ?? (() => undefined),
  };
  notify();
  return () => {
    if (active?.kind === operation.kind) {
      active = null;
      notify();
    }
  };
}

export function getAppOperation(): AppOperation | null {
  return active;
}

export function subscribeAppOperation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppOperation(): AppOperation | null {
  return useSyncExternalStore(subscribeAppOperation, getAppOperation, () => null);
}

export function installOperationUnloadGuard(): () => void {
  const handler = (event: BeforeUnloadEvent): void => {
    if (!active) return;
    event.preventDefault();
    event.returnValue = 'An operation is still in progress.';
  };
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}
