import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_PINS,
  type AgentOption,
  type AgentOptionAvailability,
  type AgentPins,
  agentOptionFor,
  agentOptionIsAvailable,
  resolveAvailableAgentOption,
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

  test("maps decopilot harness with user-desktop sandbox to decopilot-desktop option", () => {
    expect(agentOptionFor("decopilot", "user-desktop")).toBe(
      "decopilot-desktop",
    );
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
    expect(agentOptionIsAvailable("decopilot-desktop", ALL_AVAILABLE)).toBe(
      true,
    );
    expect(agentOptionIsAvailable("decopilot-desktop", DESKTOP_OFFLINE)).toBe(
      false,
    );
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

describe("resolveAvailableAgentOption", () => {
  test("keeps an available pick unchanged", () => {
    expect(
      resolveAvailableAgentOption("claude-code-desktop", ALL_AVAILABLE),
    ).toBe("claude-code-desktop");
    expect(resolveAvailableAgentOption("decopilot", ALL_AVAILABLE)).toBe(
      "decopilot",
    );
  });

  test("null pick stays null (server picks the default)", () => {
    expect(resolveAvailableAgentOption(null, ALL_AVAILABLE)).toBeNull();
    expect(resolveAvailableAgentOption(null, DESKTOP_OFFLINE)).toBeNull();
  });

  // The reported bug: a "Claude Code desktop" pick carried over from another
  // org while this org's desktop link is offline must fall back to cloud
  // Decopilot rather than dispatch to the dead link (user_desktop_link_offline).
  test("falls back to cloud Decopilot when the desktop pick is offline", () => {
    expect(
      resolveAvailableAgentOption("claude-code-desktop", DESKTOP_OFFLINE),
    ).toBe("decopilot");
    expect(
      resolveAvailableAgentOption("decopilot-desktop", DESKTOP_OFFLINE),
    ).toBe("decopilot");
    expect(resolveAvailableAgentOption("codex-desktop", DESKTOP_OFFLINE)).toBe(
      "decopilot",
    );
  });

  test("returns null when nothing is available", () => {
    expect(
      resolveAvailableAgentOption("claude-code-desktop", {
        agentSandbox: false,
        userDesktop: false,
        claudeCode: false,
        codex: false,
      }),
    ).toBeNull();
  });

  test("prefers a desktop fallback when cloud is unavailable but a CLI is online", () => {
    expect(
      resolveAvailableAgentOption("codex-desktop", {
        agentSandbox: false,
        userDesktop: true,
        claudeCode: true,
        codex: false,
      }),
    ).toBe("decopilot-desktop");
  });
});
