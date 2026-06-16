import { describe, expect, test } from "bun:test";
import { parseSleepMs } from "./bash-sleep.ts";

describe("parseSleepMs", () => {
  test("returns null when there is no sleep", () => {
    expect(parseSleepMs("ls -la")).toBeNull();
    expect(parseSleepMs("echo sleeping")).toBeNull();
    expect(parseSleepMs("./sleepyhead.sh")).toBeNull();
    expect(parseSleepMs("sleep")).toBeNull();
  });

  test("parses a bare sleep in seconds", () => {
    expect(parseSleepMs("sleep 30")).toBe(30_000);
    expect(parseSleepMs("sleep 0.5")).toBe(500);
  });

  test("honors coreutils unit suffixes", () => {
    expect(parseSleepMs("sleep 5m")).toBe(300_000);
    expect(parseSleepMs("sleep 2h")).toBe(7_200_000);
    expect(parseSleepMs("sleep 1d")).toBe(86_400_000);
    expect(parseSleepMs("sleep 10s")).toBe(10_000);
  });

  test("sums multiple args and multiple sleeps", () => {
    expect(parseSleepMs("sleep 1m 30")).toBe(90_000);
    expect(parseSleepMs("sleep 10 && sleep 5")).toBe(15_000);
    expect(parseSleepMs("foo; sleep 3 | bar")).toBe(3_000);
  });

  test("matches only on a word boundary before sleep", () => {
    expect(parseSleepMs("(sleep 2)")).toBe(2_000);
    expect(parseSleepMs("nosleep 2")).toBeNull();
  });
});
