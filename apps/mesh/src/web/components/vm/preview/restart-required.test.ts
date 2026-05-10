import { test, expect } from "bun:test";
import { isRestartRequired } from "./restart-required";

test("returns false when not running", () => {
  expect(
    isRestartRequired({
      liveSelected: "pnpm",
      startedPackageManager: "bun",
      hasEntry: true,
      isRunning: false,
    }),
  ).toBe(false);
});

test("returns false when there's no entry", () => {
  expect(
    isRestartRequired({
      liveSelected: "pnpm",
      startedPackageManager: "bun",
      hasEntry: false,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns false on legacy entry (startedPackageManager undefined)", () => {
  expect(
    isRestartRequired({
      liveSelected: "pnpm",
      startedPackageManager: undefined,
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns true when running and selected diverges from started", () => {
  expect(
    isRestartRequired({
      liveSelected: "pnpm",
      startedPackageManager: "bun",
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(true);
});

test("returns false when both null", () => {
  expect(
    isRestartRequired({
      liveSelected: null,
      startedPackageManager: null,
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns true when null vs explicit", () => {
  expect(
    isRestartRequired({
      liveSelected: null,
      startedPackageManager: "pnpm",
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(true);
});
