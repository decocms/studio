import { afterEach, describe, expect, test } from "bun:test";
import { AsyncResearchTerminalError } from "../types";
import {
  isInteractionsOnlyModel,
  pollInteraction,
  submitInteraction,
} from "./gemini-interactions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Mock fetch with a queue of canned responses. Each call dequeues one.
 * Returns the captured request URLs/methods so tests can assert call sequence.
 */
function queueFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  const queue = [...responses];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
    });
    const next = queue.shift();
    if (!next) throw new Error("queueFetch: out of responses");
    return next();
  }) as unknown as typeof fetch;
  return calls;
}

describe("isInteractionsOnlyModel", () => {
  test("matches every deep-research variant", () => {
    expect(isInteractionsOnlyModel("deep-research-preview-04-2026")).toBe(true);
    expect(isInteractionsOnlyModel("deep-research-max-preview-04-2026")).toBe(
      true,
    );
    expect(isInteractionsOnlyModel("deep-research-pro-preview-12-2025")).toBe(
      true,
    );
  });
  test("rejects regular models", () => {
    expect(isInteractionsOnlyModel("gemini-2.5-flash")).toBe(false);
    expect(isInteractionsOnlyModel("gemini-3-flash-preview")).toBe(false);
    expect(isInteractionsOnlyModel("imagen-4")).toBe(false);
  });
});

describe("submitInteraction", () => {
  test("POSTs and returns the interaction id", async () => {
    const calls = queueFetch([() => jsonResponse({ id: "i_abc" })]);

    const result = await submitInteraction({
      apiKey: "k",
      agent: "deep-research-preview-04-2026",
      query: "hello",
    });

    expect(result.interactionId).toBe("i_abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toMatch(/\/v1beta\/interactions$/);
  });

  test("throws on non-2xx with response body", async () => {
    queueFetch([() => new Response("forbidden: bad key", { status: 403 })]);
    await expect(
      submitInteraction({ apiKey: "k", agent: "a", query: "q" }),
    ).rejects.toThrow(/403.*forbidden/);
  });

  test("throws when response is missing id", async () => {
    queueFetch([() => jsonResponse({})]);
    await expect(
      submitInteraction({ apiKey: "k", agent: "a", query: "q" }),
    ).rejects.toThrow(/missing id/);
  });
});

describe("pollInteraction", () => {
  test("polls until completed and returns final text + citations + usage", async () => {
    const progress: string[] = [];
    queueFetch([
      () =>
        jsonResponse({
          status: "in_progress",
          outputs: [{ type: "thought_summary", text: "Researching…" }],
        }),
      () =>
        jsonResponse({
          status: "completed",
          outputs: [
            { type: "thought_summary", text: "Researching…" },
            {
              type: "text",
              text: "The answer is 42.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com",
                  title: "Example",
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    ]);

    const result = await pollInteraction({
      apiKey: "k",
      interactionId: "i_1",
      pollIntervalMs: 0,
      onProgress: (t) => progress.push(t),
    });

    expect(result.text).toBe("The answer is 42.");
    expect(result.citations).toEqual([
      { url: "https://example.com", title: "Example" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(progress.at(-1)).toContain("The answer is 42.");
    expect(progress.at(-1)).toContain("Researching");
  });

  test("throws AsyncResearchTerminalError on failed status", async () => {
    queueFetch([
      () => jsonResponse({ status: "failed", error: "model overloaded" }),
    ]);

    await expect(
      pollInteraction({
        apiKey: "k",
        interactionId: "i_2",
        pollIntervalMs: 0,
      }),
    ).rejects.toBeInstanceOf(AsyncResearchTerminalError);
  });

  test("throws AsyncResearchTerminalError on cancelled status", async () => {
    queueFetch([() => jsonResponse({ status: "cancelled" })]);
    await expect(
      pollInteraction({
        apiKey: "k",
        interactionId: "i_3",
        pollIntervalMs: 0,
      }),
    ).rejects.toBeInstanceOf(AsyncResearchTerminalError);
  });

  test("transient HTTP errors throw plain Error (not terminal)", async () => {
    queueFetch([() => new Response("upstream timeout", { status: 502 })]);
    let caught: unknown;
    try {
      await pollInteraction({
        apiKey: "k",
        interactionId: "i_2b",
        pollIntervalMs: 0,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AsyncResearchTerminalError);
  });

  test("dedupes citations across outputs by url", async () => {
    queueFetch([
      () =>
        jsonResponse({
          status: "completed",
          outputs: [
            {
              type: "text",
              text: "a",
              annotations: [
                { type: "url_citation", url: "https://x", title: "X" },
              ],
            },
            {
              type: "text",
              text: "b",
              annotations: [
                { type: "url_citation", url: "https://x", title: "X dup" },
                { type: "url_citation", url: "https://y", title: "Y" },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    ]);

    const result = await pollInteraction({
      apiKey: "k",
      interactionId: "i_4",
      pollIntervalMs: 0,
    });

    expect(result.citations.map((c) => c.url)).toEqual([
      "https://x",
      "https://y",
    ]);
  });

  test("aborts before issuing a poll when signal is already aborted", async () => {
    const calls = queueFetch([]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      pollInteraction({
        apiKey: "k",
        interactionId: "i_5",
        abortSignal: ac.signal,
        pollIntervalMs: 0,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  test("rewrites vertexaisearch redirect URLs to the underlying source", async () => {
    queueFetch([
      // poll → completed
      () =>
        jsonResponse({
          status: "completed",
          outputs: [
            {
              type: "text",
              text: "report",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA",
                  title: "vertexaisearch.cloud.go…",
                },
                {
                  type: "url_citation",
                  url: "https://example.com/already-direct",
                  title: "Direct",
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      // HEAD on the redirect URL → 302 with Location
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://nytimes.com/article" },
        }),
    ]);

    const result = await pollInteraction({
      apiKey: "k",
      interactionId: "i_redir",
      pollIntervalMs: 0,
    });

    expect(result.citations).toEqual([
      { url: "https://nytimes.com/article", title: "vertexaisearch.cloud.go…" },
      { url: "https://example.com/already-direct", title: "Direct" },
    ]);
  });

  test("keeps original URL when redirect resolution fails", async () => {
    queueFetch([
      () =>
        jsonResponse({
          status: "completed",
          outputs: [
            {
              type: "text",
              text: "x",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB",
                  title: "T",
                },
              ],
            },
          ],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      // HEAD returns 200 without a Location header — keep original.
      () => new Response(null, { status: 200 }),
    ]);
    const result = await pollInteraction({
      apiKey: "k",
      interactionId: "i_keep",
      pollIntervalMs: 0,
    });
    expect(result.citations[0]?.url).toMatch(/grounding-api-redirect\/BBB/);
  });

  test("URL-encodes the interaction id", async () => {
    const calls = queueFetch([
      () => jsonResponse({ status: "completed", outputs: [] }),
    ]);
    await pollInteraction({
      apiKey: "k",
      interactionId: "interactions/i_with/slash",
      pollIntervalMs: 0,
    });
    expect(calls[0]?.url).toContain(
      encodeURIComponent("interactions/i_with/slash"),
    );
  });
});
