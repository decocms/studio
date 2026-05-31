// Behavioral port of Deno std async/retry_test.ts to bun:test. Deno's exact-ms
// timing tests rely on FakeTime (tick-advancing fake timers), which bun:test
// lacks; the timing math is instead covered deterministically in backoff.test.ts
// (exponentialBackoffWithJitter with jitter:0). Here we use real but tiny
// timeouts and assert behavior (success, attempt counts, isRetriable, signal,
// validation).

import { describe, expect, test } from "bun:test";
import { retry, RetryError } from "./retry";

// Fast settings so real-timer tests don't sleep meaningfully.
const FAST = { minTimeout: 1, maxTimeout: 1, jitter: 0 } as const;

function generateErroringFunction(errorsBeforeSucceeds: number) {
  let errorCount = 0;
  return () => {
    if (errorCount >= errorsBeforeSucceeds) return errorCount;
    errorCount++;
    throw `Only errored ${errorCount} times`;
  };
}

describe("retry() — success paths", () => {
  test("succeeds after a few errors", async () => {
    const result = await retry(generateErroringFunction(3), FAST);
    expect(result).toBe(3);
  });

  test("works with async functions", async () => {
    let attempts = 0;
    const result = await retry(async () => {
      await Promise.resolve();
      attempts++;
      if (attempts < 3) throw new Error("Not yet");
      return "async success";
    }, FAST);
    expect(result).toBe("async success");
    expect(attempts).toBe(3);
  });

  test("returns immediately on first success (fn called once)", async () => {
    let calls = 0;
    const result = await retry(() => {
      calls++;
      return "immediate";
    });
    expect(result).toBe("immediate");
    expect(calls).toBe(1);
  });
});

describe("retry() — exhaustion", () => {
  test("fails after five attempts by default, wrapping the last error", async () => {
    let calls = 0;
    const specific = new Error("Specific failure");
    const err = await retry(() => {
      calls++;
      throw specific;
    }, FAST).catch((e) => e);

    expect(err).toBeInstanceOf(RetryError);
    expect((err as RetryError).cause).toBe(specific);
    expect((err as Error).message).toBe(
      "Retrying exceeded the maxAttempts (5).",
    );
    expect(calls).toBe(5);
  });

  test("respects a custom maxAttempts", async () => {
    let attempts = 0;
    const err = await retry(
      () => {
        attempts++;
        throw new Error();
      },
      { ...FAST, maxAttempts: 3 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RetryError);
    expect((err as Error).message).toBe(
      "Retrying exceeded the maxAttempts (3).",
    );
    expect(attempts).toBe(3);
  });
});

describe("retry() — isRetriable", () => {
  class HttpError extends Error {
    status: number;
    constructor(status: number) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  }
  const opts = {
    ...FAST,
    isRetriable: (err: unknown) =>
      err instanceof HttpError && (err.status === 429 || err.status >= 500),
  };

  test("non-retriable error is thrown immediately (no retries)", async () => {
    let n = 0;
    const err = await retry(() => {
      n++;
      throw new HttpError(400);
    }, opts).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });

  test("retriable error is retried to exhaustion", async () => {
    let n = 0;
    const err = await retry(() => {
      n++;
      throw new HttpError(500);
    }, opts).catch((e) => e);
    expect(err).toBeInstanceOf(RetryError);
    expect(n).toBe(5);
  });

  test("stops as soon as a non-retriable error appears", async () => {
    let n = 0;
    const err = await retry(() => {
      throw new HttpError(++n === 3 ? 400 : 500);
    }, opts).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(n).toBe(3);
  });
});

describe("retry() — AbortSignal", () => {
  test("aborts during the delay between attempts", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const promise = retry(
      () => {
        attempts++;
        throw new Error("fail");
      },
      {
        signal: controller.signal,
        jitter: 0,
        minTimeout: 200,
        maxTimeout: 200,
      },
    );

    // First attempt runs, then enters a 200ms delay; abort well within it.
    setTimeout(() => controller.abort("cancelled"), 40);
    const err = await promise.catch((e) => e);
    expect(err).toBe("cancelled");
    expect(attempts).toBe(1);
  });

  test("throws immediately if the signal is already aborted (fn never runs)", async () => {
    const controller = new AbortController();
    controller.abort("pre-aborted");
    let called = false;
    const err = await retry(
      () => {
        called = true;
        return "ok";
      },
      { signal: controller.signal },
    ).catch((e) => e);
    expect(err).toBe("pre-aborted");
    expect(called).toBe(false);
  });

  test("rejects with an AbortError when aborted without a reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await retry(
      () => {
        throw new Error();
      },
      { signal: controller.signal },
    ).catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("retry() — option validation (RangeError)", () => {
  const cases: Array<[string, Parameters<typeof retry>[1], string]> = [
    [
      "minTimeout > maxTimeout",
      { minTimeout: 1000, maxTimeout: 100 },
      "Cannot retry as 'minTimeout' must be <= 'maxTimeout': current values 'minTimeout=1000', 'maxTimeout=100'",
    ],
    [
      "maxTimeout <= 0",
      { maxTimeout: -1 },
      "Cannot retry as 'maxTimeout' must be a positive number: current value is -1",
    ],
    [
      "maxTimeout NaN",
      { maxTimeout: NaN },
      "Cannot retry as 'maxTimeout' must be a positive number: current value is NaN",
    ],
    [
      "jitter > 1",
      { jitter: 2 },
      "Cannot retry as 'jitter' must be between 0 and 1: current value is 2",
    ],
    [
      "jitter < 0",
      { jitter: -0.5 },
      "Cannot retry as 'jitter' must be between 0 and 1: current value is -0.5",
    ],
    [
      "jitter NaN",
      { jitter: NaN },
      "Cannot retry as 'jitter' must be between 0 and 1: current value is NaN",
    ],
    [
      "maxAttempts 0",
      { maxAttempts: 0 },
      "Cannot retry as 'maxAttempts' must be a positive integer: current value is 0",
    ],
    [
      "maxAttempts non-integer",
      { maxAttempts: 2.5 },
      "Cannot retry as 'maxAttempts' must be a positive integer: current value is 2.5",
    ],
    [
      "multiplier < 1",
      { multiplier: 0.5 },
      "Cannot retry as 'multiplier' must be a finite number >= 1: current value is 0.5",
    ],
    [
      "multiplier NaN",
      { multiplier: NaN },
      "Cannot retry as 'multiplier' must be a finite number >= 1: current value is NaN",
    ],
    [
      "multiplier Infinity",
      { multiplier: Number.POSITIVE_INFINITY },
      "Cannot retry as 'multiplier' must be a finite number >= 1: current value is Infinity",
    ],
    [
      "minTimeout < 0",
      { minTimeout: -100 },
      "Cannot retry as 'minTimeout' must be >= 0: current value is -100",
    ],
    [
      "minTimeout NaN",
      { minTimeout: NaN },
      "Cannot retry as 'minTimeout' must be >= 0: current value is NaN",
    ],
  ];

  for (const [name, options, message] of cases) {
    test(name, async () => {
      const err = await retry(() => {}, options).catch((e) => e);
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toBe(message);
    });
  }
});
