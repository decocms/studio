import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import { buildRoomTranscript } from "./room-transcript";

const MARIO = "agent_mario";
const LUIGI = "agent_luigi";

function user(
  text: string,
  opts: {
    agentId?: string;
    agentTitle?: string;
    userName?: string;
  } = {},
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: {
      ...(opts.agentId
        ? { agent: { id: opts.agentId, title: opts.agentTitle } }
        : {}),
      ...(opts.userName ? { user: { name: opts.userName } } : {}),
    },
  } as ChatMessage;
}

function assistant(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
  } as ChatMessage;
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p) => (p as { type?: string }).type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

describe("buildRoomTranscript", () => {
  it("leaves a single-agent thread untouched", () => {
    const history = [user("hi"), assistant("hello"), user("more")];
    expect(buildRoomTranscript(history, MARIO)).toEqual(history);
  });

  it("leaves legacy threads (no agent metadata) untouched", () => {
    const history = [user("hi"), assistant("hello")];
    const out = buildRoomTranscript(history, LUIGI);
    expect(out[1]!.role).toBe("assistant");
  });

  it("keeps the answering agent's own turns as assistant", () => {
    const history = [
      user("diagnose", { agentId: MARIO, agentTitle: "Mario" }),
      assistant("found a broken checkout"),
    ];
    const out = buildRoomTranscript(history, MARIO);
    expect(out[1]!.role).toBe("assistant");
    expect(textOf(out[1]!)).toBe("found a broken checkout");
  });

  it("relabels another agent's turn as a named participant message", () => {
    const history = [
      user("diagnose", { agentId: MARIO, agentTitle: "Mario" }),
      assistant("found a broken checkout"),
      user("now fix it", { agentId: LUIGI, agentTitle: "Luigi" }),
    ];
    const out = buildRoomTranscript(history, LUIGI);

    // Mario's reply must not read as Luigi's own past words.
    expect(out[1]!.role).toBe("user");
    expect(textOf(out[1]!)).toBe("[Mario]: found a broken checkout");
  });

  it("drops tool parts when relabelling (invalid on a user message)", () => {
    const withTool = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "ran a scan" },
        { type: "tool-foo", toolCallId: "t1", state: "output-available" },
      ],
    } as unknown as ChatMessage;
    const history = [
      user("diagnose", { agentId: MARIO, agentTitle: "Mario" }),
      withTool,
      user("fix", { agentId: LUIGI, agentTitle: "Luigi" }),
    ];
    const out = buildRoomTranscript(history, LUIGI);
    expect(out[1]!.parts).toHaveLength(1);
    expect(textOf(out[1]!)).toBe("[Mario]: ran a scan");
  });

  it("describes a tool-only foreign turn instead of emitting empty text", () => {
    const toolOnly = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "tool-foo", toolCallId: "t1" }],
    } as unknown as ChatMessage;
    const history = [
      user("go", { agentId: MARIO, agentTitle: "Mario" }),
      toolOnly,
      user("now you", { agentId: LUIGI, agentTitle: "Luigi" }),
    ];
    const out = buildRoomTranscript(history, LUIGI);
    expect(textOf(out[1]!)).toBe("[Mario]: (worked on this without replying)");
  });

  it("names humans only once a second human speaks", () => {
    const solo = [user("hi", { userName: "Gui" })];
    expect(textOf(buildRoomTranscript(solo, MARIO)[0]!)).toBe("hi");

    const shared = [
      user("hi", { userName: "Gui" }),
      user("me too", { userName: "Ana" }),
    ];
    const out = buildRoomTranscript(shared, MARIO);
    expect(textOf(out[0]!)).toBe("[Gui]: hi");
    expect(textOf(out[1]!)).toBe("[Ana]: me too");
  });

  it("falls back to a neutral name when a foreign turn has no title", () => {
    const history = [
      user("go", { agentId: MARIO }),
      assistant("did it"),
      user("your turn", { agentId: LUIGI, agentTitle: "Luigi" }),
    ];
    const out = buildRoomTranscript(history, LUIGI);
    expect(textOf(out[1]!)).toBe("[Another agent]: did it");
  });

  it("passes system messages through untouched", () => {
    const system = {
      id: "s1",
      role: "system",
      parts: [{ type: "text", text: "be nice" }],
    } as ChatMessage;
    const out = buildRoomTranscript([system, user("hi")], MARIO);
    expect(out[0]).toEqual(system);
  });
});
