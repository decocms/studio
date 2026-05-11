import { test, expect } from "bun:test";
import { isRestartRequired } from "./restart-required";

const NONE = { selected: null, port: null, path: null };

test("returns false when not running", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: null, path: null },
      startedRuntime: { packageManager: "bun", port: null, path: null },
      hasEntry: true,
      isRunning: false,
    }),
  ).toBe(false);
});

test("returns false when there's no entry", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: null, path: null },
      startedRuntime: { packageManager: "bun", port: null, path: null },
      hasEntry: false,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns false on legacy entry (startedRuntime undefined)", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: "3000", path: "apps/foo" },
      startedRuntime: undefined,
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns true when packageManager diverges", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: null, path: null },
      startedRuntime: { packageManager: "bun", port: null, path: null },
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(true);
});

test("returns true when only port diverges", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: "4000", path: null },
      startedRuntime: { packageManager: "pnpm", port: "3000", path: null },
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(true);
});

test("returns true when only path diverges", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: null, path: "apps/web" },
      startedRuntime: { packageManager: "pnpm", port: null, path: null },
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(true);
});

test("returns false when all three fields match", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: "pnpm", port: "3000", path: "apps/web" },
      startedRuntime: {
        packageManager: "pnpm",
        port: "3000",
        path: "apps/web",
      },
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns false when all three fields are null on both sides", () => {
  expect(
    isRestartRequired({
      liveRuntime: NONE,
      startedRuntime: { packageManager: null, port: null, path: null },
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(false);
});

test("returns true when live packageManager null vs explicit started", () => {
  expect(
    isRestartRequired({
      liveRuntime: { selected: null, port: null, path: null },
      startedRuntime: { packageManager: "pnpm", port: null, path: null },
      hasEntry: true,
      isRunning: true,
    }),
  ).toBe(true);
});
