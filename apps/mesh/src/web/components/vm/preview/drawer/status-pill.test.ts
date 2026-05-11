import { expect, test } from "bun:test";
import { sandboxStatusClass } from "./status-pill";

test("sandboxStatusClass returns a non-empty string for each status", () => {
  const all = ["idle", "starting", "running", "suspended", "errored"] as const;
  for (const status of all) {
    const cls = sandboxStatusClass(status);
    expect(typeof cls).toBe("string");
    expect(cls.length).toBeGreaterThan(0);
  }
});

test("sandboxStatusClass returns distinct class per status", () => {
  const all = ["idle", "starting", "running", "suspended", "errored"] as const;
  const classes = all.map((s) => sandboxStatusClass(s));
  expect(new Set(classes).size).toBe(all.length);
});

test("starting status uses purple", () => {
  expect(sandboxStatusClass("starting")).toContain("purple");
});

test("running status uses emerald", () => {
  expect(sandboxStatusClass("running")).toContain("emerald");
});

test("idle status uses muted", () => {
  expect(sandboxStatusClass("idle")).toContain("muted");
});
