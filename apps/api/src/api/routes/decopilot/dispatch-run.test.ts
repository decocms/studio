import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UIMessageChunk } from "ai";
import {
  isRunSuperseded,
  RunSupersededError,
} from "@/harnesses/sandbox-dispatch-client";
import {
  assertHostedDispatchHarness,
  assertSinglePersistedRequestMessage,
  buildAgentSandboxUiStream,
  buildDurableDispatchInput,
} from "./dispatch-run";
import type { ChatMessage } from "./types";

describe("assertSinglePersistedRequestMessage", () => {
  test("returns the persisted user message matching the durable message id", () => {
    const message = {
      id: "msg-user",
      role: "user",
      parts: [{ type: "text", text: "already materialized" }],
    } as ChatMessage;

    expect(assertSinglePersistedRequestMessage([message], "msg-user")).toBe(
      message,
    );
  });

  test("returns a persisted assistant continuation matching the durable message id", () => {
    const message = {
      id: "msg-assistant",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;

    expect(
      assertSinglePersistedRequestMessage([message], "msg-assistant"),
    ).toBe(message);
  });

  test("throws when the durable message id is missing from folded history", () => {
    expect(() => assertSinglePersistedRequestMessage([], "missing")).toThrow(
      "Persisted request message missing for messageId=missing",
    );
  });

  test("throws when the durable message id points at a system message", () => {
    expect(() =>
      assertSinglePersistedRequestMessage(
        [
          {
            id: "system-msg",
            role: "system",
            parts: [{ type: "text", text: "hello" }],
          } as ChatMessage,
        ],
        "system-msg",
      ),
    ).toThrow("Persisted message system-msg has role=system");
  });
});

describe("buildDurableDispatchInput", () => {
  test("drops raw messages and carries only submit-time ids, fence, and frozen config", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [
          {
            id: "msg-user",
            role: "user",
            parts: [{ type: "text", text: "secret prompt" }],
          } as ChatMessage,
        ],
        models: {
          credentialId: "cred-1",
          thinking: { id: "model-1" },
        },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
        windowSize: 50,
        branch: "main",
      },
      {
        messageId: "msg-user",
        runFenceToken: "fence-1",
        branch: "main",
      },
    );

    expect("messages" in durable).toBe(false);
    expect(JSON.stringify(durable)).not.toContain("secret prompt");
    expect(durable).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      taskId: "thread-1",
      messageId: "msg-user",
      runFenceToken: "fence-1",
      harnessId: "decopilot",
      branch: "main",
    });
  });

  test("carries runMetadata through the frozen snapshot", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [],
        models: { credentialId: "cred-1", thinking: { id: "model-1" } },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
        runMetadata: { org_id: "org-xyz", url: "shop.com" },
      },
      { messageId: "msg-1", runFenceToken: "fence-1" },
    );
    expect(durable.runMetadata).toEqual({ org_id: "org-xyz", url: "shop.com" });
  });

  test("folds the per-turn system message text into systemContext", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [
          {
            id: "sys-1",
            role: "system",
            parts: [
              { type: "text", text: "### Currently Open File\nhome/x.md" },
            ],
          } as ChatMessage,
          {
            id: "msg-user",
            role: "user",
            parts: [{ type: "text", text: "change the h1" }],
          } as ChatMessage,
        ],
        models: { credentialId: "cred-1", thinking: { id: "model-1" } },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
      },
      { messageId: "msg-user", runFenceToken: "fence-1" },
    );
    // The raw messages array is still dropped from the durable snapshot…
    expect("messages" in durable).toBe(false);
    // …but the ephemeral system context survives it (it isn't persisted as a
    // thread message, so the durable branch would otherwise lose it).
    expect(durable.systemContext).toBe("### Currently Open File\nhome/x.md");
  });

  test("omits systemContext when the turn carries no system message", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [
          {
            id: "msg-user",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          } as ChatMessage,
        ],
        models: { credentialId: "cred-1", thinking: { id: "model-1" } },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
      },
      { messageId: "msg-user", runFenceToken: "fence-1" },
    );
    expect("systemContext" in durable).toBe(false);
  });
});

describe("assertHostedDispatchHarness", () => {
  test("accepts the hosted harnesses", () => {
    expect(() => assertHostedDispatchHarness("decopilot")).not.toThrow();
    // claude-code was rejected here until it became sandbox-hosted; the
    // per-org gate for it is `prepareRun`'s flag check, not this one.
    expect(() => assertHostedDispatchHarness("claude-code")).not.toThrow();
  });

  test("rejects desktop-only, unknown and missing harnesses", () => {
    for (const harnessId of [
      null,
      undefined,
      "codex",
      "opencode",
      "future",
    ] as const) {
      expect(() => assertHostedDispatchHarness(harnessId)).toThrow(
        /hosted dispatch requires/,
      );
    }
  });
});

describe("buildAgentSandboxUiStream resume", () => {
  /** Collects what a run publishes, the way JetStream would key it. */
  function recorder() {
    const published: string[] = [];
    const done: number[] = [];
    return {
      published,
      done,
      streamBuffer: {
        publishRawChunk: async (
          runId: string,
          _chunk: unknown,
          dedup?: { fenceToken: string; seq: number },
        ) => {
          published.push(
            dedup ? `${runId}:${dedup.fenceToken}:${dedup.seq}` : `${runId}:-`,
          );
          return true;
        },
        publishDone: async (
          _runId: string,
          _fenceToken: string,
          finalSeq: number,
        ) => {
          done.push(finalSeq);
          return true;
        },
      },
    };
  }

  const chunks = (...items: UIMessageChunk[]) =>
    (async function* () {
      for (const chunk of items) yield chunk;
    })();

  const drain = async (stream: ReadableStream) => {
    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  };

  test("a fresh run numbers its chunks from 1", async () => {
    const rec = recorder();
    await drain(
      buildAgentSandboxUiStream({
        runId: "run_1",
        fenceToken: "fence_1",
        streamBuffer: rec.streamBuffer,
        chunks: chunks(
          { type: "start" } as UIMessageChunk,
          { type: "finish", finishReason: "stop" } as UIMessageChunk,
        ),
        title: {
          currentThreadTitle: null,
          threadId: "run_1",
          persistTitle: async () => {},
        },
        hooks: {},
      }),
    );
    expect(rec.published).toEqual(["run_1:fence_1:1", "run_1:fence_1:2"]);
    expect(rec.done).toEqual([2]);
  });

  test("a resumed run EXTENDS the dead attempt's log instead of restarting it", async () => {
    // This is the pod-death path: another Studio process published seqs 1..5 for
    // this same fence and then died. The projector requires a contiguous
    // sequence and drops anything at or below what it has already folded
    // (`assertContiguousAndDedup`), so restarting the counter would silently
    // discard every chunk of this attempt — including the `{done}` that
    // terminates the run, leaving the thread hung until the idle reaper.
    const rec = recorder();
    const acked: number[] = [];
    await drain(
      buildAgentSandboxUiStream({
        runId: "run_1",
        fenceToken: "fence_1",
        streamBuffer: rec.streamBuffer,
        // What a continuation actually streams: a fresh, self-contained turn.
        // Its own `start` is dropped upstream (it would re-id the message being
        // folded), but its parts still open and close normally — a continuation
        // that resumed mid-part would fail the kernel's fold outright.
        chunks: chunks(
          { type: "start-step" } as UIMessageChunk,
          { type: "text-start", id: "t2" } as UIMessageChunk,
          { type: "text-delta", id: "t2", delta: "more" } as UIMessageChunk,
          { type: "text-end", id: "t2" } as UIMessageChunk,
          { type: "finish-step" } as UIMessageChunk,
          { type: "finish", finishReason: "stop" } as UIMessageChunk,
        ),
        startSeq: 5,
        initialAckSeq: 5,
        onPublished: (seq) => {
          acked.push(seq);
        },
        title: {
          currentThreadTitle: null,
          threadId: "run_1",
          persistTitle: async () => {},
        },
        hooks: {},
      }),
    );
    expect(rec.published).toEqual([
      "run_1:fence_1:6",
      "run_1:fence_1:7",
      "run_1:fence_1:8",
      "run_1:fence_1:9",
      "run_1:fence_1:10",
      "run_1:fence_1:11",
    ]);
    // The terminal sentinel has to cover the WHOLE run, not just this attempt's
    // share of it — the projector checks it against the last seq it folded.
    expect(rec.done).toEqual([11]);
    // And the floor keeps advancing, so a THIRD attempt would pick up from 11.
    expect(acked).toEqual([6, 7, 8, 9, 10, 11]);
  });
});

describe("stream onError takeover guard", () => {
  test("checks for a takeover before settling the thread as failed", () => {
    // Source-text assertion, same technique as
    // hosted-harness-workflow.test.ts: the real `onError` closure can't run
    // without a live stream, so this proves the guard sits BEFORE the
    // failed-FINISH (after it, a takeover would still settle a live run).
    const src = readFileSync(join(import.meta.dir, "dispatch-run.ts"), "utf8");
    const hook = src.indexOf("onError: (error) => {");
    expect(hook).toBeGreaterThan(-1);
    const body = src.slice(hook);
    const guard = body.indexOf("isRunSuperseded(error)");
    const settle = body.indexOf('threadStatus: "failed"');
    expect(guard).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(guard);
  });

  test("a takeover error survives the DBOS journal round trip", () => {
    // The guard reads an own-enumerable marker, not `instanceof`, because DBOS
    // reconstructs a plain Error on replay. A structured clone stands in.
    const takeover = new RunSupersededError("a newer dispatch took over");
    const replayed = Object.assign(new Error(takeover.message), {
      superseded: (takeover as unknown as { superseded: boolean }).superseded,
    });
    expect(isRunSuperseded(takeover)).toBe(true);
    expect(isRunSuperseded(replayed)).toBe(true);
    expect(isRunSuperseded(new Error("boom"))).toBe(false);
  });
});
