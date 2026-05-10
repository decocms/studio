import { test, expect } from "bun:test";
import {
  activePhaseIndex,
  formatElapsed,
  headlineFor,
  phaseStatusFor,
  phaseTickGlyph,
} from "./state-card-helpers";

test("formatElapsed renders mm:ss zero-padded", () => {
  expect(formatElapsed(0)).toBe("00:00");
  expect(formatElapsed(42_000)).toBe("00:42");
  expect(formatElapsed(75_000)).toBe("01:15");
  expect(formatElapsed(3_599_000)).toBe("59:59");
});

test("formatElapsed clamps negatives to 00:00", () => {
  expect(formatElapsed(-1)).toBe("00:00");
});

test("phaseTickGlyph returns the right glyph per status", () => {
  expect(phaseTickGlyph("done")).toBe("✓");
  expect(phaseTickGlyph("failed")).toBe("✗");
  expect(phaseTickGlyph("doing")).toBe("◐");
  expect(phaseTickGlyph("pending")).toBe("○");
});

test("headlineFor maps each kind to its headline", () => {
  expect(headlineFor("never-started")).toBe("Preview will appear here");
  expect(headlineFor("starting-now")).toBe("Starting your dev server");
  expect(headlineFor("errored")).toBe("Failed to start dev server");
  expect(headlineFor("suspended")).toBe("Sandbox is paused");
});

test("phaseStatusFor returns done for keys before the current step", () => {
  expect(
    phaseStatusFor({ step: "install", status: "doing" }, "provision"),
  ).toBe("done");
  expect(phaseStatusFor({ step: "install", status: "doing" }, "cloning")).toBe(
    "done",
  );
});

test("phaseStatusFor returns the current status for the matching key", () => {
  expect(phaseStatusFor({ step: "install", status: "doing" }, "install")).toBe(
    "doing",
  );
  expect(phaseStatusFor({ step: "install", status: "failed" }, "install")).toBe(
    "failed",
  );
});

test("phaseStatusFor returns pending for keys after the current step", () => {
  expect(phaseStatusFor({ step: "install", status: "doing" }, "dev")).toBe(
    "pending",
  );
});

test("activePhaseIndex returns the index of the current step", () => {
  expect(activePhaseIndex({ step: "provision", status: "doing" })).toBe(0);
  expect(activePhaseIndex({ step: "cloning", status: "doing" })).toBe(1);
  expect(activePhaseIndex({ step: "install", status: "doing" })).toBe(2);
  expect(activePhaseIndex({ step: "dev", status: "done" })).toBe(3);
});
