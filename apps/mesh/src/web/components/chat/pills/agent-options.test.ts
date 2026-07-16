import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_PINS,
  type AgentOption,
  type AgentOptionAvailability,
  type AgentPins,
  agentOptionFor,
  agentOptionIsAvailable,
  preferredLocalAgentOption,
  resolveOfflineAgentOption,
} from "./agent-options";

const ALL_AVAILABLE: AgentOptionAvailability = {
  agentSandbox: true,
  userDesktop: true,
  claudeCode: true,
  codex: true,
};

const DESKTOP_OFFLINE: AgentOptionAvailability = {
  agentSandbox: true,
  userDesktop: false,
  claudeCode: true, // capability advertised, but link offline → still unavailable
  codex: true,
};

describe("agentOptionFor", () => {
  test("maps decopilot harness with agent-sandbox sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", "agent-sandbox")).toBe("decopilot");
  });

  test("normalizes legacy cluster sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", "cluster")).toBe("decopilot");
  });

  test("decopilot harness with user-desktop sandbox has no option (retired)", () => {
    // "local decopilot" was removed — the cloud router is the only decopilot
    // runtime. A legacy thread persisted with this pair maps to no known
    // option and is treated as locked-unknown.
    expect(agentOptionFor("decopilot", "user-desktop")).toBeNull();
  });

  test("maps legacy decopilot harness with null sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", null)).toBe("decopilot");
  });

  test("maps claude-code + user-desktop to claude-code-desktop", () => {
    expect(agentOptionFor("claude-code", "user-desktop")).toBe(
      "claude-code-desktop",
    );
  });

  test("maps codex + user-desktop to codex-desktop", () => {
    expect(agentOptionFor("codex", "user-desktop")).toBe("codex-desktop");
  });

  test("returns null for unknown harness", () => {
    // @ts-expect-error — deliberately passing an out-of-union value
    expect(agentOptionFor("unknown-harness", null)).toBeNull();
  });

  test("returns null for null harness", () => {
    expect(agentOptionFor(null, "user-desktop")).toBeNull();
  });

  test("round-trips against AGENT_OPTION_PINS", () => {
    for (const [option, pins] of Object.entries(AGENT_OPTION_PINS) as [
      AgentOption,
      AgentPins,
    ][]) {
      expect(agentOptionFor(pins.harness, pins.sandbox)).toBe(option);
    }
  });
});

describe("agentOptionIsAvailable", () => {
  test("cloud decopilot needs agent-sandbox only", () => {
    expect(agentOptionIsAvailable("decopilot", ALL_AVAILABLE)).toBe(true);
    expect(
      agentOptionIsAvailable("decopilot", {
        ...ALL_AVAILABLE,
        agentSandbox: false,
      }),
    ).toBe(false);
    // desktop being offline does not affect the cloud option
    expect(agentOptionIsAvailable("decopilot", DESKTOP_OFFLINE)).toBe(true);
  });

  test("desktop options require the link to be online", () => {
    expect(agentOptionIsAvailable("claude-code-desktop", DESKTOP_OFFLINE)).toBe(
      false,
    );
    expect(agentOptionIsAvailable("codex-desktop", DESKTOP_OFFLINE)).toBe(
      false,
    );
  });

  test("CLI options require both the link and the advertised capability", () => {
    expect(agentOptionIsAvailable("claude-code-desktop", ALL_AVAILABLE)).toBe(
      true,
    );
    expect(
      agentOptionIsAvailable("claude-code-desktop", {
        ...ALL_AVAILABLE,
        claudeCode: false,
      }),
    ).toBe(false);
    expect(
      agentOptionIsAvailable("codex-desktop", {
        ...ALL_AVAILABLE,
        codex: false,
      }),
    ).toBe(false);
  });
});

describe("preferredLocalAgentOption", () => {
  test("Claude Code wins when both CLIs are present", () => {
    expect(preferredLocalAgentOption(ALL_AVAILABLE)).toBe(
      "claude-code-desktop",
    );
  });

  test("falls back to Codex when only Codex is present", () => {
    expect(
      preferredLocalAgentOption({ ...ALL_AVAILABLE, claudeCode: false }),
    ).toBe("codex-desktop");
  });

  test("null when no local CLI is available", () => {
    expect(
      preferredLocalAgentOption({
        ...ALL_AVAILABLE,
        claudeCode: false,
        codex: false,
      }),
    ).toBeNull();
  });
});

describe("resolveOfflineAgentOption", () => {
  test("auto-switches a desktop pick to cloud when the link is offline", () => {
    expect(resolveOfflineAgentOption("claude-code-desktop", true)).toBe(
      "decopilot",
    );
    expect(resolveOfflineAgentOption("codex-desktop", true)).toBe("decopilot");
  });

  test("keeps the desktop pick while the link is online (or unresolved)", () => {
    // The old behavior: a desktop pick is preserved exactly. It must only be
    // overridden on a *confirmed* offline probe, never the unresolved default.
    expect(resolveOfflineAgentOption("claude-code-desktop", false)).toBe(
      "claude-code-desktop",
    );
    expect(resolveOfflineAgentOption("codex-desktop", false)).toBe(
      "codex-desktop",
    );
  });

  test("leaves cloud and null picks untouched regardless of link state", () => {
    expect(resolveOfflineAgentOption("decopilot", true)).toBe("decopilot");
    expect(resolveOfflineAgentOption("decopilot", false)).toBe("decopilot");
    expect(resolveOfflineAgentOption(null, true)).toBeNull();
    expect(resolveOfflineAgentOption(null, false)).toBeNull();
  });
});
