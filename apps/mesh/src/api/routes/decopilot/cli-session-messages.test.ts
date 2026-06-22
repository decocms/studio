import { describe, expect, it } from "bun:test";
import {
  cliProviderName,
  computeCliDelta,
  resolveCliSessionRef,
} from "./cli-session-messages";
import type { ChatMessage } from "./types";

const user = (id: string, text: string): ChatMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as ChatMessage;

const assistant = (
  id: string,
  sessionId?: string,
  provider?: string,
): ChatMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: "ok" }],
    ...(sessionId
      ? {
          metadata: {
            codingAgentSessionId: sessionId,
            codingAgentProvider: provider,
          },
        }
      : {}),
  }) as ChatMessage;

describe("cliProviderName", () => {
  it("maps harness ids to provider names", () => {
    expect(cliProviderName("codex")).toBe("codex");
    expect(cliProviderName("claude-code")).toBe("claude-code");
    expect(cliProviderName("decopilot")).toBeUndefined();
  });
});

describe("resolveCliSessionRef", () => {
  it("returns undefined for decopilot", () => {
    expect(
      resolveCliSessionRef([assistant("a", "s1", "codex")], "decopilot"),
    ).toBeUndefined();
  });
  it("returns the latest matching-provider session id", () => {
    const msgs = [
      user("u1", "hi"),
      assistant("a1", "s1", "codex"),
      user("u2", "more"),
      assistant("a2", "s2", "codex"),
    ];
    expect(resolveCliSessionRef(msgs, "codex")).toBe("s2");
  });
  it("ignores session ids from a different provider", () => {
    const msgs = [
      user("u1", "hi"),
      assistant("a1", "ccsession", "claude-code"),
    ];
    expect(resolveCliSessionRef(msgs, "codex")).toBeUndefined();
  });
  it("returns undefined on a first turn (no assistant yet)", () => {
    expect(resolveCliSessionRef([user("u1", "hi")], "codex")).toBeUndefined();
  });
});

describe("computeCliDelta", () => {
  it("first turn: returns the only user message", () => {
    const msgs = [user("u1", "hi")];
    expect(computeCliDelta(msgs, "codex").map((m) => m.id)).toEqual(["u1"]);
  });
  it("resumed turn: returns only user messages after the last session anchor", () => {
    const msgs = [
      user("u1", "hi"),
      assistant("a1", "s1", "codex"),
      user("u2", "second"),
    ];
    expect(computeCliDelta(msgs, "codex").map((m) => m.id)).toEqual(["u2"]);
  });
  it("resumed turn with no trailing user message: returns an empty delta", () => {
    // History tail is a completed assistant anchor with no new user input.
    // The dispatcher turns this empty delta into a defined PermanentRunError
    // rather than sending zero messages to the CLI.
    const msgs = [user("u1", "hi"), assistant("a1", "s1", "codex")];
    expect(computeCliDelta(msgs, "codex")).toEqual([]);
  });
  it("queued messages: returns all user messages after the anchor", () => {
    const msgs = [
      user("u1", "hi"),
      assistant("a1", "s1", "codex"),
      user("u2", "second"),
      user("u3", "third"),
    ];
    expect(computeCliDelta(msgs, "codex").map((m) => m.id)).toEqual([
      "u2",
      "u3",
    ]);
  });
  it("anchor from a different provider is ignored (treated as first turn)", () => {
    const msgs = [
      user("u1", "hi"),
      assistant("a1", "ccsession", "claude-code"),
      user("u2", "second"),
    ];
    expect(computeCliDelta(msgs, "codex").map((m) => m.id)).toEqual([
      "u1",
      "u2",
    ]);
  });
});
