import { describe, expect, it } from "bun:test";
import { resolveNeedsRuntimeSetup } from "./resolve-needs-runtime-setup";
import type { AgentOptionAvailability } from "./pills/agent-options";

const none: AgentOptionAvailability = {
  agentSandbox: false,
  userDesktop: false,
  claudeCode: false,
  codex: false,
};
const claudeOnly: AgentOptionAvailability = {
  ...none,
  userDesktop: true,
  claudeCode: true,
};

const base = {
  isThreadLocked: false,
  isDesktopApp: false,
  hasCloudProviderKeys: false,
  pendingAgentOption: null,
  availability: none,
};

describe("resolveNeedsRuntimeSetup", () => {
  it("never gates a locked thread — its history must stay visible", () => {
    expect(resolveNeedsRuntimeSetup({ ...base, isThreadLocked: true })).toBe(
      false,
    );
    expect(
      resolveNeedsRuntimeSetup({
        ...base,
        isThreadLocked: true,
        isDesktopApp: true,
      }),
    ).toBe(false);
  });

  describe("native", () => {
    it("gates while the local resolver has no option (cold detection / no CLI)", () => {
      expect(resolveNeedsRuntimeSetup({ ...base, isDesktopApp: true })).toBe(
        true,
      );
    });

    it("ignores cloud provider keys — native can't run on them", () => {
      expect(
        resolveNeedsRuntimeSetup({
          ...base,
          isDesktopApp: true,
          hasCloudProviderKeys: true,
        }),
      ).toBe(true);
    });

    it("releases once a local option is resolved, even before detection confirms it", () => {
      expect(
        resolveNeedsRuntimeSetup({
          ...base,
          isDesktopApp: true,
          pendingAgentOption: "claude-code-desktop",
        }),
      ).toBe(false);
      expect(
        resolveNeedsRuntimeSetup({
          ...base,
          isDesktopApp: true,
          pendingAgentOption: "codex-desktop",
        }),
      ).toBe(false);
    });
  });

  describe("web", () => {
    it("gates when there is no cloud key and no usable local runtime", () => {
      expect(resolveNeedsRuntimeSetup(base)).toBe(true);
      expect(
        resolveNeedsRuntimeSetup({
          ...base,
          pendingAgentOption: "claude-code-desktop",
        }),
      ).toBe(true);
    });

    it("releases on a cloud provider key", () => {
      expect(
        resolveNeedsRuntimeSetup({ ...base, hasCloudProviderKeys: true }),
      ).toBe(false);
    });

    it("releases on a picked local runtime that is actually available", () => {
      expect(
        resolveNeedsRuntimeSetup({
          ...base,
          pendingAgentOption: "claude-code-desktop",
          availability: claudeOnly,
        }),
      ).toBe(false);
    });

    it("keeps gating when the picked local runtime is not the detected one", () => {
      expect(
        resolveNeedsRuntimeSetup({
          ...base,
          pendingAgentOption: "codex-desktop",
          availability: claudeOnly,
        }),
      ).toBe(true);
    });
  });
});
