import { describe, expect, it, spyOn, test } from "bun:test";
import {
  buildNatsConnectOptions,
  connectNats,
  connectToClusterTunnel,
  createNatsAuthenticator,
  createTunnelCommandFetch,
  createTunnelSessionSource,
  fetchLinkSession,
  isRetriableSessionError,
  LinkSessionRequestError,
  sessionRenewDelayMs,
  type ClusterConnectionTunnelInput,
} from "./cluster-connection-tunnel";
import type { ConnectionOptions, NatsConnection } from "@nats-io/nats-core";
import { encodeSubjectToken } from "@decocms/tunnel/subject";
import type { ControlHandler } from "./control-handler";
import { openInMemoryOutbox } from "./outbox";
import type { DesktopSandboxProvider } from "./user-desktop-provider";
import type { LinkSessionResponse } from "../links/link-session";

const provider: DesktopSandboxProvider = {
  ensureSandbox: async () => ({
    sandboxApiUrl: "http://127.0.0.1:9999",
    previewUrl: "http://127.0.0.1:9999",
    port: 9999,
  }),
  proxyPort: () => null,
  getDaemonToken: () => null,
  hasHandle: () => false,
  recordHit: () => {},
  acquireDispatch: () => () => {},
  listSandboxes: () => [],
  deleteSandbox: async () => {},
  shutdown: async () => {},
};

const sessionWithoutAuth: LinkSessionResponse = {
  connection: {
    urls: ["nats://127.0.0.1:4222"],
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  tunnelHostname: "user-test.link",
};

const controlHandler: ControlHandler = {
  handle: async () => ({ status: 204 }),
  handleStream: async function* () {},
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeBaseTunnelInput(
  overrides: Partial<ClusterConnectionTunnelInput> = {},
): ClusterConnectionTunnelInput {
  return {
    clusterBaseUrl: "https://cluster.example",
    getAccessToken: async () => "access-token",
    provider,
    outbox: openInMemoryOutbox(),
    controlHandler,
    capabilities: ["decopilot-sandbox"],
    machineId: "machine-1",
    cliVersion: "1.2.3",
    previewPort: 4000,
    ...overrides,
  };
}

async function waitForAbortSleep(
  _ms: number,
  options?: { signal?: AbortSignal },
): Promise<void> {
  await new Promise<void>((resolve) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("fetchLinkSession", () => {
  it("posts daemon metadata to /api/links/session", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          connection: {
            urls: ["nats://127.0.0.1:4222"],
            credentials: "creds",
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tunnelHostname: "user-test.link",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await fetchLinkSession({
      clusterBaseUrl: "https://cluster.example",
      getAccessToken: async () => "access-token",
      fetchImpl,
      capabilities: ["decopilot-sandbox"],
      machineId: "machine-1",
      cliVersion: "1.2.3",
      previewPort: 4000,
    });

    expect(capturedUrl).toBe("https://cluster.example/api/links/session");
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      capabilities: ["decopilot-sandbox"],
      machineId: "machine-1",
      cliVersion: "1.2.3",
      previewPort: 4000,
    });
  });

  it("rejects a session response without a NATS endpoint", async () => {
    const fetchImpl = (async (_url, _init) =>
      new Response(
        JSON.stringify({
          connection: {
            urls: [],
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tunnelHostname: "user-test.link",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      fetchLinkSession({
        clusterBaseUrl: "https://cluster.example",
        getAccessToken: async () => "access-token",
        fetchImpl,
      }),
    ).rejects.toThrow("invalid link session response");
  });
});

describe("isRetriableSessionError", () => {
  it("retries 5xx server errors", () => {
    expect(isRetriableSessionError(new LinkSessionRequestError(503, ""))).toBe(
      true,
    );
    expect(isRetriableSessionError(new LinkSessionRequestError(500, ""))).toBe(
      true,
    );
  });

  it("retries transport-level (non-LinkSessionRequestError) failures", () => {
    expect(isRetriableSessionError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetriableSessionError(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("does not retry auth rejections (401/403) or other 4xx", () => {
    expect(isRetriableSessionError(new LinkSessionRequestError(401, ""))).toBe(
      false,
    );
    expect(isRetriableSessionError(new LinkSessionRequestError(403, ""))).toBe(
      false,
    );
    expect(isRetriableSessionError(new LinkSessionRequestError(400, ""))).toBe(
      false,
    );
  });
});

describe("buildNatsConnectOptions", () => {
  it("allows unauthenticated NATS connection options when session has no credentials or token", () => {
    expect(buildNatsConnectOptions(sessionWithoutAuth)).toEqual({
      servers: ["nats://127.0.0.1:4222"],
      inboxPrefix: `_INBOX.${encodeSubjectToken(sessionWithoutAuth.tunnelHostname)}`,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1_000,
      reconnectJitter: 1_000,
      reconnectJitterTLS: 2_000,
    });
  });

  it("uses session URLs even when NATS environment URLs are set", () => {
    const originalNatsUrl = process.env.NATS_URL;
    const originalNatsPublicUrl = process.env.NATS_PUBLIC_URL;
    process.env.NATS_URL = "nats://internal-env.example:4222";
    process.env.NATS_PUBLIC_URL = "wss://public-env.example";

    try {
      expect(
        buildNatsConnectOptions({
          ...sessionWithoutAuth,
          connection: {
            urls: ["wss://session.example"],
          },
        }).servers,
      ).toEqual(["wss://session.example"]);
    } finally {
      if (originalNatsUrl === undefined) {
        delete process.env.NATS_URL;
      } else {
        process.env.NATS_URL = originalNatsUrl;
      }
      if (originalNatsPublicUrl === undefined) {
        delete process.env.NATS_PUBLIC_URL;
      } else {
        process.env.NATS_PUBLIC_URL = originalNatsPublicUrl;
      }
    }
  });

  it("includes an authenticator when credentials are present", () => {
    const options = buildNatsConnectOptions({
      ...sessionWithoutAuth,
      connection: {
        urls: ["nats://127.0.0.1:4222"],
        credentials: "creds",
      },
    });

    expect(options.servers).toEqual(["nats://127.0.0.1:4222"]);
    expect(typeof options.authenticator).toBe("function");
  });

  it("includes an authenticator when token is present", () => {
    const options = buildNatsConnectOptions({
      ...sessionWithoutAuth,
      connection: {
        urls: ["nats://127.0.0.1:4222"],
        token: "token",
      },
    });

    expect(options.servers).toEqual(["nats://127.0.0.1:4222"]);
    expect(typeof options.authenticator).toBe("function");
  });
});

describe("connectNats", () => {
  const fakeConnection = {} as NatsConnection;

  it("uses the websocket connector for ws and wss session URLs", async () => {
    const calls: string[] = [];

    await connectNats(
      {
        ...sessionWithoutAuth,
        connection: {
          urls: ["wss://nats.example.com"],
          credentials: "creds",
        },
      },
      {
        connectTcp: async () => {
          calls.push("tcp");
          return fakeConnection;
        },
        connectWebSocket: async (options: ConnectionOptions) => {
          calls.push("websocket");
          expect(options.servers).toEqual(["wss://nats.example.com"]);
          expect(options.ignoreClusterUpdates).toBe(true);
          expect(typeof options.authenticator).toBe("function");
          return fakeConnection;
        },
      },
    );

    expect(calls).toEqual(["websocket"]);
  });

  it("keeps the TCP connector for nats session URLs", async () => {
    const calls: string[] = [];

    await connectNats(sessionWithoutAuth, {
      connectTcp: async (options: ConnectionOptions) => {
        calls.push("tcp");
        expect(options.servers).toEqual(["nats://127.0.0.1:4222"]);
        expect(options.ignoreClusterUpdates).toBeUndefined();
        return fakeConnection;
      },
      connectWebSocket: async () => {
        calls.push("websocket");
        return fakeConnection;
      },
    });

    expect(calls).toEqual(["tcp"]);
  });
});

describe("createNatsAuthenticator (dynamic)", () => {
  const sessionWithToken = (token: string): LinkSessionResponse => ({
    connection: { urls: ["nats://127.0.0.1:4222"], token },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tunnelHostname: "user-test.link",
  });
  const sessionWithCreds: LinkSessionResponse = {
    connection: { urls: ["nats://127.0.0.1:4222"], credentials: "creds-blob" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tunnelHostname: "user-test.link",
  };

  it("returns undefined when the session has neither creds nor token", () => {
    expect(createNatsAuthenticator(() => sessionWithoutAuth)).toBeUndefined();
  });

  it("builds a creds authenticator function when credentials are present", () => {
    expect(typeof createNatsAuthenticator(() => sessionWithCreds)).toBe(
      "function",
    );
  });

  it("re-reads the latest session on EVERY call (token reflects re-mint)", () => {
    let current = sessionWithToken("T1");
    const auth = createNatsAuthenticator(() => current);
    expect((auth as (nonce?: string) => { auth_token?: string })?.()).toEqual({
      auth_token: "T1",
    });
    // Simulate a background re-mint swapping the held session.
    current = sessionWithToken("T2");
    expect((auth as (nonce?: string) => { auth_token?: string })?.()).toEqual({
      auth_token: "T2",
    });
  });
});

describe("createTunnelSessionSource", () => {
  const sessionExpiringAt = (
    expiresAtMs: number,
    creds: string,
  ): LinkSessionResponse => ({
    connection: { urls: ["nats://127.0.0.1:4222"], credentials: creds },
    expiresAt: new Date(expiresAtMs).toISOString(),
    tunnelHostname: "user-test.link",
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("dedupes concurrent refreshes (single-flight) and swaps current()", async () => {
    let calls = 0;
    const next = sessionExpiringAt(200_000, "creds-2");
    const source = createTunnelSessionSource({
      initial: sessionExpiringAt(100_000, "creds-1"),
      fetchSession: async () => {
        calls += 1;
        return next;
      },
      now: () => 0,
    });

    expect(source.current().connection.credentials).toBe("creds-1");
    await Promise.all([source.refresh(), source.refresh(), source.refresh()]);
    expect(calls).toBe(1);
    expect(source.current().connection.credentials).toBe("creds-2");
  });

  it("getForAuth re-mints only within the refresh margin", async () => {
    let calls = 0;
    let nowMs = 0;
    const expiresAtMs = 100_000;
    const source = createTunnelSessionSource({
      initial: sessionExpiringAt(expiresAtMs, "c1"),
      fetchSession: async () => {
        calls += 1;
        return sessionExpiringAt(expiresAtMs + 100_000, "c2");
      },
      now: () => nowMs,
      refreshMarginMs: 30_000,
    });

    // Far from expiry → no re-mint.
    nowMs = 0;
    source.getForAuth();
    await flush();
    expect(calls).toBe(0);

    // Inside the 30s margin → kicks a re-mint (fire-and-forget).
    nowMs = expiresAtMs - 10_000;
    source.getForAuth();
    await flush();
    expect(calls).toBe(1);
  });

  it("getForAuth returns the current creds even when the re-mint fails, and a later call retries", async () => {
    let calls = 0;
    const source = createTunnelSessionSource({
      initial: sessionExpiringAt(100_000, "c1"),
      fetchSession: async () => {
        calls += 1;
        throw new Error("mint failed");
      },
      now: () => 200_000, // past expiry → always stale
    });

    const first = source.getForAuth();
    expect(first.connection.credentials).toBe("c1");
    await flush();
    expect(calls).toBe(1);
    // inFlight cleared on failure → a later call retries rather than wedging.
    expect(() => source.getForAuth()).not.toThrow();
    await flush();
    expect(calls).toBe(2);
  });
});

describe("sessionRenewDelayMs", () => {
  it("renews before expiry with a bounded skew", () => {
    const now = new Date("2026-06-11T12:00:00.000Z");

    expect(
      sessionRenewDelayMs(
        {
          ...sessionWithoutAuth,
          expiresAt: "2026-06-11T12:00:10.000Z",
        },
        now,
      ),
    ).toBe(9000);
    expect(
      sessionRenewDelayMs(
        {
          ...sessionWithoutAuth,
          expiresAt: "2026-06-11T12:15:00.000Z",
        },
        now,
      ),
    ).toBe(840000);
  });
});

describe("connectToClusterTunnel", () => {
  it("requires controlHandler before requesting session or connecting NATS", async () => {
    let sessionRequested = false;
    let natsConnected = false;

    await expect(
      connectToClusterTunnel(
        makeBaseTunnelInput({ controlHandler: undefined }),
        {
          fetchSession: async () => {
            sessionRequested = true;
            return sessionWithoutAuth;
          },
          connectNats: async () => {
            natsConnected = true;
            throw new Error("should not connect");
          },
        },
      ),
    ).rejects.toThrow("controlHandler is required");

    expect(sessionRequested).toBe(false);
    expect(natsConnected).toBe(false);
  });

  it("retries a transient (503) session fetch and then succeeds", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    let attempts = 0;

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => {
        attempts++;
        if (attempts < 3) {
          throw new LinkSessionRequestError(503, "link session unavailable");
        }
        return sessionWithoutAuth;
      },
      connectNats: async () =>
        ({
          publish: () => {},
          flush: async () => {},
          close: async () => natsClosed.resolve(undefined),
          closed: async () => natsClosed.promise,
        }) as never,
      serveTunnel: async (options) => ({
        hostname: options.hostname,
        closed: serverClosed.promise,
        close: async () => serverClosed.resolve(),
      }),
      sleep: waitForAbortSleep,
      // Tight backoff so the test doesn't wait seconds between simulated 503s.
      sessionFetchRetryOptions: {
        maxAttempts: 5,
        minTimeout: 0,
        maxTimeout: 1,
        jitter: 0,
      },
    });

    expect(attempts).toBe(3);
    await handle.close();
  });

  it("fails fast (no retry) on a 401 auth rejection", async () => {
    let attempts = 0;

    await expect(
      connectToClusterTunnel(makeBaseTunnelInput(), {
        fetchSession: async () => {
          attempts++;
          throw new LinkSessionRequestError(401, "invalid token");
        },
        connectNats: async () => {
          throw new Error("should not connect on auth rejection");
        },
        sleep: waitForAbortSleep,
        sessionFetchRetryOptions: {
          maxAttempts: 5,
          minTimeout: 0,
          maxTimeout: 1,
          jitter: 0,
        },
      }),
    ).rejects.toBeInstanceOf(LinkSessionRequestError);

    expect(attempts).toBe(1);
  });

  it("serves the session tunnel hostname with a control-handler fetch adapter", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    let servedHostname = "";
    let servedFetch: unknown;

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => sessionWithoutAuth,
      connectNats: async () =>
        ({
          publish: () => {},
          flush: async () => {},
          close: async () => natsClosed.resolve(undefined),
          closed: async () => natsClosed.promise,
        }) as never,
      serveTunnel: async (options) => {
        servedHostname = options.hostname;
        servedFetch = options.fetch;
        return {
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => serverClosed.resolve(),
        };
      },
      sleep: waitForAbortSleep,
    });

    expect(servedHostname).toBe(sessionWithoutAuth.tunnelHostname);
    expect(typeof servedFetch).toBe("function");
    await handle.close();
  });

  it("logs transient NATS tunnel disconnect and reconnect status events", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    const statusConsumed = deferred<void>();
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
        fetchSession: async () => sessionWithoutAuth,
        connectNats: async () =>
          ({
            publish: () => {},
            flush: async () => {},
            close: async () => natsClosed.resolve(undefined),
            closed: async () => natsClosed.promise,
            getServer: () => "nats-a",
            status: async function* () {
              yield { type: "disconnect", data: "nats-a" };
              yield { type: "reconnect", data: "nats-a" };
              statusConsumed.resolve();
            },
          }) as never,
        serveTunnel: async (options) => ({
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => serverClosed.resolve(),
        }),
        sleep: waitForAbortSleep,
      });

      await Promise.race([
        statusConsumed.promise,
        new Promise<void>((resolve) => setTimeout(resolve, 20)),
      ]);
      await handle.close();
    } finally {
      logSpy.mockRestore();
    }

    const joined = logs.join("\n");
    expect(joined).toContain(
      "[cluster-connection-tunnel] nats status hostname=user-test.link type=disconnect server=nats-a",
    );
    expect(joined).toContain(
      "[cluster-connection-tunnel] nats status hostname=user-test.link type=reconnect server=nats-a offlineMs=",
    );
  });

  it("logs tunnel diagnostic events emitted by the tunnel server", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
        fetchSession: async () => sessionWithoutAuth,
        connectNats: async () =>
          ({
            publish: () => {},
            flush: async () => {},
            close: async () => natsClosed.resolve(undefined),
            closed: async () => natsClosed.promise,
          }) as never,
        serveTunnel: async (options) => {
          options.diagnostics?.({
            event: "request_decode_error",
            requestId: "req-1",
            subject: "tunnel.v1.host.user.req",
            elapsedMs: 42,
            error: "malformed JSON in tunnel frame",
          });
          return {
            hostname: options.hostname,
            closed: serverClosed.promise,
            close: async () => serverClosed.resolve(),
          };
        },
        sleep: waitForAbortSleep,
      });

      await handle.close();
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain(
      "[cluster-connection-tunnel] tunnel diagnostic hostname=user-test.link event=request_decode_error requestId=req-1 subject=tunnel.v1.host.user.req elapsedMs=42 error=malformed JSON in tunnel frame",
    );
  });

  it("notifies when the first tunnel connection is serving", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    let connected = 0;

    const handle = await connectToClusterTunnel(
      makeBaseTunnelInput({
        onConnected: () => {
          connected++;
        },
      }),
      {
        fetchSession: async () => sessionWithoutAuth,
        connectNats: async () =>
          ({
            publish: () => {},
            flush: async () => {},
            close: async () => natsClosed.resolve(undefined),
            closed: async () => natsClosed.promise,
          }) as never,
        serveTunnel: async (options) => ({
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => serverClosed.resolve(),
        }),
        sleep: waitForAbortSleep,
      },
    );

    expect(connected).toBe(1);
    await handle.close();
  });

  it("serves the tunnel without publishing presence frames", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    const events: string[] = [];

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => sessionWithoutAuth,
      connectNats: async () =>
        ({
          publish: () => {
            events.push("publish");
          },
          flush: async () => {
            events.push("flush");
          },
          close: async () => natsClosed.resolve(undefined),
          closed: async () => natsClosed.promise,
        }) as never,
      serveTunnel: async (options) => {
        events.push("serve");
        return {
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => serverClosed.resolve(),
        };
      },
      sleep: async (_ms, options) => {
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    expect(events).toEqual(["serve"]);

    await handle.close();
  });

  it("renews expiring sessions by starting a fresh tunnel generation", async () => {
    const baseNow = Date.parse("2026-06-11T12:00:00.000Z");
    const secondStarted = deferred<void>();
    const sessions: LinkSessionResponse[] = [
      {
        ...sessionWithoutAuth,
        expiresAt: new Date(baseNow + 2_000).toISOString(),
      },
      {
        ...sessionWithoutAuth,
        expiresAt: new Date(baseNow + 2_000).toISOString(),
      },
    ];
    let fetchCount = 0;
    let natsCloseCount = 0;
    let tunnelCloseCount = 0;
    let renewalSleeps = 0;

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => {
        const session = sessions[Math.min(fetchCount, sessions.length - 1)];
        fetchCount++;
        return session!;
      },
      connectNats: async () => {
        const natsClosed = deferred<void | Error>();
        return {
          publish: () => {},
          flush: async () => {},
          close: async () => {
            natsCloseCount++;
            natsClosed.resolve(undefined);
          },
          closed: async () => natsClosed.promise,
        } as never;
      },
      serveTunnel: async (options) => {
        const serverClosed = deferred<void>();
        if (fetchCount === 2) {
          secondStarted.resolve();
        }
        return {
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => {
            tunnelCloseCount++;
            serverClosed.resolve();
          },
        };
      },
      sleep: async (ms, options) => {
        if (ms < 5_000 && renewalSleeps++ === 0) {
          return;
        }
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      now: () => new Date(baseNow),
    });

    await secondStarted.promise;

    expect(fetchCount).toBe(2);
    expect(natsCloseCount).toBe(1);
    expect(tunnelCloseCount).toBe(1);

    await handle.close();
    expect(natsCloseCount).toBe(2);
    expect(tunnelCloseCount).toBe(2);
  });

  it("closes tunnel server, NATS, and aborts the renewal sleep", async () => {
    const natsClosed = deferred<void | Error>();
    const serverClosed = deferred<void>();
    let serverCloseCount = 0;
    let natsCloseCount = 0;
    let sleepAborted = false;

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => sessionWithoutAuth,
      connectNats: async () =>
        ({
          publish: () => {},
          flush: async () => {},
          close: async () => {
            natsCloseCount++;
            natsClosed.resolve(undefined);
          },
          closed: async () => natsClosed.promise,
        }) as never,
      serveTunnel: async (options) => ({
        hostname: options.hostname,
        closed: serverClosed.promise,
        close: async () => {
          serverCloseCount++;
          serverClosed.resolve();
        },
      }),
      sleep: async (_ms, options) => {
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            sleepAborted = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              sleepAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    await handle.close();

    expect(serverCloseCount).toBe(1);
    expect(natsCloseCount).toBe(1);
    expect(sleepAborted).toBe(true);
    await expect(handle.closed).resolves.toBeUndefined();
  });

  it("reconnects when the tunnel server closes unexpectedly", async () => {
    // An unexpected tunnel/NATS drop must NOT tear down the daemon — the
    // link->cluster leg has to survive instability by re-establishing a fresh
    // generation. Only an explicit close() ends the transport.
    const secondStarted = deferred<void>();
    let fetchCount = 0;
    let natsCloseCount = 0;
    let tunnelCloseCount = 0;
    let dropFirstGen: (() => void) | undefined;

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => {
        fetchCount++;
        return sessionWithoutAuth;
      },
      connectNats: async () => {
        const natsClosed = deferred<void | Error>();
        return {
          publish: () => {},
          flush: async () => {},
          close: async () => {
            natsCloseCount++;
            natsClosed.resolve(undefined);
          },
          closed: async () => natsClosed.promise,
        } as never;
      },
      serveTunnel: async (options) => {
        const serverClosed = deferred<void>();
        const gen = fetchCount;
        if (gen === 1) dropFirstGen = () => serverClosed.resolve();
        if (gen === 2) secondStarted.resolve();
        return {
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => {
            tunnelCloseCount++;
            serverClosed.resolve();
          },
        };
      },
      // Reconnect backoff (~1s) returns immediately; the long renewal sleep
      // hangs until aborted, so only the unexpected drop drives a new gen.
      sleep: async (ms, options) => {
        if (ms < 5_000) return;
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    // First generation drops unexpectedly (not a renewal).
    dropFirstGen!();

    // Manager backs off and re-establishes a fresh generation instead of exiting.
    await secondStarted.promise;
    expect(fetchCount).toBe(2);
    expect(natsCloseCount).toBe(1); // first gen's NATS was torn down on drop

    // Explicit close still ends the transport cleanly.
    await handle.close();
    await expect(handle.closed).resolves.toBeUndefined();
  });

  it("re-establishes after a session fetch failure (survives an unstable link)", async () => {
    // The session fetch keeps failing transiently (e.g. ECONNRESET through a
    // flaky proxy). Previously the manager gave up after the bounded retry burst
    // and the daemon exited; now it backs off and tries again until it connects.
    const connected = deferred<void>();
    let fetchCount = 0;

    const handle = await connectToClusterTunnel(makeBaseTunnelInput(), {
      fetchSession: async () => {
        fetchCount++;
        // Fail the first two establishment attempts, then succeed.
        if (fetchCount <= 2) {
          throw new Error("ECONNRESET");
        }
        return sessionWithoutAuth;
      },
      // A single establishment "burst" here is one attempt (so each failure
      // exhausts the burst and exercises the manager-level reconnect backoff).
      sessionFetchRetryOptions: { maxAttempts: 1 },
      connectNats: async () => {
        const natsClosed = deferred<void | Error>();
        return {
          publish: () => {},
          flush: async () => {},
          close: async () => natsClosed.resolve(undefined),
          closed: async () => natsClosed.promise,
        } as never;
      },
      serveTunnel: async (options) => {
        const serverClosed = deferred<void>();
        connected.resolve();
        return {
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => serverClosed.resolve(),
        };
      },
      // Backoff between bursts returns immediately; renewal sleep hangs.
      sleep: async (ms, options) => {
        if (ms < 5_000) return;
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    });

    await connected.promise;
    expect(fetchCount).toBe(3); // two failures, then success

    await handle.close();
    await expect(handle.closed).resolves.toBeUndefined();
  });
});

test("work dispatch is bound to runLifetimeSignal, not the per-session signal", async () => {
  const sessionAc = new AbortController();
  const runLifetimeAc = new AbortController();
  let capturedSignal: AbortSignal | undefined;

  // handleLocalDispatch sends the run's composite signal to the sandbox
  // `/_sandbox/dispatch` fetch (RequestInit.signal) — a clean seam to capture
  // it. The chunk relay now publishes to NATS (injected fake publisher), so it
  // never hits fetchImpl. We hold the dispatch SSE open until both signal
  // assertions are made, so the captured signal is the live run signal.
  const releaseDispatch = deferred<void>();
  const okProvider: DesktopSandboxProvider = {
    ...provider,
    getDaemonToken: () => "daemon-token",
  };

  const relayLines: Array<{ runId: string }> = [];
  const fakeRelayPublisher = {
    publishLine: async (i: {
      runId: string;
      line: { event: { type: string } };
    }) => {
      relayLines.push(i);
      return (i.line.event.type === "done" ? "terminal" : "published") as
        | "published"
        | "terminal";
    },
    publishDone: async () => {},
  };

  const validWorkItem = {
    runId: "run-1",
    threadId: "thread-1",
    orgId: "org-1",
    userId: "user-1",
    runFenceToken: "fence-1",
    orgSlug: "my-org",
    harnessInput: {
      agent: { id: "agent-1" },
      mcp: { expiresAt: Date.now() + 60_000 },
    },
  };

  const connectionInput = makeBaseTunnelInput({
    provider: okProvider,
    runLifetimeSignal: runLifetimeAc.signal,
    getNatsConnection: () => ({}) as unknown as NatsConnection,
    relayPublisher: fakeRelayPublisher,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/_sandbox/dispatch")) {
        capturedSignal = init?.signal ?? undefined;
        // Keep the SSE body pending until the test releases it, so the run's
        // signal stays live while we assert on it.
        await releaseDispatch.promise;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
  });

  const fetchFn = createTunnelCommandFetch({
    connectionInput,
    controlHandler,
    signal: sessionAc.signal,
    activeWork: new Set(),
  });

  const res = await fetchFn(
    new Request("http://tunnel.local/api/links/work", {
      method: "POST",
      body: JSON.stringify(validWorkItem),
    }),
  );
  expect(res.status).toBe(202);

  // Wait for the async work (dispatchLinkWorkItem) to reach the fetchImpl call.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  expect(capturedSignal).toBeDefined();

  // Aborting the SESSION signal must NOT abort the run's signal.
  sessionAc.abort();
  expect(capturedSignal!.aborted).toBe(false);

  // Aborting the run-lifetime signal DOES abort the run's signal.
  runLifetimeAc.abort();
  expect(capturedSignal!.aborted).toBe(true);

  // Let the now-aborted dispatch unwind so no work dangles past the test.
  releaseDispatch.resolve();
});

test("work dispatch receives the active NATS connection via getNatsConnection", async () => {
  const natsClosed = deferred<void | Error>();
  const serverClosed = deferred<void>();
  // When the fake nc is injected via connectNats, startActive() should build
  // connectionInput = { ...input, getNatsConnection: () => nc } and pass it
  // to createTunnelCommandFetch. Then dispatchLinkWorkItem should call
  // getNatsConnection() to get nc — the null-guard passes, and handleLocalDispatch
  // is reached. We verify this by confirming a /_sandbox/dispatch POST occurs
  // (proving the nc null-guard didn't throw).
  const fakeNatsConnection = {
    publish: () => {},
    flush: async () => {},
    close: async () => natsClosed.resolve(undefined),
    closed: async () => natsClosed.promise,
  } as never as NatsConnection;

  const workItemSent = deferred<void>();
  const urlsSeen: string[] = [];
  const fetchImpl: typeof fetch = (async (url: string) => {
    urlsSeen.push(String(url));
    if (String(url).includes("/_sandbox/dispatch")) {
      workItemSent.resolve();
      // Return a minimal SSE done to end the dispatch.
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
            c.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    if (String(url).includes("/links/runs/")) {
      return Response.json({ ok: true, lastSeq: 1 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  let capturedTunnelFetch:
    | ((req: Request) => Response | Promise<Response>)
    | undefined;

  const providerWithToken: DesktopSandboxProvider = {
    ...provider,
    getDaemonToken: () => "daemon-token",
  };

  // The chunk relay publishes to NATS — inject a fake publisher so a real
  // JetStream client is never built from the bare fake connection. This test
  // only asserts the nc null-guard passes (i.e. `/_sandbox/dispatch` is hit).
  const fakeRelayPublisher = {
    publishLine: async () => "published" as const,
    publishDone: async () => {},
  };

  const handle = await connectToClusterTunnel(
    makeBaseTunnelInput({
      fetchImpl,
      provider: providerWithToken,
      relayPublisher: fakeRelayPublisher,
    }),
    {
      fetchSession: async () => sessionWithoutAuth,
      connectNats: async () => fakeNatsConnection,
      serveTunnel: async (options) => {
        capturedTunnelFetch = options.fetch;
        return {
          hostname: options.hostname,
          closed: serverClosed.promise,
          close: async () => serverClosed.resolve(),
        };
      },
      sleep: waitForAbortSleep,
    },
  );

  // Dispatch a work item through the tunnel fetch handler.
  const validWorkItemBody = JSON.stringify({
    runId: "run-1",
    threadId: "thread-1",
    orgId: "org-1",
    userId: "user-1",
    runFenceToken: "fence-1",
    orgSlug: "my-org",
    harnessInput: {
      agent: { id: "agent-1" },
      mcp: { expiresAt: Date.now() + 60_000 },
    },
  });
  const res = await capturedTunnelFetch!(
    new Request("http://tunnel.local/api/links/work", {
      method: "POST",
      body: validWorkItemBody,
    }),
  );
  expect(res.status).toBe(202);

  // Wait for the async work to reach the sandbox dispatch fetch.
  await Promise.race([
    workItemSent.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 200)),
  ]);

  // If getNatsConnection was NOT wired, the null-guard in dispatchLinkWorkItem
  // would throw before reaching handleLocalDispatch, and /_sandbox/dispatch
  // would never be called. Its presence confirms the accessor is threaded.
  expect(urlsSeen.some((u) => u.includes("/_sandbox/dispatch"))).toBe(true);

  await handle.close();
});

test("GET /api/links/status returns hostname, capabilities, cliVersion", async () => {
  const fetchImpl = createTunnelCommandFetch({
    connectionInput: {
      capabilities: ["claude-code"],
      cliVersion: "9.9.9",
    } as never,
    controlHandler: {
      handle: async () => ({ status: 404 }),
      handleStream: () => (async function* () {})(),
    } as never,
    signal: new AbortController().signal,
    activeWork: new Set(),
  });
  const res = await fetchImpl(
    new Request("http://tunnel.local/api/links/status", { method: "GET" }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.capabilities).toEqual(["claude-code"]);
  expect(body.cliVersion).toBe("9.9.9");
  expect(typeof body.hostname).toBe("string");
});
