/**
 * Counting semaphore — a portable, abortable concurrency gate.
 *
 * Used to bound how many `subtask` core runs execute at once across a single
 * process (decision Q17: a small cap). This is a GATE, not a retry/backoff
 * loop — the `@decocms/shared/std` backoff/sleep primitives don't apply. It is a
 * plain FIFO counting semaphore with `AbortSignal` support so a waiter blocked
 * on a full gate can be cancelled (parent tool-call abort) without leaking a
 * permit or an orphaned waiter.
 *
 * `@/*`-free so the daemon (Task 18 desktop subtask) can bundle it.
 */

export interface Semaphore {
  /** Acquire a permit. Resolves once a slot is free. If `signal` aborts while
   *  waiting (or is already aborted), rejects with the signal's reason and
   *  consumes no permit. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Release a previously-acquired permit, waking the next FIFO waiter. */
  release(): void;
  /** Free permits right now (for tests / introspection). */
  available(): number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  /** Detaches the abort listener; set when the waiter is enqueued. */
  cleanup: () => void;
}

export function createSemaphore(cap: number): Semaphore {
  if (cap < 1) throw new Error("Semaphore cap must be >= 1");
  let free = cap;
  const waiters: Waiter[] = [];

  function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error("Semaphore acquire aborted");
  }

  return {
    acquire(signal) {
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      if (free > 0) {
        free -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          cleanup: () => {},
        };
        const onAbort = () => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          waiter.cleanup();
          reject(abortReason(signal!));
        };
        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
          waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
        }
        waiters.push(waiter);
      });
    },

    release() {
      const next = waiters.shift();
      if (next) {
        // Hand the permit directly to the next FIFO waiter (the slot stays
        // taken — `free` doesn't bump). Detach its abort listener first so a
        // late abort can't double-fire.
        next.cleanup();
        next.resolve();
        return;
      }
      free += 1;
      if (free > cap) free = cap;
    },

    available() {
      return free;
    },
  };
}
