import { describe, expect, test } from "bun:test";
import type { Capability } from "@/links/protocol";
import { computeAgentOptions, type AgentOption } from "./agent-options";

const OFFLINE = { online: false, capabilities: [] as readonly Capability[] };
const ONLINE = (caps: readonly Capability[]) => ({
  online: true,
  capabilities: caps,
});

describe("computeAgentOptions", () => {
  test("returns empty when no key and no link", () => {
    expect(computeAgentOptions({ hasAnyKey: false, link: OFFLINE })).toEqual(
      [],
    );
  });

  test("keys only → just Decopilot", () => {
    expect(computeAgentOptions({ hasAnyKey: true, link: OFFLINE })).toEqual([
      "decopilot",
    ] as AgentOption[]);
  });

  test("link with sandbox cap only, no keys → no options (decopilot-laptop needs a key)", () => {
    expect(
      computeAgentOptions({
        hasAnyKey: false,
        link: ONLINE(["decopilot-sandbox"] satisfies Capability[]),
      }),
    ).toEqual([]);
  });

  test("link with claude-code but no key → just Claude Code desktop (CLI options don't need cloud keys)", () => {
    expect(
      computeAgentOptions({
        hasAnyKey: false,
        link: ONLINE([
          "decopilot-sandbox",
          "claude-code",
        ] satisfies Capability[]),
      }),
    ).toEqual(["claude-code-laptop"] as AgentOption[]);
  });

  test("link with claude-code AND codex but no key → both CLI options surface", () => {
    expect(
      computeAgentOptions({
        hasAnyKey: false,
        link: ONLINE(["claude-code", "codex"] satisfies Capability[]),
      }),
    ).toEqual(["claude-code-laptop", "codex-laptop"] as AgentOption[]);
  });

  test("key + link with claude-code → Decopilot + Claude Code desktop", () => {
    expect(
      computeAgentOptions({
        hasAnyKey: true,
        link: ONLINE([
          "decopilot-sandbox",
          "claude-code",
        ] satisfies Capability[]),
      }),
    ).toEqual(["decopilot", "decopilot-laptop", "claude-code-laptop"]);
  });

  test("keys + full link → all four", () => {
    expect(
      computeAgentOptions({
        hasAnyKey: true,
        link: ONLINE([
          "decopilot-sandbox",
          "claude-code",
          "codex",
        ] satisfies Capability[]),
      }),
    ).toEqual([
      "decopilot",
      "decopilot-laptop",
      "claude-code-laptop",
      "codex-laptop",
    ]);
  });

  test("decopilot-laptop requires sandbox cap even with keys", () => {
    expect(
      computeAgentOptions({
        hasAnyKey: true,
        link: ONLINE([] satisfies Capability[]),
      }),
    ).toEqual(["decopilot"]);
  });
});
