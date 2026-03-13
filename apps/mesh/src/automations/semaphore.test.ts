import { describe, expect, it } from "bun:test";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
  it("acquires a slot when available", () => {
    const sem = new Semaphore(1);
    const slot = sem.tryAcquire();
    expect(slot).not.toBeNull();
  });

  it("returns null when no slots available", () => {
    const sem = new Semaphore(1);
    sem.tryAcquire();
    expect(sem.tryAcquire()).toBeNull();
  });

  it("releases slot back to pool", () => {
    const sem = new Semaphore(1);
    const slot = sem.tryAcquire()!;
    expect(sem.available).toBe(0);
    slot.release();
    expect(sem.available).toBe(1);
  });

  it("double release is idempotent", () => {
    const sem = new Semaphore(1);
    const slot = sem.tryAcquire()!;
    slot.release();
    slot.release();
    expect(sem.available).toBe(1);
  });

  it("tracks available count correctly", () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);

    const s1 = sem.tryAcquire()!;
    expect(sem.available).toBe(2);

    const s2 = sem.tryAcquire()!;
    expect(sem.available).toBe(1);

    const s3 = sem.tryAcquire()!;
    expect(sem.available).toBe(0);
    expect(sem.tryAcquire()).toBeNull();

    s2.release();
    expect(sem.available).toBe(1);

    const s4 = sem.tryAcquire()!;
    expect(sem.available).toBe(0);

    s1.release();
    s3.release();
    s4.release();
    expect(sem.available).toBe(3);
  });

  it("works with zero capacity", () => {
    const sem = new Semaphore(0);
    expect(sem.available).toBe(0);
    expect(sem.tryAcquire()).toBeNull();
  });
});
