import { test, expect } from "bun:test";
import { parsePortInput } from "./parse-port";

test("parsePortInput accepts a valid port", () => {
  expect(parsePortInput("3000")).toEqual({ ok: true, value: "3000" });
  expect(parsePortInput("1")).toEqual({ ok: true, value: "1" });
  expect(parsePortInput("65535")).toEqual({ ok: true, value: "65535" });
});

test("parsePortInput treats blank as ok-with-null", () => {
  expect(parsePortInput("")).toEqual({ ok: true, value: null });
  expect(parsePortInput("   ")).toEqual({ ok: true, value: null });
});

test("parsePortInput rejects non-numeric and out-of-range", () => {
  expect(parsePortInput("abc").ok).toBe(false);
  expect(parsePortInput("0").ok).toBe(false);
  expect(parsePortInput("65536").ok).toBe(false);
  expect(parsePortInput("-1").ok).toBe(false);
});

test("parsePortInput canonicalizes leading zeros", () => {
  // Non-canonical input must normalize to the decimal form so the persisted
  // value matches what the daemon snapshots into `startedWith.port`.
  expect(parsePortInput("03000")).toEqual({ ok: true, value: "3000" });
  expect(parsePortInput("0001")).toEqual({ ok: true, value: "1" });
  expect(parsePortInput(" 3000 ")).toEqual({ ok: true, value: "3000" });
});
