// Ported from Deno std @std/async (retry.ts). MIT license, Copyright the Deno
// authors. https://github.com/denoland/std/blob/main/async/retry.ts
//
// The canonical retry wrapper for this repo. Use `retry()` to call a possibly
// async function until it succeeds, and `exponentialBackoffWithJitter()` (from
// ./backoff) for stateful loops that can't be expressed as a single function
// (e.g. WebSocket reconnect, durable delivery). Do NOT hand-roll new retry
// loops — this was consolidated from ~9 ad-hoc copies.

import { exponentialBackoffWithJitter } from "./backoff";
import { delay } from "./delay";

/**
 * Error thrown in {@linkcode retry} once the maximum number of failed attempts
 * has been reached. The original failure is available on `.cause`.
 */
export class RetryError extends Error {
  constructor(cause: unknown, attempts: number) {
    super(`Retrying exceeded the maxAttempts (${attempts}).`);
    this.name = "RetryError";
    this.cause = cause;
  }
}

/** Options for {@linkcode retry}. */
export interface RetryOptions {
  /**
   * How much to backoff after each retry.
   *
   * @default {2}
   */
  multiplier?: number;
  /**
   * The maximum milliseconds between attempts.
   *
   * @default {60000}
   */
  maxTimeout?: number;
  /**
   * The maximum amount of attempts until failure.
   *
   * @default {5}
   */
  maxAttempts?: number;
  /**
   * The initial and minimum amount of milliseconds between attempts.
   *
   * @default {1000}
   */
  minTimeout?: number;
  /**
   * Amount of jitter to introduce to the time between attempts. This is `1`
   * for full jitter by default.
   *
   * @default {1}
   */
  jitter?: number;
  /**
   * Callback to determine if an error or other thrown value is retriable.
   *
   * @default {() => true}
   */
  isRetriable?: (err: unknown) => boolean;
  /**
   * An AbortSignal to cancel the retry operation. Checked before each attempt
   * and during the delay between attempts; rejects with the signal's reason.
   *
   * @default {undefined}
   */
  signal?: AbortSignal;
}

/**
 * Calls the given (possibly asynchronous) function up to `maxAttempts` times.
 * Retries as long as the given function throws (and `isRetriable` returns true
 * for the thrown value). If the attempts are exhausted, throws a
 * {@linkcode RetryError} with `cause` set to the inner exception.
 *
 * The backoff is exponential with jitter — see
 * {@linkcode exponentialBackoffWithJitter}.
 *
 * @typeParam T The return type of the function to retry.
 * @param fn The function to retry.
 * @param options Additional options.
 * @returns The value returned by `fn` on its first successful attempt.
 * @throws {RetryError} If the function fails after `maxAttempts` attempts.
 * @throws The thrown value, if `isRetriable` returns `false` for it.
 * @throws The signal's reason, if `signal` is aborted.
 */
export async function retry<T>(
  fn: (() => Promise<T>) | (() => T),
  options?: RetryOptions,
): Promise<T> {
  const {
    multiplier = 2,
    maxTimeout = 60000,
    maxAttempts = 5,
    minTimeout = 1000,
    jitter = 1,
    isRetriable = () => true,
    signal,
  } = options ?? {};

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `Cannot retry as 'maxAttempts' must be a positive integer: current value is ${maxAttempts}`,
    );
  }
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new RangeError(
      `Cannot retry as 'multiplier' must be a finite number >= 1: current value is ${multiplier}`,
    );
  }
  if (Number.isNaN(maxTimeout) || maxTimeout <= 0) {
    throw new RangeError(
      `Cannot retry as 'maxTimeout' must be a positive number: current value is ${maxTimeout}`,
    );
  }
  if (Number.isNaN(minTimeout) || minTimeout < 0) {
    throw new RangeError(
      `Cannot retry as 'minTimeout' must be >= 0: current value is ${minTimeout}`,
    );
  }
  if (minTimeout > maxTimeout) {
    throw new RangeError(
      `Cannot retry as 'minTimeout' must be <= 'maxTimeout': current values 'minTimeout=${minTimeout}', 'maxTimeout=${maxTimeout}'`,
    );
  }
  if (Number.isNaN(jitter) || jitter < 0 || jitter > 1) {
    throw new RangeError(
      `Cannot retry as 'jitter' must be between 0 and 1: current value is ${jitter}`,
    );
  }

  let attempt = 0;
  while (true) {
    signal?.throwIfAborted();

    try {
      return await fn();
    } catch (error) {
      if (!isRetriable(error)) {
        throw error;
      }

      if (attempt + 1 >= maxAttempts) {
        throw new RetryError(error, maxAttempts);
      }

      const timeout = exponentialBackoffWithJitter(
        maxTimeout,
        minTimeout,
        attempt,
        multiplier,
        jitter,
      );
      await delay(timeout, signal ? { signal } : undefined);
    }
    attempt++;
  }
}
