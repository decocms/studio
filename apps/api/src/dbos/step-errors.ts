/**
 * Spotting an exhausted step retry from inside a workflow.
 *
 * `instanceof DBOSMaxStepRetriesError` only holds on the first pass. On replay
 * DBOS revives a recorded step error as a plain `Error` — whose `name` is
 * "Error" too — so the numeric `dbosErrorCode` is the only part that survives
 * the round trip. A workflow that catches exhausted retries in order to
 * degrade must match on that, or it takes a different path after a recovery
 * than it did before one.
 */

import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";

/** `DBOSMaxStepRetriesError`'s code. Pinned against the SDK by a unit test. */
export const MAX_STEP_RETRIES_CODE = 23;

export function isMaxStepRetriesError(err: unknown): boolean {
  return (
    err instanceof Error &&
    DBOSErrors.getDBOSErrorCode(err) === MAX_STEP_RETRIES_CODE
  );
}
