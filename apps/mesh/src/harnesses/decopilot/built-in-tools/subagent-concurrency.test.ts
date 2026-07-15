import { describe, expect, it } from "bun:test";
import { createConcurrencyGate } from "./subagent-concurrency";

describe("createConcurrencyGate", () => {
  it("allows up to `max` concurrent holders without waiting", async () => {
    const gate = createConcurrencyGate(2);
    await gate.acquire();
    await gate.acquire();
    expect(gate.active).toBe(2);
    expect(gate.pending).toBe(0);
  });

  it("queues acquisitions past capacity and admits them on release", async () => {
    const gate = createConcurrencyGate(1);
    const r1 = await gate.acquire();

    let admitted = false;
    const p2 = gate.acquire().then((r) => {
      admitted = true;
      return r;
    });

    // Second acquire is parked, not granted.
    await Promise.resolve();
    expect(gate.active).toBe(1);
    expect(gate.pending).toBe(1);
    expect(admitted).toBe(false);

    r1(); // free the slot
    await p2;
    expect(admitted).toBe(true);
    expect(gate.active).toBe(1);
    expect(gate.pending).toBe(0);
  });

  it("admits waiters in FIFO order", async () => {
    const gate = createConcurrencyGate(1);
    const r1 = await gate.acquire();
    const order: number[] = [];
    const p2 = gate.acquire().then((r) => {
      order.push(2);
      return r;
    });
    const p3 = gate.acquire().then((r) => {
      order.push(3);
      return r;
    });

    r1();
    const r2 = await p2;
    r2();
    await p3;
    expect(order).toEqual([2, 3]);
  });

  it("release is idempotent — a double-call frees only one slot", async () => {
    const gate = createConcurrencyGate(2);
    const r1 = await gate.acquire();
    await gate.acquire();
    r1();
    r1(); // no-op
    expect(gate.active).toBe(1);
  });

  it("hands a released slot to the earliest waiter, not a fresh acquire racing in the same tick", async () => {
    const gate = createConcurrencyGate(1);
    const r1 = await gate.acquire(); // active = 1

    const order: string[] = [];
    const p2 = gate.acquire().then((r) => {
      order.push("p2");
      return r;
    });

    r1(); // frees the slot — must hand off to p2, not to whoever asks next

    // A brand-new acquire issued in the same synchronous tick, before p2's
    // continuation (a microtask) gets to run. It must queue behind p2, not
    // steal the slot out from under it.
    const p3 = gate.acquire().then((r) => {
      order.push("p3");
      return r;
    });

    const r2 = await p2;
    expect(gate.active).toBe(1);
    expect(gate.pending).toBe(1);
    expect(order).toEqual(["p2"]);

    r2();
    const r3 = await p3;
    expect(order).toEqual(["p2", "p3"]);
    expect(gate.active).toBe(1);

    r3();
    expect(gate.active).toBe(0);
  });

  it("coerces a non-finite max (e.g. an unparsed env value) up to 1 instead of deadlocking", async () => {
    const gate = createConcurrencyGate(Number("not-a-number"));
    await gate.acquire();
    expect(gate.active).toBe(1);
    let admitted = false;
    void gate.acquire().then(() => (admitted = true));
    await Promise.resolve();
    expect(admitted).toBe(false);
  });

  it("coerces a sub-1 max up to 1", async () => {
    const gate = createConcurrencyGate(0);
    await gate.acquire();
    expect(gate.active).toBe(1);
    let admitted = false;
    void gate.acquire().then(() => (admitted = true));
    await Promise.resolve();
    expect(admitted).toBe(false);
  });
});
