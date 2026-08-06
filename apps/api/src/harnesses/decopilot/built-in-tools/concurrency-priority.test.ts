import { describe, expect, test } from "bun:test";
import { createConcurrencyGate } from "./subagent-concurrency";

describe("createConcurrencyGate priority", () => {
  // Ordering the WAITERS is the whole mechanism: the slot holder is never
  // preempted, so a low-priority run that started is never killed for a
  // high-priority one.
  test("a higher-priority waiter takes the freed slot first", async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire();
    const order: string[] = [];

    const low = gate.acquire(40).then((r) => {
      order.push("low");
      r();
    });
    const high = gate.acquire(20).then((r) => {
      order.push("high");
      r();
    });
    // Let both park before the slot frees.
    await Promise.resolve();
    release();
    await Promise.all([low, high]);

    expect(order).toEqual(["high", "low"]);
  });

  test("equal priorities keep arrival order", async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire();
    const order: number[] = [];
    const waits = [1, 2, 3].map((n) =>
      gate.acquire(30).then((r) => {
        order.push(n);
        r();
      }),
    );
    await Promise.resolve();
    release();
    await Promise.all(waits);
    expect(order).toEqual([1, 2, 3]);
  });

  test("omitting priority still works (plain FIFO)", async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire();
    const order: string[] = [];
    const a = gate.acquire().then((r) => {
      order.push("a");
      r();
    });
    const b = gate.acquire().then((r) => {
      order.push("b");
      r();
    });
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });
});
