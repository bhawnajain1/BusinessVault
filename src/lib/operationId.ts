// §14 Operation / Correlation ID.
//
// Every financial mutation (invoice create/edit/recycle/restore, payment
// create/refund, sales return, journal post/reverse) generates one operationId
// at the top-level entry point and threads it into every downstream `log.*`
// call so a debugger can filter the diagnostic log by operationId and see
// every side effect in causal order:
//
//   invoice.recycle.start      operationId=01HZ...
//     payment.allocation.suspended operationId=01HZ...
//     accounting.journal.reversed operationId=01HZ...
//     party.recalculated          operationId=01HZ...
//   invoice.recycle.success    operationId=01HZ...
//
// Not a UUID — a ULID, so the log stays roughly time-sorted even without a
// dedicated `ts` sort. Callers can pass in an existing id (e.g. when a UI
// action already generated one) or let the service allocate a fresh one.
//
// Grug: no AsyncLocalStorage, no context managers. Just a string field on the
// per-call `opts` argument. Explicit passing beats implicit magic every time.

import { ulid } from 'ulid';
import { log } from './log';

export interface OperationOpts {
  operationId?: string;
}

export function newOperationId(): string {
  return ulid();
}

// Convenience wrapper for the common "log start / body / log success / log
// failure" shape. Returns the body's result, or rethrows after logging.
//
//   return withOperation('invoice.create', opts, async (opId) => {
//     // ... do work; call log.info('...', { operationId: opId, ... }) inline
//     return invoice;
//   });
export async function withOperation<T>(
  event: string,
  opts: OperationOpts | undefined,
  body: (operationId: string) => Promise<T>,
): Promise<T> {
  const operationId = opts?.operationId ?? newOperationId();
  log.info(event + '.start', event, { operationId });
  try {
    const result = await body(operationId);
    log.info(event + '.success', event, { operationId });
    return result;
  } catch (err) {
    log.error(event + '.failure', event, { operationId, error: err });
    throw err;
  }
}
