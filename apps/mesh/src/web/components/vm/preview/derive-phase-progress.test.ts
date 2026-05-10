import { test, expect } from "bun:test";
import type { LifecycleState } from "@decocms/sandbox/shared";
import { derivePhaseProgress, PHASE_ORDER } from "./derive-phase-progress";

const idle: LifecycleState = { phase: "idle" };

test("PHASE_ORDER lists the four phases in order", () => {
  expect([...PHASE_ORDER]).toEqual(["provision", "cloning", "install", "dev"]);
});

test("provision/doing while claimPhase is non-ready and lifecycle idle", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "pulling-image", since: 0 },
      lifecycle: idle,
    }),
  ).toEqual({ step: "provision", status: "doing" });
});

test("cloning/doing when claimPhase null and lifecycle idle", () => {
  expect(derivePhaseProgress({ claimPhase: null, lifecycle: idle })).toEqual({
    step: "cloning",
    status: "doing",
  });
});

test("cloning/doing when claimPhase ready and lifecycle still idle", () => {
  expect(
    derivePhaseProgress({ claimPhase: { kind: "ready" }, lifecycle: idle }),
  ).toEqual({ step: "cloning", status: "doing" });
});

test("cloning/doing during lifecycle cloning", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "cloning" },
    }),
  ).toEqual({ step: "cloning", status: "doing" });
});

test("cloning/doing during lifecycle checking-out", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "checking-out", to: "feat/x" },
    }),
  ).toEqual({ step: "cloning", status: "doing" });
});

test("cloning/failed on clone-failed", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "clone-failed", error: "exit 128" },
    }),
  ).toEqual({ step: "cloning", status: "failed" });
});

test("install/doing during installing", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "installing" },
    }),
  ).toEqual({ step: "install", status: "doing" });
});

test("install/failed on install-failed", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "install-failed", error: "ENOENT" },
    }),
  ).toEqual({ step: "install", status: "failed" });
});

test("dev/doing during starting", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "starting" },
    }),
  ).toEqual({ step: "dev", status: "doing" });
});

test("dev/done once running", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "running", port: 3000, htmlSupport: true },
    }),
  ).toEqual({ step: "dev", status: "done" });
});

test("dev/failed on start-failed", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "start-failed", error: "exit 1" },
    }),
  ).toEqual({ step: "dev", status: "failed" });
});

test("dev/failed when daemon's probe sees the dev server crash", () => {
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "ready" },
      lifecycle: { phase: "crashed" },
    }),
  ).toEqual({ step: "dev", status: "failed" });
});

test("lifecycle wins over claimPhase once it leaves idle", () => {
  // Even with claimPhase still mid-provision, a non-idle lifecycle takes
  // precedence — the daemon is online and authoritative.
  expect(
    derivePhaseProgress({
      claimPhase: { kind: "pulling-image", since: 0 },
      lifecycle: { phase: "installing" },
    }),
  ).toEqual({ step: "install", status: "doing" });
});
