import { describe, it, expect } from "bun:test";
import { fixtures, verifyRequest } from "../links/protocol";
import { parseSSEStream, remoteDispatch } from "./remote-dispatch";
import type { HarnessStreamInput } from "./types";

function eventsToSSEBody(events: readonly unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function bodyFromString(s: string): ReadableStream<Uint8Array> {
  return new Response(s).body!;
}

function makeInput(
  overrides: Partial<HarnessStreamInput> = {},
): HarnessStreamInput {
  const ctrl = new AbortController();
  return {
    threadId: "thr-1",
    runId: "run-1",
    taskId: "thr-1",
    messages: [],
    models: {
      credentialId: "cred-1",
      thinking: { id: "claude-code:opus", title: "Opus" },
    },
    mcp: {
      url: "https://mesh.example.com/mcp/virtual-mcp/agent-1",
      headers: { Authorization: "Bearer mcp-token" },
    },
    mode: "default",
    temperature: 0.7,
    toolApprovalLevel: "auto",
    user: { id: "user-1", email: "u@example.com" },
    organizationId: "org-1",
    virtualMcp: {
      id: "agent-1",
    } as unknown as HarnessStreamInput["virtualMcp"],
    agent: { id: "agent-1" },
    signal: ctrl.signal,
    ...overrides,
  } as HarnessStreamInput;
}

describe("parseSSEStream", () => {
  it("yields UIMessageChunks from a happy-path stream", async () => {
    const sseBody = eventsToSSEBody(fixtures.FIXTURE_SSE_HAPPY_PATH);
    const out: unknown[] = [];
    for await (const chunk of parseSSEStream(bodyFromString(sseBody))) {
      out.push(chunk);
    }
    // happy-path fixture has 4 ui-message-chunk events + 1 done.
    // parser yields only the chunks and returns on `done`.
    expect(out.length).toBe(4);
  });

  it("throws on an error event after yielding earlier chunks", async () => {
    const sseBody = eventsToSSEBody(fixtures.FIXTURE_SSE_HARNESS_CRASH);
    const out: unknown[] = [];
    let caught: Error | null = null;
    try {
      for await (const chunk of parseSSEStream(bodyFromString(sseBody))) {
        out.push(chunk);
      }
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("harness_crashed");
    // the start chunk arrived before the error
    expect(out.length).toBe(1);
  });

  it("tolerates events split across read chunks", async () => {
    // Manually construct a stream that emits the SSE bytes in two
    // chunks, splitting in the middle of an event. The parser must
    // buffer until the next \n\n boundary.
    const full = eventsToSSEBody(fixtures.FIXTURE_SSE_HAPPY_PATH);
    const half = Math.floor(full.length / 2);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(full.slice(0, half)));
        controller.enqueue(enc.encode(full.slice(half)));
        controller.close();
      },
    });
    const out: unknown[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      out.push(chunk);
    }
    expect(out.length).toBe(4);
  });

  it("ignores unknown event types (forward-compat)", async () => {
    const body = [
      `data: ${JSON.stringify({ type: "ping" })}\n\n`,
      `data: ${JSON.stringify({ type: "ui-message-chunk", chunk: { type: "start", id: "m1" } })}\n\n`,
      `data: ${JSON.stringify({ type: "done" })}\n\n`,
    ].join("");
    const out: unknown[] = [];
    for await (const chunk of parseSSEStream(bodyFromString(body))) {
      out.push(chunk);
    }
    expect(out.length).toBe(1);
  });
});

describe("remoteDispatch", () => {
  const link = {
    tunnelUrl: "https://link-x.example.com",
    linkSecret: "secret-for-tests-padding-padding-padding",
  };

  it("posts to the right URL with a valid HMAC signature", async () => {
    let captured: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    } | null = null;

    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers: Record<string, string> = {};
      const hdrs = new Headers(init?.headers ?? {});
      hdrs.forEach((v, k) => {
        headers[k] = v;
      });
      captured = {
        url: typeof url === "string" ? url : url.toString(),
        method: init?.method ?? "GET",
        headers,
        body: (init?.body as string) ?? "",
      };
      // Reply with the happy-path SSE body.
      return new Response(eventsToSSEBody(fixtures.FIXTURE_SSE_HAPPY_PATH), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const input = makeInput({ runId: "run-abc" });
    // Per-daemon tunnel URL — dispatch-run resolves this via `ensureSandbox`
    // (through the desktop sandbox provider's `POST /api/sandboxes`), and
    // the cluster talks to the daemon directly with no link hop.
    const sandboxApiUrl = `https://${input.runId}.deco.host`;
    const out: unknown[] = [];
    for await (const chunk of remoteDispatch(
      "claude-code",
      input,
      link,
      sandboxApiUrl,
      { fetchImpl },
    )) {
      out.push(chunk);
    }
    expect(out.length).toBe(4);

    expect(captured).not.toBeNull();
    const cap = captured!;
    const expectedPath = "/_sandbox/dispatch";
    expect(cap.url).toBe(`${sandboxApiUrl}${expectedPath}`);
    expect(cap.method).toBe("POST");

    // Verify HMAC headers round-trip through verifyRequest with the
    // same secret. This is the same check the daemon does on the
    // receiving end, so a green test here proves the wire contract.
    const v = verifyRequest({
      secret: link.linkSecret,
      method: cap.method,
      path: expectedPath,
      body: cap.body,
      headers: cap.headers,
      seenNonce: () => false,
    });
    expect(v.valid).toBe(true);

    // Body shape: harnessId + wireInput; the AbortSignal must be
    // stripped (otherwise JSON.stringify would have crashed before we
    // ever got here).
    const parsedBody = JSON.parse(cap.body) as {
      harnessId: string;
      input: Record<string, unknown>;
    };
    expect(parsedBody.harnessId).toBe("claude-code");
    expect(parsedBody.input.runId).toBe("run-abc");
    expect("signal" in parsedBody.input).toBe(false);
    expect("processLocal" in parsedBody.input).toBe(false);

    // No Authorization header — HMAC alone authenticates (Task 5.1
    // decision; bearer would leak the signing key in HTTP logs).
    expect(cap.headers["authorization"]).toBeUndefined();
  });

  it("fires a HMAC-signed DELETE on consumer abort", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
    }> = [];

    // The dispatch fetch returns a stream we never drain past the
    // first chunk; we abort the consumer signal and exit the loop.
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers: Record<string, string> = {};
      const hdrs = new Headers(init?.headers ?? {});
      hdrs.forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({
        url: typeof url === "string" ? url : url.toString(),
        method: init?.method ?? "GET",
        headers,
      });
      if (init?.method === "POST") {
        // SSE body with multiple chunks; the consumer will abort
        // after the first one.
        const sseBody = eventsToSSEBody(fixtures.FIXTURE_SSE_HAPPY_PATH);
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      // DELETE
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const ctrl = new AbortController();
    const input = makeInput({ runId: "run-xyz", signal: ctrl.signal });
    const sandboxApiUrl = `https://${input.runId}.deco.host`;
    const out: unknown[] = [];
    let firstChunkSeen = false;
    try {
      for await (const chunk of remoteDispatch(
        "codex",
        input,
        link,
        sandboxApiUrl,
        { fetchImpl },
      )) {
        out.push(chunk);
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          ctrl.abort();
          break;
        }
      }
    } catch {
      // The DELETE fires from `finally`, so we tolerate any error
      // raised by abort-during-read here.
    }

    // Give the unawaited cancel-fetch a tick to land in `calls`.
    await new Promise((r) => setTimeout(r, 0));

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    const expectedCancelPath = "/_sandbox/runs/run-xyz";
    expect(deleteCall!.url).toBe(`${sandboxApiUrl}${expectedCancelPath}`);

    // HMAC signature on the DELETE verifies against the same secret.
    const v = verifyRequest({
      secret: link.linkSecret,
      method: "DELETE",
      path: expectedCancelPath,
      body: "",
      headers: deleteCall!.headers,
      seenNonce: () => false,
    });
    expect(v.valid).toBe(true);
  });

  it("throws when the daemon returns a non-2xx response", async () => {
    const fetchImpl = (async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      return new Response("nope", { status: 502, statusText: "Bad Gateway" });
    }) as typeof fetch;

    const input = makeInput();
    const sandboxApiUrl = `https://${input.runId}.deco.host`;
    let caught: Error | null = null;
    try {
      for await (const _ of remoteDispatch(
        "claude-code",
        input,
        link,
        sandboxApiUrl,
        { fetchImpl },
      )) {
        // consume
      }
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("502");
  });
});
