import { describe, expect, test } from "bun:test";
import type { Capability } from "@/links/protocol";
import { getAgentSections } from "./agent-models";

const OFFLINE = { online: false, capabilities: [] as readonly Capability[] };
const ONLINE = (caps: readonly Capability[]) => ({
  online: true,
  capabilities: caps,
});

describe("getAgentSections", () => {
  test("no keys + no link → empty list", () => {
    expect(
      getAgentSections({ hasAnyKey: false, link: OFFLINE }).map((s) => s.kind),
    ).toEqual([]);
  });

  test("keys + offline link → only Decopilot, not flagged local", () => {
    const sections = getAgentSections({ hasAnyKey: true, link: OFFLINE });
    expect(sections.map((s) => s.kind)).toEqual(["decopilot"]);
    expect(sections[0]!.isLocal).toBe(false);
  });

  test("no keys + online claude-code capability → only Claude Code, flagged local", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["claude-code"]),
    });
    expect(sections.map((s) => s.kind)).toEqual(["claude-code"]);
    expect(sections[0]!.isLocal).toBe(true);
  });

  test("no keys + online codex capability → only Codex, flagged local", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["codex"]),
    });
    expect(sections.map((s) => s.kind)).toEqual(["codex"]);
    expect(sections[0]!.isLocal).toBe(true);
  });

  test("keys + online both CLI caps → all three in stable order", () => {
    const sections = getAgentSections({
      hasAnyKey: true,
      link: ONLINE(["claude-code", "codex"]),
    });
    expect(sections.map((s) => s.kind)).toEqual([
      "decopilot",
      "claude-code",
      "codex",
    ]);
    expect(sections.map((s) => s.isLocal)).toEqual([false, true, true]);
  });

  test("decopilot section exposes Fast/Smart/Thinking tiers with non-null labels", () => {
    const [decopilot] = getAgentSections({ hasAnyKey: true, link: OFFLINE });
    expect(decopilot!.title).toBe("Decopilot");
    expect(decopilot!.tiers.fast.label).toBe("Fast");
    expect(decopilot!.tiers.smart.label).toBe("Smart");
    expect(decopilot!.tiers.thinking.label).toBe("Thinking");
    expect(decopilot!.tiers.fast.modelId).toBeNull();
    expect(decopilot!.tiers.smart.modelId).toBeNull();
    expect(decopilot!.tiers.thinking.modelId).toBeNull();
  });

  test("claude-code section exposes the three CLI model labels with non-null modelIds", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["claude-code"]),
    });
    const claude = sections[0]!;
    expect(claude.title).toBe("Claude Code");
    expect(claude.tiers.fast.modelId).toBe("claude-code:haiku");
    expect(claude.tiers.smart.modelId).toBe("claude-code:sonnet");
    expect(claude.tiers.thinking.modelId).toBe("claude-code:opus");
    expect(claude.tiers.fast.label).toBe("Haiku");
    expect(claude.tiers.smart.label).toBe("Sonnet");
    expect(claude.tiers.thinking.label).toBe("Opus");
  });

  test("codex section exposes the three Codex model labels", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["codex"]),
    });
    const codex = sections[0]!;
    expect(codex.title).toBe("Codex");
    expect(codex.tiers.fast.modelId).toBe("codex:gpt-5.4-mini");
    expect(codex.tiers.smart.modelId).toBe("codex:gpt-5.3-codex");
    expect(codex.tiers.thinking.modelId).toBe("codex:gpt-5.5");
  });
});
