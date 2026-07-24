import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../links/link-work-item";
import type { RelayLine } from "../links/protocol/relay";
import { dispatchLinkWorkItem } from "./dispatch-link-work-item";
import { openInMemoryOutbox } from "./outbox";
import type {
  DesktopSandboxProvider,
  EnsureSandboxInput,
} from "./user-desktop-provider";

/** A throwaway NatsConnection — the fake publisher means it's never used. */
const FAKE_NC = {} as unknown as import("@nats-io/nats-core").NatsConnection;

type RecordedLine = { runId: string; fenceToken: string; line: RelayLine };
type RecordedDone = { runId: string; fenceToken: string; finalSeq: number };

/** Records every published relay line + done, standing in for JetStream. */
function fakePublisher() {
  const lines: RecordedLine[] = [];
  const dones: RecordedDone[] = [];
  const publisher = {
    publishLine: async (i: RecordedLine) => {
      lines.push(i);
      return (i.line.event.type === "done" ? "terminal" : "published") as
        | "published"
        | "terminal";
    },
    publishDone: async (i: RecordedDone) => {
      dones.push(i);
    },
  };
  return { publisher, lines, dones };
}

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
  return (async (input) => {
    const url = String(input);
    capturedUrls.push(url);
    if (url.includes("/_sandbox/dispatch")) {
      return new Response(stream('data: {"type":"done"}\n\n'), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // The chunk relay no longer fetches — it publishes to NATS. Any HTTP hit to
    // the cluster /chunks route here would be a regression.
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("dispatchLinkWorkItem", () => {
  test("passes full sandbox config to ensureSandbox and relays chunks to NATS", async () => {
    const ensureCalls: EnsureSandboxInput[] = [];
    const urls: string[] = [];
    const fp = fakePublisher();
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
        getNatsConnection: () => FAKE_NC,
        relayPublisher: fp.publisher,
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
    // Sandbox dispatch went over HTTP; the relay went to NATS, not /chunks.
    expect(urls).toContain("http://127.0.0.1:9999/_sandbox/dispatch");
    expect(urls).not.toContain(
      "https://cluster.example/api/acme/links/runs/run-1/chunks",
    );
    // The sandbox SSE was just a terminal `done`, so the relay published a
    // single done relay line (no content chunks → no publishDone marker).
    expect(fp.lines.map((l) => l.line.event)).toEqual([{ type: "done" }]);
    for (const l of fp.lines) {
      expect(l.runId).toBe("run-1");
      expect(l.fenceToken).toBe("fence-1");
    }
  });

  test("expired work items relay a terminal failure to NATS without starting sandbox", async () => {
    const ensureCalls: EnsureSandboxInput[] = [];
    const urls: string[] = [];
    const fp = fakePublisher();

    await dispatchLinkWorkItem(
      {
        clusterBaseUrl: "https://cluster.example",
        getAccessToken: async () => "cluster-token",
        provider: provider(ensureCalls),
        fetchImpl: dispatchFetch(urls),
        outbox: openInMemoryOutbox(),
        getNatsConnection: () => FAKE_NC,
        relayPublisher: fp.publisher,
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
    // No HTTP at all — the failure was published directly to NATS.
    expect(urls).toEqual([]);
    expect(fp.lines).toHaveLength(1);
    expect(fp.lines[0]!.line.seq).toBe(1);
    expect(fp.lines[0]!.line.event).toEqual({
      type: "error",
      code: "work_item_expired",
      message:
        "work item credentials expired before the daemon claimed it — send the message again",
    });
    expect(fp.dones).toEqual([
      { runId: "run-1", fenceToken: "fence-1", finalSeq: 1 },
    ]);
  });
});
