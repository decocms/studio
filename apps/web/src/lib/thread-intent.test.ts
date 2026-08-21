import { describe, expect, it } from "bun:test";
import { claimThreadIntent, writeThreadIntent } from "./thread-intent";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

const LOCATOR = "org/proj";

describe("thread intent", () => {
  it("round-trips the runtime a create asked for", () => {
    const s = memoryStorage();
    writeThreadIntent(s, LOCATOR, "t1", { runtime: "sandbox" });
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({
      runtime: "sandbox",
    });
  });

  it("round-trips a branch alongside the runtime", () => {
    const s = memoryStorage();
    writeThreadIntent(s, LOCATOR, "t1", { runtime: "cms", branch: "main" });
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({
      runtime: "cms",
      branch: "main",
    });
  });

  it("is single-use: a second claim is empty", () => {
    const s = memoryStorage();
    writeThreadIntent(s, LOCATOR, "t1", { runtime: "sandbox" });
    claimThreadIntent(s, LOCATOR, "t1");
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({});
    expect(s.size()).toBe(0);
  });

  it("writes nothing when there is no intent to record", () => {
    const s = memoryStorage();
    writeThreadIntent(s, LOCATOR, "t1", {});
    expect(s.size()).toBe(0);
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({});
  });

  it("is scoped per thread id", () => {
    const s = memoryStorage();
    writeThreadIntent(s, LOCATOR, "t1", { runtime: "sandbox" });
    expect(claimThreadIntent(s, LOCATOR, "t2")).toEqual({});
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({
      runtime: "sandbox",
    });
  });

  it("drops a garbage runtime rather than stamping it", () => {
    const s = memoryStorage();
    s.setItem(
      "studio:chat:threadIntent:org/proj:t1",
      JSON.stringify({ runtime: "SANDBOX", branch: "" }),
    );
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({});
  });

  it("survives unparseable storage", () => {
    const s = memoryStorage();
    s.setItem("studio:chat:threadIntent:org/proj:t1", "{not json");
    expect(claimThreadIntent(s, LOCATOR, "t1")).toEqual({});
  });
});
