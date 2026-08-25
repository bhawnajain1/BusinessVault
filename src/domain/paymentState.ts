// Central lifecycle predicate for Payment + Advance.
//
// Financial readers (receivables, payables, dashboard totals, party ledger,
// invoice/purchase paid-derivation, Drive snapshots) MUST use these helpers
// instead of hand-rolled `deleted_at == null && superseded_at == null` checks.
// One place to change when a new lifecycle state is introduced.
//
// Lifecycle summary:
//   ACTIVE      — deleted_at == null && superseded_at == null; counts in all
//                 financial math and is visible in the main lists.
//   RECYCLED    — deleted_at != null && superseded_at == null; user-initiated
//                 soft-delete; visible in Recycle Bin; restorable.
//   SUPERSEDED  — superseded_at != null; replaced by a newer revision via
//                 Edit; visible ONLY in per-payment revision history;
//                 NOT independently restorable.
//
// Invariant: exactly one row per revision chain (same payment_number) is
// ACTIVE at any time — enforced by PaymentService.updatePayment /
// softDeletePayment / restorePayment as a group.

import type { Advance, Payment } from '../db/types';

export type PaymentLifecycle = 'ACTIVE' | 'RECYCLED' | 'SUPERSEDED';

type PaymentLifecycleFields = Pick<Payment, 'deleted_at' | 'superseded_at'>;
type AdvanceLifecycleFields = Pick<Advance, 'deleted_at' | 'superseded_at'>;

export function paymentLifecycle(p: PaymentLifecycleFields): PaymentLifecycle {
  if (p.superseded_at) return 'SUPERSEDED';
  if (p.deleted_at) return 'RECYCLED';
  return 'ACTIVE';
}

export function isPaymentActive(p: PaymentLifecycleFields): boolean {
  return !p.deleted_at && !p.superseded_at;
}

export function isPaymentRecycled(p: PaymentLifecycleFields): boolean {
  return !!p.deleted_at && !p.superseded_at;
}

export function isPaymentSuperseded(p: Pick<Payment, 'superseded_at'>): boolean {
  return !!p.superseded_at;
}

export type AdvanceLifecycle = 'ACTIVE' | 'RECYCLED' | 'SUPERSEDED';

export function advanceLifecycle(a: AdvanceLifecycleFields): AdvanceLifecycle {
  if (a.superseded_at) return 'SUPERSEDED';
  if (a.deleted_at) return 'RECYCLED';
  return 'ACTIVE';
}

export function isAdvanceActive(a: AdvanceLifecycleFields): boolean {
  return !a.deleted_at && !a.superseded_at;
}

export function isAdvanceRecycled(a: AdvanceLifecycleFields): boolean {
  return !!a.deleted_at && !a.superseded_at;
}

export function isAdvanceSuperseded(a: Pick<Advance, 'superseded_at'>): boolean {
  return !!a.superseded_at;
}

// Convenience filters — the common case at every reader is "give me only the
// active rows for this business". Kept as pure functions so callers can feed
// them a Dexie array without wrapping in a promise.
export function filterActivePayments<T extends PaymentLifecycleFields>(rows: T[]): T[] {
  return rows.filter(isPaymentActive);
}

export function filterActiveAdvances<T extends AdvanceLifecycleFields>(rows: T[]): T[] {
  return rows.filter(isAdvanceActive);
}

export function filterRecycledPayments<T extends PaymentLifecycleFields>(rows: T[]): T[] {
  return rows.filter(isPaymentRecycled);
}
