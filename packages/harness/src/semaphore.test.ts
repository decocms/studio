import { describe, expect, test } from "bun:test";
import { createSemaphore } from "./semaphore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createSemaphore", () => {
  test("permits up to `cap` concurrent holders", async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available()).toBe(0);
    sem.release();
    expect(sem.available()).toBe(1);
  });

  test("the 5th acquire with cap 4 waits until a release", async () => {
    const sem = createSemaphore(4);
    for (let i = 0; i < 4; i++) await sem.acquire();
    expect(sem.available()).toBe(0);

    let fifthResolved = false;
    const fifth = sem.acquire().then(() => {
      fifthResolved = true;
    });

    await tick();
    // Still blocked — no slot free.
    expect(fifthResolved).toBe(false);

    sem.release();
    await fifth;
    expect(fifthResolved).toBe(true);
    // The released slot is now held by the 5th acquirer, none free.
    expect(sem.available()).toBe(0);
  });

  test("abort while waiting rejects and cleans up the waiter", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    const ac = new AbortController();
    const waiting = sem.acquire(ac.signal);
    await tick();

    ac.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");

    // The aborted waiter must not silently grab the slot on the next release.
    sem.release();
    await tick();
    // Slot is free again — no orphaned waiter consumed it.
    expect(sem.available()).toBe(1);
  });

  test("acquire with an already-aborted signal rejects immediately", async () => {
    const sem = createSemaphore(1);
    const ac = new AbortController();
    ac.abort(new Error("pre-aborted"));
    await expect(sem.acquire(ac.signal)).rejects.toThrow("pre-aborted");
    // No slot was consumed.
    expect(sem.available()).toBe(1);
  });

  test("waiters are served in FIFO order", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const w1 = sem.acquire().then(() => order.push(1));
    const w2 = sem.acquire().then(() => order.push(2));

    await tick();
    sem.release();
    await w1;
    sem.release();
    await w2;
    expect(order).toEqual([1, 2]);
  });
});
