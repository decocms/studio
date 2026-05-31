// Ported from Deno std @std/async (delay.ts). MIT license, Copyright the Deno
// authors. https://github.com/denoland/std/blob/main/async/delay.ts
//
// Adapted for node/bun/browser: the upstream `persistent` option (Deno-only
// `Deno.unrefTimer`) is dropped. The arbitrary-length-timeout handling is kept
// so delays beyond the 32-bit setTimeout ceiling still resolve.

/** Options for {@linkcode delay}. */
export interface DelayOptions {
  /** Signal used to abort the delay. */
  signal?: AbortSignal;
}

/**
 * Resolve a {@linkcode Promise} after a given amount of milliseconds.
 *
 * If the optional signal is aborted before the delay duration, the returned
 * promise rejects with the signal's reason. If no reason is provided to
 * `abort()`, the runtime's default `AbortError` `DOMException` is used.
 *
 * @param ms Duration in milliseconds for how long the delay should last.
 * @param options Additional options.
 */
export function delay(ms: number, options: DelayOptions = {}): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(+i);
      reject(signal?.reason);
    };
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const i = setArbitraryLengthTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const I32_MAX = 2 ** 31 - 1;

function setArbitraryLengthTimeout(
  callback: () => void,
  delay: number,
): { valueOf(): number } {
  // ensure non-negative integer (but > I32_MAX is OK, even if Infinity)
  delay = Math.trunc(Math.max(delay, 0) || 0);

  if (delay <= I32_MAX) {
    const id = Number(setTimeout(callback, delay));
    return { valueOf: () => id };
  }

  const start = Date.now();
  let timeoutId: number;

  const queueTimeout = () => {
    const currentDelay = delay - (Date.now() - start);
    timeoutId =
      currentDelay > I32_MAX
        ? Number(setTimeout(queueTimeout, I32_MAX))
        : Number(setTimeout(callback, currentDelay));
  };

  queueTimeout();

  return { valueOf: () => timeoutId };
}
