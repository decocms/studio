import { test, expect } from "bun:test";
import { activePhaseIndex, headlineFor } from "./state-card-helpers";

test("headlineFor maps each kind to its headline", () => {
  expect(headlineFor("starting")).toBe("Starting your sandbox");
  expect(headlineFor("suspended")).toBe("Sandbox is paused");
});

test("activePhaseIndex returns the index of the current step", () => {
  expect(activePhaseIndex({ step: "provision", status: "doing" })).toBe(0);
  expect(activePhaseIndex({ step: "cloning", status: "doing" })).toBe(1);
  expect(activePhaseIndex({ step: "install", status: "doing" })).toBe(2);
  expect(activePhaseIndex({ step: "dev", status: "done" })).toBe(3);
});
