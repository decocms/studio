import { hostname as osHostname } from "node:os";
import { retry, sleep, type RetryOptions } from "@decocms/std";
import * as tunnel from "@decocms/tunnel";
import {
  credsAuthenticator,
  tokenAuthenticator,
  wsconnect,
  type ConnectionOptions,
  type NatsConnection,
} from "@nats-io/nats-core";
import { connect as connectTcp } from "@nats-io/transport-node";
import {
  linkSessionResponseSchema,
  type LinkSessionResponse,
} from "../links/link-session";
import { workItemSchema } from "../links/link-work-item";
import { createControlHandlerFetch } from "./control-handler-fetch";
import type { ControlHandler } from "./control-handler";
import {
  dispatchLinkWorkItem,
  type LinkWorkItemDispatchInput,
} from "./dispatch-link-work-item";
import type { ClusterConnectionHandle } from "./types";
import { decodeControlFrame } from "../api/routes/decopilot/control-frames";
import * as runAbortRegistry from "./run-abort-registry";
import * as proxyAbortRegistry from "./proxy-abort-registry";
import type { Capability } from "../links/protocol";

const SESSION_RENEW_MAX_SKEW_MS = 60_000;
const SESSION_RENEW_MIN_SKEW_MS = 1_000;

// Retry policy for the link-session fetch. A transient cluster-not-ready-yet
// (503 at boot) or a network blip should back off and retry rather than crash
// the whole daemon (which the dev supervisor would then respawn, churning
// presence). Auth rejections (401/403) must still fast-fail so a bad token
// surfaces instead of looping forever.
const SESSION_FETCH_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 8,
  minTimeout: 1_000,
  maxTimeout: 30_000,
  multiplier: 2,
  jitter: 0.5,
};

/**
 * Error thrown by {@linkcode fetchLinkSession} when the cluster responds with a
 * non-2xx status. `status` is the HTTP status code (e.g. 503, 401); a transport
 * failure (no response at all) throws the underlying error directly, which the
 * retry predicate treats as retriable.
 */
export class LinkSessionRequestError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(
      `[cluster-connection-tunnel] link session request failed (${status})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "LinkSessionRequestError";
    this.status = status;
  }
}

/**
 * Whether a failed session fetch should be retried. Network/transport errors
 * (anything that isn't a {@linkcode LinkSessionRequestError}) and 5xx server
 * errors are retriable; auth rejections (401/403) and other 4xx are not, so an
 * invalid token fails fast instead of looping.
 */
export function isRetriableSessionError(err: unknown): boolean {
  if (err instanceof LinkSessionRequestError) {
    return err.status >= 500;
  }
  // Transport-level failures (fetch threw, e.g. ECONNREFUSED while the cluster
  // is still booting) carry no status — retry them.
  return true;
}

export interface ClusterConnectionTunnelInput
  extends LinkWorkItemDispatchInput {
  controlHandler: ControlHandler;
  capabilities?: Capability[];
  machineId?: string;
  cliVersion?: string;
  previewPort?: number;
  fetchImpl?: typeof fetch;
  onConnected?: () => void;
  onShutdown?: () => void;
  /**
   * Daemon-lifetime signal that bounds an in-flight run's execution. A tunnel
   * SESSION renewal must NOT abort a running build — only an explicit cancel
   * (runAbortRegistry) or daemon shutdown should. When set, the work dispatch
   * binds to this instead of the per-session tunnel signal. Absent → falls back
   * to the session signal (legacy/test behavior).
   */
  runLifetimeSignal?: AbortSignal;
}

interface ClusterConnectionTunnelDeps {
  fetchSession?: typeof fetchLinkSession;
  connectNats?: typeof connectNats;
  serveTunnel?: typeof tunnel.serve;
  sleep?: typeof sleep;
  now?: () => Date;
  /**
   * Overrides the backoff used when retrying a transient session fetch. Tests
   * pass tight timeouts (and an AbortSignal) so they don't actually wait
   * seconds between simulated 503s.
   */
  sessionFetchRetryOptions?: RetryOptions;
}

type NatsConnector = (options: ConnectionOptions) => Promise<NatsConnection>;

interface ConnectNatsDeps {
  connectTcp?: NatsConnector;
  connectWebSocket?: NatsConnector;
}

type NatsStatusLike = {
  type?: unknown;
  data?: unknown;
  error?: unknown;
};

type NatsConnectionWithStatus = NatsConnection & {
  status?: () => AsyncIterable<NatsStatusLike>;
  getServer?: () => string;
};

function formatLogValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) {
    return `${value.name}:${value.message}`;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}

function logTunnelDiagnostic(
  hostname: string,
  event: tunnel.TunnelDiagnosticEvent,
): void {
  const fields = [
    `hostname=${hostname}`,
    `event=${event.event}`,
    event.requestId ? `requestId=${event.requestId}` : undefined,
    event.subject ? `subject=${event.subject}` : undefined,
    event.elapsedMs !== undefined ? `elapsedMs=${event.elapsedMs}` : undefined,
    event.error ? `error=${event.error}` : undefined,
  ].filter((field): field is string => Boolean(field));
  console.log(
    `[cluster-connection-tunnel] tunnel diagnostic ${fields.join(" ")}`,
  );
}

function monitorNatsStatus(
  nc: NatsConnection,
  hostname: string,
  now: () => Date,
): void {
  const statusSource = (nc as NatsConnectionWithStatus).status;
  if (typeof statusSource !== "function") return;

  void (async () => {
    let disconnectedAtMs: number | undefined;
    for await (const status of statusSource.call(nc)) {
      const type = formatLogValue(status.type) ?? "unknown";
      const server =
        formatLogValue(status.data) ??
        formatLogValue((nc as NatsConnectionWithStatus).getServer?.());
      const error = formatLogValue(status.error);
      const currentMs = now().getTime();
      if (type === "disconnect") {
        disconnectedAtMs = currentMs;
      }

      const fields = [
        `hostname=${hostname}`,
        `type=${type}`,
        server ? `server=${server}` : undefined,
        error ? `error=${error}` : undefined,
        type === "reconnect" && disconnectedAtMs !== undefined
          ? `offlineMs=${Math.max(0, currentMs - disconnectedAtMs)}`
          : undefined,
      ].filter((field): field is string => Boolean(field));

      console.log(
        `[cluster-connection-tunnel] nats status ${fields.join(" ")}`,
      );

      if (type === "reconnect") {
        disconnectedAtMs = undefined;
      }
    }
  })().catch((err) => {
    console.error(
      `[cluster-connection-tunnel] nats status monitor failed hostname=${hostname}`,
      err,
    );
  });
}

type LinkSessionRequestInput = Pick<
  ClusterConnectionTunnelInput,
  "capabilities" | "machineId" | "cliVersion" | "previewPort"
>;

function buildLinkSessionRequestBody(
  input: LinkSessionRequestInput,
): Record<string, unknown> {
  return {
    capabilities: input.capabilities,
    machineId: input.machineId,
    cliVersion: input.cliVersion,
    previewPort: input.previewPort,
  };
}

export async function fetchLinkSession(
  input: Pick<
    ClusterConnectionTunnelInput,
    | "clusterBaseUrl"
    | "getAccessToken"
    | "fetchImpl"
    | "capabilities"
    | "machineId"
    | "cliVersion"
    | "previewPort"
  >,
): Promise<LinkSessionResponse> {
  const token = await input.getAccessToken();
  const fetcher = input.fetchImpl ?? fetch;
  const res = await fetcher(`${input.clusterBaseUrl}/api/links/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildLinkSessionRequestBody(input)),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LinkSessionRequestError(res.status, detail);
  }

  const parsed = linkSessionResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `[cluster-connection-tunnel] invalid link session response: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

export function createTunnelCommandFetch(input: {
  connectionInput: ClusterConnectionTunnelInput;
  controlHandler: ControlHandler;
  signal: AbortSignal;
  activeWork: Set<Promise<void>>;
}): (request: Request) => Promise<Response> {
  const delegate = createControlHandlerFetch(input.controlHandler);

  return async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/api/links/status" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          hostname: osHostname() || "",
          capabilities: input.connectionInput.capabilities ?? [],
          cliVersion: input.connectionInput.cliVersion ?? "",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === "/api/links/work" && request.method === "POST") {
      let item: unknown;
      try {
        item = JSON.parse(await request.text());
      } catch {
        return new Response(JSON.stringify({ error: "invalid_json" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const parsed = workItemSchema.safeParse(item);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: "invalid_work_item" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const work = dispatchLinkWorkItem(
        input.connectionInput,
        input.connectionInput.runLifetimeSignal ?? input.signal,
        parsed.data,
      ).catch((err) => {
        if (!input.signal.aborted) {
          console.error("[cluster-connection-tunnel] work command failed", err);
        }
      });
      input.activeWork.add(work);
      work.finally(() => input.activeWork.delete(work));
      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/api/links/control" && request.method === "POST") {
      let frame: ReturnType<typeof decodeControlFrame>;
      try {
        frame = decodeControlFrame(await request.text());
      } catch {
        return new Response(
          JSON.stringify({ error: "invalid_control_frame" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (frame.type === "cancel") {
        runAbortRegistry.abort(frame.runId);
      } else if (frame.type === "cancel_req") {
        proxyAbortRegistry.abort(frame.reqId);
      } else if (frame.type === "shutdown") {
        input.connectionInput.onShutdown?.();
      }
      return new Response(null, { status: 204 });
    }

    return delegate(request);
  };
}

function createNatsAuthenticator(
  session: LinkSessionResponse,
):
  | ReturnType<typeof credsAuthenticator>
  | ReturnType<typeof tokenAuthenticator>
  | undefined {
  if (session.connection.credentials) {
    return credsAuthenticator(
      new TextEncoder().encode(session.connection.credentials),
    );
  }
  if (session.connection.token) {
    return tokenAuthenticator(session.connection.token);
  }
  return undefined;
}

export function buildNatsConnectOptions(
  session: LinkSessionResponse,
): ConnectionOptions {
  const authenticator = createNatsAuthenticator(session);
  return {
    servers: session.connection.urls,
    ...(authenticator ? { authenticator } : {}),
  };
}

function isWebSocketSession(session: LinkSessionResponse): boolean {
  return session.connection.urls.some((url) => {
    const protocol = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1];
    return (
      protocol?.toLowerCase() === "ws" || protocol?.toLowerCase() === "wss"
    );
  });
}

const defaultWebSocketConnect: NatsConnector = (options) => wsconnect(options);

export async function connectNats(
  session: LinkSessionResponse,
  deps: ConnectNatsDeps = {},
): Promise<NatsConnection> {
  const useWebSocket = isWebSocketSession(session);
  const options = buildNatsConnectOptions(session);
  if (useWebSocket) {
    options.ignoreClusterUpdates = true;
  }
  const connector = useWebSocket
    ? (deps.connectWebSocket ?? defaultWebSocketConnect)
    : (deps.connectTcp ?? connectTcp);
  return await connector(options);
}

export function sessionRenewDelayMs(
  session: LinkSessionResponse,
  now: Date,
): number {
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 0;
  const remainingMs = expiresAtMs - now.getTime();
  if (remainingMs <= 0) return 0;
  const skewMs = Math.min(
    SESSION_RENEW_MAX_SKEW_MS,
    Math.max(SESSION_RENEW_MIN_SKEW_MS, remainingMs * 0.1),
  );
  return Math.max(0, Math.floor(remainingMs - skewMs));
}

interface ActiveTunnelConnection {
  close: () => Promise<void>;
  closed: Promise<void>;
  closedReason: Promise<"renew" | "closed">;
}

export async function connectToClusterTunnel(
  input: ClusterConnectionTunnelInput,
  deps: ClusterConnectionTunnelDeps = {},
): Promise<ClusterConnectionHandle> {
  if (!input.controlHandler) {
    throw new Error(
      "[cluster-connection-tunnel] controlHandler is required for tunnel transport",
    );
  }
  const controlHandler = input.controlHandler;

  const sleepImpl = deps.sleep ?? sleep;
  const now = deps.now ?? (() => new Date());
  let stopRequested = false;
  let active: ActiveTunnelConnection | undefined;
  let firstReady:
    | { resolve: () => void; reject: (err: unknown) => void }
    | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    firstReady = { resolve, reject };
  });

  const fetchSession = deps.fetchSession ?? fetchLinkSession;
  // Retry transient session fetches (503 cluster-not-ready-at-boot, network
  // blips) with backoff instead of letting a single failure exit the daemon.
  // Auth rejections (401/403) still fail fast via `isRetriableSessionError`.
  const fetchSessionWithRetry = (): Promise<LinkSessionResponse> =>
    retry(() => fetchSession(input), {
      ...SESSION_FETCH_RETRY_OPTIONS,
      ...deps.sessionFetchRetryOptions,
      isRetriable: isRetriableSessionError,
    });

  const startActive = async (): Promise<ActiveTunnelConnection> => {
    const session = await fetchSessionWithRetry();
    const nc = await (deps.connectNats ?? connectNats)(session);
    monitorNatsStatus(nc, session.tunnelHostname, now);
    const ac = new AbortController();
    let tunnelServer: tunnel.TunnelServer | undefined;
    const activeWork = new Set<Promise<void>>();

    try {
      tunnelServer = await (deps.serveTunnel ?? tunnel.serve)({
        connection: nc,
        hostname: session.tunnelHostname,
        fetch: createTunnelCommandFetch({
          connectionInput: input,
          controlHandler,
          signal: ac.signal,
          activeWork,
        }),
        signal: ac.signal,
        diagnostics: (event) =>
          logTunnelDiagnostic(session.tunnelHostname, event),
      });
    } catch (err) {
      ac.abort();
      await Promise.allSettled([tunnelServer?.close(), nc.close()]);
      throw err;
    }

    console.log(
      `[cluster-connection-tunnel] serving tunnel hostname=${session.tunnelHostname}`,
    );

    let closeStarted = false;
    const closeActive = async (): Promise<void> => {
      if (closeStarted) return;
      closeStarted = true;
      ac.abort();
      await Promise.allSettled([
        tunnelServer.close(),
        nc.close(),
        ...activeWork,
      ]);
    };

    const natsClosed = nc.closed().then((err) => {
      if (err) {
        console.error(
          "[cluster-connection-tunnel] nats connection closed",
          err,
        );
      }
      void closeActive();
    });
    const tunnelClosed = tunnelServer.closed.then(
      () => {
        void closeActive();
      },
      (err) => {
        console.error("[cluster-connection-tunnel] tunnel server closed", err);
        void closeActive();
      },
    );

    const closed = Promise.allSettled([tunnelClosed, natsClosed]).then(
      () => undefined,
    );

    const renewDelayMs = sessionRenewDelayMs(session, now());
    const renewalDue = sleepImpl(renewDelayMs, { signal: ac.signal }).then(
      () => "renew" as const,
      () => "closed" as const,
    );

    const closedReason = Promise.race([
      closed.then(() => "closed" as const),
      renewalDue,
    ]).then((reason) => {
      if (reason === "renew" && !ac.signal.aborted) {
        console.log(
          `[cluster-connection-tunnel] renewing tunnel session hostname=${session.tunnelHostname}`,
        );
        void closeActive();
        return "renew" as const;
      }
      return "closed" as const;
    });

    return {
      close: closeActive,
      closed,
      closedReason,
    };
  };

  const managerClosed = (async () => {
    try {
      while (!stopRequested) {
        active = await startActive();
        if (firstReady) {
          firstReady.resolve();
          firstReady = undefined;
          input.onConnected?.();
        }
        if (stopRequested) {
          await active.close();
          break;
        }
        const reason = await active.closedReason;
        await active.closed;
        active = undefined;
        if (reason !== "renew") {
          break;
        }
      }
    } catch (err) {
      firstReady?.reject(err);
      firstReady = undefined;
      if (!stopRequested) {
        console.error("[cluster-connection-tunnel] connection failed", err);
      }
    } finally {
      stopRequested = true;
      await active?.close();
    }
  })();

  await ready;

  return {
    async close() {
      console.log("[cluster-connection-tunnel] closing");
      stopRequested = true;
      await active?.close();
      await managerClosed;
    },
    closed: managerClosed,
  };
}
