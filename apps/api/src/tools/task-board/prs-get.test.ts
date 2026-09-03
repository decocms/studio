import { describe, expect, it } from "bun:test";
import { lazyOnce } from "./prs-get";

describe("lazyOnce", () => {
  it("shares one in-flight attempt across concurrent callers", async () => {
    let calls = 0;
    const { get } = lazyOnce(async () => {
      calls++;
      return "ok";
    });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(calls).toBe(1);
  });

  it("clears the memo on failure so the next get() retries open()", async () => {
    let calls = 0;
    const { get } = lazyOnce(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return "ok";
    });
    await expect(get()).rejects.toThrow("transient");
    expect(await get()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("never re-opens once a get() succeeds", async () => {
    let calls = 0;
    const { get, current } = lazyOnce(async () => {
      calls++;
      return calls;
    });
    expect(await get()).toBe(1);
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
    expect(current()).toBe(1);
  });
});
