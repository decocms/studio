import { test, expect } from "bun:test";
import { statusPillFor } from "./status-pill";

test("statusPillFor returns label and className per status", () => {
  expect(statusPillFor("idle").label).toBe("stopped");
  expect(statusPillFor("starting").label).toBe("starting");
  expect(statusPillFor("running").label).toBe("running");
  expect(statusPillFor("suspended").label).toBe("suspended");
  expect(statusPillFor("errored").label).toBe("error");
});

test("statusPillFor returns distinct className per status", () => {
  const all = ["idle", "starting", "running", "suspended", "errored"] as const;
  const classes = all.map((s) => statusPillFor(s).className);
  expect(new Set(classes).size).toBe(all.length);
});
