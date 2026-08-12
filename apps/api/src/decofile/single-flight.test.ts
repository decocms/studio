import { describe, expect, test } from "bun:test";
import { createSingleFlight } from "./single-flight";

/** Manually-settled promise so tests control settlement timing without timers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  test("concurrent callers for the same key share one execution", async () => {
    const flight = createSingleFlight<string>();
    const gate = deferred<string>();
    let calls = 0;

    const a = flight.run("k", () => {
      calls++;
      return gate.promise;
    });
    const b = flight.run("k", () => {
      calls++;
      return gate.promise;
    });

    gate.resolve("value");
    await expect(a).resolves.toBe("value");
    await expect(b).resolves.toBe("value");
    expect(calls).toBe(1);
  });

  test("different keys run independently", async () => {
    const flight = createSingleFlight<string>();
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    let callsA = 0;
    let callsB = 0;

    const a = flight.run("a", () => {
      callsA++;
      return gateA.promise;
    });
    const b = flight.run("b", () => {
      callsB++;
      return gateB.promise;
    });

    gateA.resolve("from-a");
    gateB.resolve("from-b");
    await expect(a).resolves.toBe("from-a");
    await expect(b).resolves.toBe("from-b");
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });

  test("rejection propagates to all waiters and is not cached", async () => {
    const flight = createSingleFlight<string>();
    const gate = deferred<string>();
    let calls = 0;

    const a = flight.run("k", () => {
      calls++;
      return gate.promise;
    });
    const b = flight.run("k", () => {
      calls++;
      return gate.promise;
    });

    const boom = new Error("boom");
    gate.reject(boom);
    await expect(a).rejects.toBe(boom);
    await expect(b).rejects.toBe(boom);
    expect(calls).toBe(1);

    // The failed flight must not be cached: the next call re-runs fresh.
    await expect(
      flight.run("k", () => Promise.resolve("recovered")),
    ).resolves.toBe("recovered");
    expect(calls).toBe(1); // recovered run used a different fn; original fn not re-invoked
  });

  test("synchronous throw in fn rejects every waiter and is not cached", async () => {
    const flight = createSingleFlight<never>();
    const boom = new Error("sync boom");
    let calls = 0;

    const thrower = () => {
      calls++;
      throw boom;
    };
    const a = flight.run("k", thrower);
    const b = flight.run("k", thrower);

    await expect(a).rejects.toBe(boom);
    await expect(b).rejects.toBe(boom);
    expect(calls).toBe(1);

    // Next call after the failure runs fresh.
    const c = flight.run("k", thrower);
    await expect(c).rejects.toBe(boom);
    expect(calls).toBe(2);
  });

  test("sequential calls after settle re-run (entry removed on resolve)", async () => {
    const flight = createSingleFlight<number>();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(calls);
    };

    await expect(flight.run("k", fn)).resolves.toBe(1);
    await expect(flight.run("k", fn)).resolves.toBe(2);
    expect(calls).toBe(2);
  });
});
