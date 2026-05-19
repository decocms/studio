import { describe, expect, it } from "bun:test";
import { Store } from "./store-primitive";

describe("Store", () => {
  it("returns the initial value", () => {
    const s = new Store(0);
    expect(s.get()).toBe(0);
  });
  it("notifies subscribers on change", () => {
    const s = new Store(0);
    let calls = 0;
    s.subscribe(() => calls++);
    s.set(1);
    expect(calls).toBe(1);
    expect(s.get()).toBe(1);
  });
  it("skips notification when value is Object.is-equal", () => {
    const s = new Store(0);
    let calls = 0;
    s.subscribe(() => calls++);
    s.set(0);
    expect(calls).toBe(0);
  });
  it("update() applies a reducer", () => {
    const s = new Store(1);
    s.update((x) => x + 1);
    expect(s.get()).toBe(2);
  });
  it("unsubscribes cleanly", () => {
    const s = new Store(0);
    let calls = 0;
    const unsub = s.subscribe(() => calls++);
    unsub();
    s.set(1);
    expect(calls).toBe(0);
  });
});
