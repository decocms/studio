/**
 * Limits concurrent per-group `COLLECTION_THREADS_LIST` calls so opening many
 * expanded sidebar groups at once does not exhaust browser connection slots
 * (`net::ERR_INSUFFICIENT_RESOURCES`).
 */
const MAX_CONCURRENT = 4;

let inFlight = 0;
const waiters: Array<() => void> = [];

function drain(): void {
  while (inFlight < MAX_CONCURRENT && waiters.length > 0) {
    const next = waiters.shift();
    if (next) next();
  }
}

export function enqueueGroupThreadsFetch<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlight++;
      void fn()
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          drain();
        });
    };
    if (inFlight < MAX_CONCURRENT) {
      run();
    } else {
      waiters.push(run);
    }
  });
}

/** Test-only reset — not exported from the public module surface in production. */
export function resetGroupThreadsFetchQueueForTests(): void {
  inFlight = 0;
  waiters.length = 0;
}
