import { describe, expect, test } from "bun:test";
import {
  resolveContentSandboxGate,
  type SandboxCardState,
} from "./content-sandbox-gate";

const PREVIEW_URL = "https://sandbox.example.deco.host";
const NON_IFRAME_STATES: SandboxCardState[] = [
  { kind: "starting" },
  { kind: "suspended" },
  { kind: "errored", error: { code: null, message: "boom" } },
];

describe("resolveContentSandboxGate", () => {
  test("fast preview renders immediately — no pod is coming", () => {
    expect(
      resolveContentSandboxGate({
        fastPreviewActive: true,
        previewState: { kind: "starting" },
        lifecyclePhase: "idle",
      }),
    ).toEqual({ kind: "ready", devServerReady: false, sandboxWarming: false });
  });

  test.each(NON_IFRAME_STATES)(
    "fast preview ignores previewState $kind",
    (previewState) => {
      expect(
        resolveContentSandboxGate({
          fastPreviewActive: true,
          previewState,
          lifecyclePhase: "idle",
        }).kind,
      ).toBe("ready");
    },
  );

  test.each(NON_IFRAME_STATES)(
    "sandbox mode hands the canvas to the card while $kind",
    (previewState) => {
      expect(
        resolveContentSandboxGate({
          fastPreviewActive: false,
          previewState,
          lifecyclePhase: "cloning",
        }),
      ).toEqual({ kind: "sandbox-card", state: previewState });
    },
  );

  test("sandbox mode: dev server up", () => {
    expect(
      resolveContentSandboxGate({
        fastPreviewActive: false,
        previewState: { kind: "iframe", previewUrl: PREVIEW_URL },
        lifecyclePhase: "running",
      }),
    ).toEqual({ kind: "ready", devServerReady: true, sandboxWarming: false });
  });

  test.each([
    "idle",
    "cloning",
    "checking-out",
    "installing",
    "starting",
  ] as const)("sandbox mode: %s still warming", (lifecyclePhase) => {
    expect(
      resolveContentSandboxGate({
        fastPreviewActive: false,
        previewState: { kind: "iframe", previewUrl: PREVIEW_URL },
        lifecyclePhase,
      }),
    ).toEqual({ kind: "ready", devServerReady: false, sandboxWarming: true });
  });

  test.each([
    "clone-failed",
    "install-failed",
    "start-failed",
    "crashed",
  ] as const)("sandbox mode: %s stops warming", (lifecyclePhase) => {
    expect(
      resolveContentSandboxGate({
        fastPreviewActive: false,
        previewState: { kind: "iframe", previewUrl: PREVIEW_URL },
        lifecyclePhase,
      }),
    ).toEqual({ kind: "ready", devServerReady: false, sandboxWarming: false });
  });
});
