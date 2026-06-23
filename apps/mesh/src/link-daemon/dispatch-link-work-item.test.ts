import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../links/link-work-item";
import { dispatchLinkWorkItem } from "./dispatch-link-work-item";
import { openInMemoryOutbox } from "./outbox";
import type {
  DesktopSandboxProvider,
  EnsureSandboxInput,
} from "./user-desktop-provider";

const workItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  runId: "run-1",
  threadId: "thread-1",
  orgId: "org-1",
  userId: "user-1",
  runFenceToken: "fence-1",
  orgSlug: "acme",
  harnessInput: {
    agent: { id: "agent-1" },
    mcp: { expiresAt: Date.now() + 60_000 },
  },
  ...overrides,
});

function provider(calls: EnsureSandboxInput[]): DesktopSandboxProvider {
  return {
    ensureSandbox: async (input) => {
      calls.push(input);
      return {
        sandboxApiUrl: "http://127.0.0.1:9999",
        previewUrl: "http://127.0.0.1:9999",
        port: 9999,
      };
    },
    proxyPort: () => null,
    getDaemonToken: () => "daemon-token",
    hasHandle: () => false,
    recordHit: () => {},
    acquireDispatch: () => () => {},
    listSandboxes: () => [],
    deleteSandbox: async () => {},
    shutdown: async () => {},
  };
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function dispatchFetch(capturedUrls: string[]): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    capturedUrls.push(url);
    if (url.includes("/_sandbox/dispatch")) {
      return new Response(stream('data: {"type":"done"}\n\n'), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.includes("/links/runs/")) {
      if (!(init?.body instanceof ReadableStream)) {
        return Response.json({ ok: true, lastSeq: 2 });
      }
      const reader = init.body.getReader();
      let lastSeq = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      buffer += decoder.decode();
      for (const line of buffer.trim().split("\n")) {
        if (!line) continue;
        const parsed = JSON.parse(line) as { seq?: number };
        lastSeq = parsed.seq ?? lastSeq;
      }
      return Response.json({ ok: true, lastSeq });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("dispatchLinkWorkItem", () => {
  test("passes full sandbox config to ensureSandbox and relays chunks", async () => {
    const ensureCalls: EnsureSandboxInput[] = [];
    const urls: string[] = [];
    const item = workItem({
      sandbox: {
        handle: "agent-agent-1-main",
        repo: {
          cloneUrl: "https://example.com/repo.git",
          branch: "main",
        },
        workload: {
          runtime: "bun",
          packageManager: "bun",
        },
        offloadAllowedHosts: ["storage.example.com"],
      },
    });

    await dispatchLinkWorkItem(
      {
        clusterBaseUrl: "https://cluster.example",
        getAccessToken: async () => "cluster-token",
        provider: provider(ensureCalls),
        fetchImpl: dispatchFetch(urls),
        outbox: openInMemoryOutbox(),
        getNatsConnection: () =>
          ({}) as unknown as import("@nats-io/nats-core").NatsConnection,
      },
      new AbortController().signal,
      item,
    );

    expect(ensureCalls[0]).toMatchObject({
      handle: "agent-agent-1-main",
      repo: { cloneUrl: "https://example.com/repo.git", branch: "main" },
      workload: { runtime: "bun", packageManager: "bun" },
      offloadAllowedHosts: ["storage.example.com"],
    });
    expect(urls).toContain("http://127.0.0.1:9999/_sandbox/dispatch");
    expect(urls).toContain(
      "https://cluster.example/api/acme/links/runs/run-1/chunks",
    );
  });

  test("expired work items relay a terminal failure without starting sandbox", async () => {
    const ensureCalls: EnsureSandboxInput[] = [];
    const urls: string[] = [];

    await dispatchLinkWorkItem(
      {
        clusterBaseUrl: "https://cluster.example",
        getAccessToken: async () => "cluster-token",
        provider: provider(ensureCalls),
        fetchImpl: dispatchFetch(urls),
        outbox: openInMemoryOutbox(),
        getNatsConnection: () =>
          ({}) as unknown as import("@nats-io/nats-core").NatsConnection,
      },
      new AbortController().signal,
      workItem({
        harnessInput: {
          agent: { id: "agent-1" },
          mcp: { expiresAt: Date.now() - 1 },
        },
      }),
    );

    expect(ensureCalls).toHaveLength(0);
    expect(urls).toEqual([
      "https://cluster.example/api/acme/links/runs/run-1/chunks",
    ]);
  });
});
