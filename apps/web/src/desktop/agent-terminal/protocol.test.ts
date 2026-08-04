import { describe, expect, test } from "bun:test";
import {
  appendTerminalReplay,
  chunkTerminalInput,
  normalizeTerminalDimensions,
  parseTerminalServerFrame,
  shouldResetTerminalReplay,
  terminalPromptFitsWire,
  terminalLifecycleAfterExit,
  terminalWebSocketUrl,
  threadStatusFromTerminalLifecycle,
  toTerminalHarnessId,
} from "./protocol";

describe("native terminal protocol", () => {
  test("parses the canonical camelCase lifecycle frames", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "ready",
          sessionId: "session-1",
          generation: "thread-generation-3",
          harnessId: "claude-code",
          physicalState: "running",
          logicalState: "idle",
          lastSeq: 12,
        }),
      ),
    ).toEqual({
      type: "ready",
      sessionId: "session-1",
      generation: "thread-generation-3",
      harnessId: "claude-code",
      physicalState: "running",
      logicalState: "idle",
      lastSeq: 12,
    });

    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "state",
          physicalState: "running",
          logicalState: "waiting_input",
          threadStatus: "requires_action",
          harnessId: "opencode",
        }),
      ),
    ).toEqual({
      type: "state",
      physicalState: "running",
      logicalState: "waiting_input",
      threadStatus: "requires_action",
      harnessId: "opencode",
    });

    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "error",
          code: "prompt_rejected",
          message: "coding agent is busy",
          retryable: false,
          requestId: "request-1",
        }),
      ),
    ).toEqual({
      type: "error",
      code: "prompt_rejected",
      message: "coding agent is busy",
      retryable: false,
      requestId: "request-1",
    });
  });

  test("rejects legacy snake_case lifecycle and output fields", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "ready",
          session_id: "session-1",
          generation: "thread-generation-3",
          harness_id: "claude-code",
          physical_state: "running",
          logical_state: "idle",
          last_seq: 12,
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "ready",
          sessionId: "session-1",
          session_id: "retired-session",
          generation: "thread-generation-3",
          harnessId: "codex",
          physicalState: "running",
          logicalState: "idle",
          lastSeq: 12,
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "output",
          seq: 1,
          data_base64: btoa("legacy"),
          replay: false,
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "output",
          seq: 1,
          dataBase64: btoa("canonical"),
          data_base64: btoa("retired"),
          replay: false,
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "output",
          seq: 1,
          data: "legacy plaintext",
          replay: false,
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "prompt_accepted",
          request_id: "legacy-request",
        }),
      ),
    ).toBeNull();
  });

  test("rejects the removed claude harness alias while allowing omission", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "state",
          physicalState: "running",
          logicalState: "idle",
          harnessId: "claude",
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "state",
          physicalState: "running",
          logicalState: "idle",
        }),
      ),
    ).toEqual({
      type: "state",
      physicalState: "running",
      logicalState: "idle",
    });
  });

  test("rejects malformed and unsafe frames", () => {
    expect(parseTerminalServerFrame("not json")).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ type: "output", seq: -1, data: "oops" }),
      ),
    ).toBeNull();
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "ready",
          generation: "thread-generation-1",
          physicalState: "unknown",
          logicalState: "idle",
          lastSeq: 0,
        }),
      ),
    ).toBeNull();
  });

  test("decodes canonical base64 terminal bytes without UTF-8 coercion", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "output",
          seq: 2,
          dataBase64: "/5s=",
          replay: true,
        }),
      ),
    ).toEqual({
      type: "output",
      seq: 2,
      data: new Uint8Array([255, 155]),
      replay: true,
    });
  });

  test("parses local-api's empty replay-gap reset marker", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "reset",
          seq: 4_194_304,
          dataBase64: "",
        }),
      ),
    ).toEqual({
      type: "reset",
      seq: 4_194_304,
      data: new Uint8Array(),
    });
    expect(
      parseTerminalServerFrame(
        JSON.stringify({
          type: "error",
          code: "oversized",
          message: "x".repeat(256 * 1024),
          retryable: false,
        }),
      ),
    ).toBeNull();
  });

  test("parses replay output chunks after a gap marker", () => {
    const frame = parseTerminalServerFrame(
      JSON.stringify({
        type: "output",
        seq: 4_194_307,
        dataBase64: btoa("new"),
        replay: true,
      }),
    );

    expect(frame).toEqual({
      type: "output",
      seq: 4_194_307,
      data: new TextEncoder().encode("new"),
      replay: true,
    });
  });

  test("accepts only terminal harness identifiers", () => {
    expect(toTerminalHarnessId("claude-code")).toBe("claude-code");
    expect(toTerminalHarnessId("codex")).toBe("codex");
    expect(toTerminalHarnessId("opencode")).toBe("opencode");
    expect(toTerminalHarnessId("claude")).toBeNull();
    expect(toTerminalHarnessId("decopilot")).toBeNull();
  });

  test("maps physical and logical lifecycle axes to sidebar status", () => {
    expect(threadStatusFromTerminalLifecycle("starting", "idle")).toBe(
      "in_progress",
    );
    expect(threadStatusFromTerminalLifecycle("running", "working")).toBe(
      "in_progress",
    );
    expect(threadStatusFromTerminalLifecycle("running", "waiting_input")).toBe(
      "requires_action",
    );
    expect(threadStatusFromTerminalLifecycle("running", "idle")).toBe(
      "completed",
    );
    expect(threadStatusFromTerminalLifecycle("exited", "interrupted")).toBe(
      "failed",
    );
  });

  test("classifies requested and natural process exits like local-api", () => {
    expect(
      terminalLifecycleAfterExit(
        { type: "exit", code: 0, expected: false },
        "completed",
      ),
    ).toEqual({ logicalState: "completed", threadStatus: "completed" });
    expect(
      terminalLifecycleAfterExit(
        { type: "exit", code: 0, expected: false },
        "working",
      ),
    ).toEqual({ logicalState: "failed", threadStatus: "failed" });
    expect(
      terminalLifecycleAfterExit(
        { type: "exit", code: 0, expected: true },
        "idle",
      ),
    ).toEqual({ logicalState: "interrupted", threadStatus: "failed" });
  });

  test("resets replay when an attach lands on a replacement session", () => {
    const ready = {
      type: "ready" as const,
      sessionId: "session-2",
      generation: "thread-generation-2",
      harnessId: "codex" as const,
      physicalState: "running" as const,
      logicalState: "idle" as const,
      lastSeq: 10,
    };

    expect(shouldResetTerminalReplay("session-1", 10, ready)).toBeTrue();
    expect(shouldResetTerminalReplay("session-2", 11, ready)).toBeTrue();
    expect(shouldResetTerminalReplay("session-2", 10, ready)).toBeFalse();
  });

  test("builds an encoded same-origin websocket URL", () => {
    expect(
      terminalWebSocketUrl(
        { protocol: "https:", host: "studio.test" },
        "my org",
        "thread/one",
      ),
    ).toBe("wss://studio.test/api/my%20org/threads/thread%2Fone/terminal/ws");
  });

  test("bounds dimensions and renderer replay", () => {
    expect(normalizeTerminalDimensions({ rows: 0, cols: 10_000 })).toEqual({
      rows: 2,
      cols: 1_000,
    });
    expect(
      appendTerminalReplay(
        [
          {
            kind: "output",
            seq: 1,
            data: new TextEncoder().encode("old"),
            allowCapabilityReplies: false,
          },
          {
            kind: "output",
            seq: 2,
            data: new TextEncoder().encode("keep"),
            allowCapabilityReplies: false,
          },
        ],
        {
          kind: "output",
          seq: 3,
          data: new TextEncoder().encode("new"),
          allowCapabilityReplies: false,
        },
        7,
      ),
    ).toEqual([
      {
        kind: "output",
        seq: 2,
        data: new TextEncoder().encode("keep"),
        allowCapabilityReplies: false,
      },
      {
        kind: "output",
        seq: 3,
        data: new TextEncoder().encode("new"),
        allowCapabilityReplies: false,
      },
    ]);
    expect(
      appendTerminalReplay(
        [
          {
            kind: "output",
            seq: 3,
            data: new TextEncoder().encode("old"),
            allowCapabilityReplies: false,
          },
        ],
        {
          kind: "reset",
          seq: 4,
          data: new TextEncoder().encode("fresh"),
          allowCapabilityReplies: false,
        },
        20,
      ),
    ).toEqual([
      {
        kind: "reset",
        seq: 4,
        data: new TextEncoder().encode("fresh"),
        allowCapabilityReplies: false,
      },
    ]);
  });

  test("chunks large terminal paste without splitting UTF-8 characters", () => {
    const input = `${"\0".repeat(40_000)}${"🙂".repeat(10_000)}`;
    const chunks = chunkTerminalInput(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
        32 * 1024,
      );
      expect(
        new TextEncoder().encode(JSON.stringify({ type: "input", data: chunk }))
          .byteLength,
      ).toBeLessThan(256 * 1024);
    }
  });

  test("bounds prompts by raw and serialized local-api limits", () => {
    const maximumPromptBytes = 64 * 1024 - 13;
    expect(terminalPromptFitsWire("ship it", "request-1", "codex")).toBeTrue();
    expect(
      terminalPromptFitsWire("ship it", "request-1", "opencode"),
    ).toBeTrue();
    expect(
      terminalPromptFitsWire(
        "a".repeat(maximumPromptBytes),
        "request-1",
        "codex",
      ),
    ).toBeTrue();
    expect(
      terminalPromptFitsWire(
        "a".repeat(maximumPromptBytes + 1),
        "request-1",
        "codex",
      ),
    ).toBeFalse();
    expect(
      terminalPromptFitsWire(
        "\0".repeat(maximumPromptBytes),
        "request-1",
        "claude-code",
      ),
    ).toBeFalse();
  });
});
