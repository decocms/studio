import { hostname as osHostname } from "node:os";
import {
  exponentialBackoffWithJitter,
  retry,
  sleep,
  type RetryOptions,
} from "@decocms/shared/std";
import * as tunnel from "@decocms/tunnel";
import { encodeSubjectToken } from "@decocms/tunnel/subject";
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
const LINK_TUNNEL_VERBOSE = process.env.DECO_LINK_TUNNEL_VERBOSE === "1";

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

// Backoff between *re-establishment* attempts in the connection manager loop.
// `SESSION_FETCH_RETRY_OPTIONS` bounds a single establishment burst (8 tries);
// when that burst is exhausted on an unstable link, the manager waits this long
// and tries the whole burst again — indefinitely — so a flaky link->cluster leg
// recovers instead of the daemon giving up. Same shape for an unexpected close.
const RECONNECT_BACKOFF_BASE_MS = 1_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;

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

function workLogFields(item: {
  runId: string;
  threadId: string;
  orgSlug: string;
  sandbox?: { handle?: string };
}): string {
  return [
    `runId=${item.runId}`,
    `threadId=${item.threadId}`,
    `orgSlug=${item.orgSlug}`,
    item.sandbox?.handle ? `handle=${item.sandbox.handle}` : undefined,
  ]
    .filter((field): field is string => Boolean(field))
    .join(" ");
}

function controlFrameLogFields(
  frame: ReturnType<typeof decodeControlFrame>,
): string {
  if (frame.type === "cancel") {
    return `type=${frame.type} runId=${frame.runId}`;
  }
  if (frame.type === "cancel_req") {
    return `type=${frame.type} reqId=${frame.reqId}`;
  }
  return `type=${frame.type}`;
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
        console.warn(
          "[cluster-connection-tunnel] work rejected reason=invalid_json",
        );
        return new Response(JSON.stringify({ error: "invalid_json" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const parsed = workItemSchema.safeParse(item);
      if (!parsed.success) {
        console.warn(
          `[cluster-connection-tunnel] work rejected reason=invalid_work_item issues=${parsed.error.issues.length}`,
        );
        return new Response(JSON.stringify({ error: "invalid_work_item" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const fields = workLogFields(parsed.data);
      const startedAt = Date.now();
      console.log(`[cluster-connection-tunnel] work accepted ${fields}`);
      const work = dispatchLinkWorkItem(
        input.connectionInput,
        input.connectionInput.runLifetimeSignal ?? input.signal,
        parsed.data,
      ).then(
        () => {
          console.log(
            `[cluster-connection-tunnel] work settled ${fields} elapsedMs=${Date.now() - startedAt}`,
          );
        },
        (err) => {
          if (!input.signal.aborted) {
            console.error(
              `[cluster-connection-tunnel] work failed ${fields} elapsedMs=${Date.now() - startedAt}`,
              err,
            );
          }
        },
      );
      input.activeWork.add(work);
      work.finally(() => input.activeWork.delete(work));
      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/api/links/control" && request.method === "POST") {
      let frame: ReturnType<typeof decodeControlFrame>;
      try {
        frame = decodeControlFrame(await request.text());
      } catch {
        console.warn(
          "[cluster-connection-tunnel] control rejected reason=invalid_control_frame",
        );
        return new Response(
          JSON.stringify({ error: "invalid_control_frame" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (LINK_TUNNEL_VERBOSE || frame.type !== "keep_alive") {
        console.log(
          `[cluster-connection-tunnel] control frame ${controlFrameLogFields(frame)}`,
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

/**
 * Build a NATS authenticator that re-reads the LATEST session on every
 * (re)connect via `getSession`, instead of capturing one static credentials
 * blob. The NATS client invokes the authenticator on each connection attempt
 * (`maxReconnectAttempts: -1`), so when the session has been re-minted in the
 * background, an auto-reconnect after a credentials-expiry kick presents the
 * FRESH JWT and self-heals — rather than looping forever on the dead creds
 * (the field failure: a tunnel-relay run died on `ClosedConnectionError` after
 * `UserAuthenticationExpiredError` because the static authenticator could only
 * ever re-present the already-expired token). The factory (creds vs token) is
 * chosen once from the initial session — the cluster never switches auth modes
 * within a daemon's lifetime — but the VALUE is read live on each call.
 */
export function createNatsAuthenticator(
  getSession: () => LinkSessionResponse,
):
  | ReturnType<typeof credsAuthenticator>
  | ReturnType<typeof tokenAuthenticator>
  | undefined {
  const initial = getSession();
  if (initial.connection.credentials) {
    const encoder = new TextEncoder();
    return credsAuthenticator(() =>
      encoder.encode(getSession().connection.credentials ?? ""),
    );
  }
  if (initial.connection.token) {
    return tokenAuthenticator(() => getSession().connection.token ?? "");
  }
  return undefined;
}

export function buildNatsConnectOptions(
  session: LinkSessionResponse,
  /**
   * Live view of the current session for the authenticator. Defaults to the
   * static `session` (back-compat); production passes a
   * {@link TunnelSessionSource}'s `getForAuth` so reconnects use re-minted
   * creds. Connection-level fields (urls, inbox prefix) come from `session` and
   * are stable across re-mints (same hostname/URLs) — only the credentials
   * rotate.
   */
  getSession: () => LinkSessionResponse = () => session,
): ConnectionOptions {
  const authenticator = createNatsAuthenticator(getSession);
  return {
    servers: session.connection.urls,
    ...(authenticator ? { authenticator } : {}),
    // Survive an unstable link -> cluster connection (e.g. a flaky network or a
    // toxiproxy between the daemon and the cluster NATS). Reconnect FOREVER with
    // a bounded backoff + jitter rather than giving up after the NATS.js default
    // of 10 attempts. The session-renew timer still recycles the connection
    // before its credentials expire, so infinite reconnect only ever operates
    // within the valid-creds window; a sustained outage just keeps retrying
    // while the daemon stays up and the relay outbox holds the unacked prefix.
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1_000,
    reconnectJitter: 1_000,
    reconnectJitterTLS: 2_000,
    // Scope the request/reply inbox to this daemon's host token so JetStream
    // PubAcks (from the direct-NATS chunk relay's `js.publish`) land on a
    // subject the minted credentials are allowed to subscribe to. Must match
    // the `_INBOX.<hostToken>.>` subscribe grant in
    // `buildDaemonCredentialPermissions`.
    inboxPrefix: `_INBOX.${encodeSubjectToken(session.tunnelHostname)}`,
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
  /** Live session view for the authenticator (see buildNatsConnectOptions). */
  getSession: () => LinkSessionResponse = () => session,
): Promise<NatsConnection> {
  const useWebSocket = isWebSocketSession(session);
  const options = buildNatsConnectOptions(session, getSession);
  if (useWebSocket) {
    options.ignoreClusterUpdates = true;
  }
  const connector = useWebSocket
    ? (deps.connectWebSocket ?? defaultWebSocketConnect)
    : (deps.connectTcp ?? connectTcp);
  return await connector(options);
}

/**
 * Default lead time before a session's hard expiry at which the authenticator
 * proactively re-mints, so a NATS (re)connect is never handed an already-expired
 * JWT. Sits comfortably inside the daemon-side 60s renewal skew but is checked
 * lazily on each auth call, so it also covers the case the renewal timer missed
 * (laptop sleep / wall-clock jump) — exactly when self-healing matters.
 */
const SESSION_REFRESH_MARGIN_MS = 30_000;

/**
 * A live, refreshable view of the tunnel session credentials shared with the
 * NATS authenticator. `current()` is the latest minted session; `getForAuth()`
 * is the synchronous accessor the authenticator calls on every (re)connect —
 * it returns the current session and, when the creds are within the refresh
 * margin of expiry, kicks a single-flight background re-mint so the NEXT
 * connection attempt presents fresh creds. `refresh()` forces a re-mint now.
 */
export interface TunnelSessionSource {
  current(): LinkSessionResponse;
  refresh(): Promise<void>;
  getForAuth(): LinkSessionResponse;
}

export function createTunnelSessionSource(opts: {
  initial: LinkSessionResponse;
  /** Re-mints a fresh session (creds + expiry). Typically the retrying fetch. */
  fetchSession: () => Promise<LinkSessionResponse>;
  now?: () => number;
  refreshMarginMs?: number;
}): TunnelSessionSource {
  const now = opts.now ?? (() => Date.now());
  const marginMs = opts.refreshMarginMs ?? SESSION_REFRESH_MARGIN_MS;
  let session = opts.initial;
  // Single-flight: concurrent auth calls + the timer must not stampede the mint
  // endpoint. While one re-mint is in flight, every caller awaits the same one.
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        session = await opts.fetchSession();
      } catch (err) {
        // A re-mint failure must never reject the synchronous auth path; keep
        // the current creds (a still-live connection is unaffected) and let a
        // later call retry once `inFlight` is cleared.
        console.warn(
          "[cluster-connection-tunnel] session refresh failed; keeping current creds",
          err,
        );
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const isStale = (): boolean => {
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return false;
    return now() >= expiresAtMs - marginMs;
  };

  return {
    current: () => session,
    refresh,
    getForAuth: () => {
      if (isStale()) void refresh();
      return session;
    },
  };
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
  // The CURRENT live NATS connection, updated on every `startActive`. In-flight
  // dispatches read this (via `getNatsConnection`) per publish attempt, so a run
  // that started under a prior session re-sources the NEW connection after a
  // tunnel-session renewal (which recycles the old connection).
  let liveNc: NatsConnection | null = null;
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
    // Live credentials view for the authenticator: a NATS auto-reconnect that
    // fires after the JWT expires (e.g. the daemon-side renewal timer was paused
    // by laptop sleep, so the server kicks the connection with
    // UserAuthenticationExpiredError) re-presents FRESH creds re-minted in the
    // background, instead of looping forever on the dead token.
    const sessionSource = createTunnelSessionSource({
      initial: session,
      fetchSession: fetchSessionWithRetry,
      now: () => now().getTime(),
    });
    const nc = await (deps.connectNats ?? connectNats)(
      session,
      undefined,
      sessionSource.getForAuth,
    );
    liveNc = nc;
    monitorNatsStatus(nc, session.tunnelHostname, now);
    const ac = new AbortController();
    let tunnelServer: tunnel.TunnelServer | undefined;
    const activeWork = new Set<Promise<void>>();

    const connectionInput = {
      ...input,
      getNatsConnection: () => liveNc,
    };

    try {
      tunnelServer = await (deps.serveTunnel ?? tunnel.serve)({
        connection: nc,
        hostname: session.tunnelHostname,
        fetch: createTunnelCommandFetch({
          connectionInput,
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

  // Interrupts an in-progress reconnect backoff sleep when close() is called, so
  // shutdown doesn't wait out the backoff.
  const managerAbort = new AbortController();
  let reconnectAttempt = 0;
  const backoffReconnect = async (): Promise<void> => {
    const backoffMs = exponentialBackoffWithJitter(
      RECONNECT_BACKOFF_CAP_MS,
      RECONNECT_BACKOFF_BASE_MS,
      reconnectAttempt++,
      2,
      0.5,
    );
    await sleepImpl(backoffMs, { signal: managerAbort.signal }).catch(() => {});
  };

  const managerClosed = (async () => {
    try {
      while (!stopRequested) {
        try {
          active = await startActive();
        } catch (err) {
          if (stopRequested) break;
          // Bad credentials (401/403) won't fix themselves — fail fast so the
          // daemon surfaces the error instead of spinning forever.
          if (!isRetriableSessionError(err)) {
            throw err;
          }
          // Transient failure (network blip, ECONNRESET, cluster reset/booting).
          // Survive an unstable link->cluster leg: back off and re-establish
          // indefinitely rather than giving up. Applies even before the first
          // successful connection (the cluster may be briefly unreachable).
          console.warn(
            "[cluster-connection-tunnel] connect failed; retrying",
            err,
          );
          await backoffReconnect();
          continue;
        }
        reconnectAttempt = 0;
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
        if (stopRequested) break;
        // A planned renewal loops immediately. An *unexpected* close (NATS or
        // tunnel dropped for good) previously exited the daemon — which is what
        // made an unstable link fatal. Instead, back off briefly and reconnect.
        if (reason !== "renew") {
          console.warn(
            "[cluster-connection-tunnel] connection dropped; reconnecting",
          );
          await backoffReconnect();
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
      managerAbort.abort();
      await active?.close();
    }
  })();

  await ready;

  return {
    async close() {
      console.log("[cluster-connection-tunnel] closing");
      stopRequested = true;
      managerAbort.abort();
      await active?.close();
      await managerClosed;
    },
    closed: managerClosed,
  };
}
