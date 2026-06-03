/**
 * `GET /api/links/connect` — the daemon's WebSocket entry point.
 *
 * Validates the bearer token, upgrades to WebSocket, awaits the daemon's
 * `hello` frame, claims the user in the NATS JS KV bucket, and then
 * subscribes to `links.dispatch.<userSub>` / `links.cancel.<userSub>` to
 * forward dispatches from any mesh pod over the WS.
 *
 * Ownership invariant: at most one pod owns the daemon for a given userSub.
 * Enforced via a JS KV `watch` — if a pod sees a `podId` other than its own,
 * it closes the WS with 4001 "superseded".
 */
import type { Env, Hono } from "hono";
import type { ServerWebSocket } from "bun";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";
import type { LinkClaim, LinkClaimRegistry } from "./link-claim-registry";
import type { Capability } from "./protocol";
import { MAX_PUBLISH_BYTES, splitChunkData } from "../nats/payload-chunking";
import type { LinkErrorCode } from "./protocol/error-codes";

const WS_CLOSE_SUPERSEDED = 4001;
const WS_CLOSE_POLICY = 1008;
const WS_CLOSE_INTERNAL = 1011;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface GatewayNatsAdapter {
  subscribe(
    subject: string,
    onMessage: (data: Uint8Array, reply?: string) => void,
  ): () => void;
  publish(subject: string, data: Uint8Array): void;
  request(
    subject: string,
    data: Uint8Array,
    timeoutMs: number,
  ): Promise<Uint8Array | null>;
}

export interface GatewayDeps {
  registry: LinkClaimRegistry;
  nats: GatewayNatsAdapter;
  validateBearer: (token: string) => Promise<string | null>;
  podId: string;
  helloTimeoutMs?: number;
  refreshIntervalMs?: number;
}

interface ConnectionState {
  userSub: string;
  hello: Extract<DispatchFrame, { type: "hello" }>;
  refreshTimer: ReturnType<typeof setInterval>;
  stopWatch: () => void;
  unsubscribeDispatch: () => void;
  unsubscribeCancel: () => void;
  /** Set by the watch listener when another pod takes ownership, or by
   *  `onHello` when a same-pod successor evicts this socket. Tells `close`
   *  to leave the registry alone — someone else owns the claim now. */
  lostOwnership: boolean;
}

export type LocalOwners = Map<string, ServerWebSocket<WsAttachData>>;

export interface WsAttachData {
  kind: "gateway";
  userSub: string;
  deps: GatewayDeps;
  helloTimeoutMs: number;
  refreshIntervalMs: number;
  /** Pod-local map of userSub → currently-owning WS. Same reference across
   *  all connections in this pod so `onHello` can supersede a prior daemon
   *  for the same user before claiming. */
  localOwners: LocalOwners;
  state?: ConnectionState;
  helloTimer?: ReturnType<typeof setTimeout>;
  _inflight?: Map<string, { reply: string }>;
}

export function registerLinksGateway<E extends Env = Env>(
  app: Hono<E>,
  deps: GatewayDeps,
): void {
  const helloTimeoutMs = deps.helloTimeoutMs ?? 5_000;
  const refreshIntervalMs = deps.refreshIntervalMs ?? 20_000;
  const localOwners: LocalOwners = new Map();

  app.get("/api/links/connect", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) return new Response("missing bearer", { status: 401 });
    const token = (match[1] ?? "").trim();
    const userSub = await deps.validateBearer(token);
    if (!userSub) return new Response("invalid bearer", { status: 401 });

    const server = (
      c.env as
        | { server?: { upgrade?: (req: Request, opts?: unknown) => boolean } }
        | undefined
    )?.server;
    if (!server || typeof server.upgrade !== "function") {
      return new Response("ws upgrade not available", { status: 500 });
    }

    const upgraded = server.upgrade(c.req.raw, {
      data: {
        kind: "gateway",
        userSub,
        deps,
        helloTimeoutMs,
        refreshIntervalMs,
        localOwners,
      } satisfies WsAttachData,
    });
    if (!upgraded) {
      return new Response("ws upgrade failed", { status: 400 });
    }
    return new Response(null, { status: 101 });
  });

  app.get("/api/links/me", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    let userSub: string | null = null;
    if (match) {
      userSub = await deps.validateBearer((match[1] ?? "").trim());
    } else {
      // Fall back to existing meshContext (session cookie).
      const ctx = (c.get as (key: string) => unknown)("meshContext") as
        | { auth?: { user?: { id?: string } } }
        | undefined;
      userSub = ctx?.auth?.user?.id ?? null;
    }
    if (!userSub) return c.json({ error: "unauthorized" }, 401);
    const claim = await deps.registry.get(userSub);
    if (!claim) return c.json(null);
    return c.json({
      machineId: claim.machineId,
      hostname: claim.hostname,
      cliVersion: claim.cliVersion,
      previewPort: claim.previewPort,
      connectedAt: claim.connectedAt,
    });
  });
}

function getInflight(
  ws: ServerWebSocket<WsAttachData>,
): Map<string, { reply: string }> {
  if (!ws.data._inflight) ws.data._inflight = new Map();
  return ws.data._inflight;
}

async function onHello(
  ws: ServerWebSocket<WsAttachData>,
  hello: Extract<DispatchFrame, { type: "hello" }>,
): Promise<void> {
  const { userSub, deps, refreshIntervalMs, localOwners } = ws.data;
  const claim: LinkClaim = {
    podId: deps.podId,
    machineId: hello.machineId,
    ...(hello.hostname ? { hostname: hello.hostname } : {}),
    cliVersion: hello.cliVersion,
    previewPort: hello.previewPort,
    connectedAt: Date.now(),
    capabilities: hello.capabilities as Capability[],
  };

  // Same-pod eviction: if another daemon for this user already holds a WS
  // on this pod, close it before claiming. Cross-pod eviction relies on
  // `registry.watch` below; same-pod can't, because both connections would
  // write the same `podId` and neither watch would fire.
  const prior = localOwners.get(userSub);
  if (prior && prior !== ws) {
    if (prior.data.state) prior.data.state.lostOwnership = true;
    try {
      prior.close(WS_CLOSE_SUPERSEDED, "superseded");
    } catch {
      /* */
    }
  }
  localOwners.set(userSub, ws);

  // Assign state with placeholders first so the message handler routes to
  // onAfterHello for any frame that arrives between now and the end of setup.
  const state: ConnectionState = {
    userSub,
    hello,
    refreshTimer: setInterval(() => {
      void deps.registry
        .put(userSub, { ...claim, connectedAt: Date.now() })
        .catch(() => {});
    }, refreshIntervalMs),
    stopWatch: () => {},
    unsubscribeDispatch: () => {},
    unsubscribeCancel: () => {},
    lostOwnership: false,
  };
  ws.data.state = state;

  try {
    // Subscribe to NATS dispatch/cancel *before* publishing the claim so
    // any dispatcher that observes the claim immediately can't have its
    // first message dropped on the floor (core NATS is fire-and-forget).
    state.unsubscribeDispatch = deps.nats.subscribe(
      `links.dispatch.${userSub}`,
      (data, reply) => onDispatchFromNats(ws, data, reply),
    );
    state.unsubscribeCancel = deps.nats.subscribe(
      `links.cancel.${userSub}`,
      (data) => onCancelFromNats(ws, data),
    );

    // Start the watcher before put. Our own `put` will then fire the
    // listener with our own podId, which we no-op (`podId === deps.podId`).
    // The first fire (whatever was there before us) is skipped via `initial`.
    let initial = true;
    state.stopWatch = deps.registry.watch(userSub, (current) => {
      if (initial) {
        initial = false;
        return;
      }
      if (!current || current.podId !== deps.podId) {
        state.lostOwnership = true;
        try {
          ws.close(WS_CLOSE_SUPERSEDED, "superseded");
        } catch {
          /* */
        }
      }
    });

    await deps.registry.put(userSub, claim);
  } catch (err) {
    // Setup failed — tear down anything we did manage to acquire and close.
    clearInterval(state.refreshTimer);
    try {
      state.stopWatch();
    } catch {
      /* */
    }
    try {
      state.unsubscribeDispatch();
    } catch {
      /* */
    }
    try {
      state.unsubscribeCancel();
    } catch {
      /* */
    }
    if (localOwners.get(userSub) === ws) localOwners.delete(userSub);
    ws.data.state = undefined;
    ws.close(
      WS_CLOSE_INTERNAL,
      `init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function onDispatchFromNats(
  ws: ServerWebSocket<WsAttachData>,
  data: Uint8Array,
  reply: string | undefined,
): void {
  if (!reply) return;
  let frame: DispatchFrame;
  try {
    frame = decodeFrame(decoder.decode(data));
  } catch {
    return;
  }
  if (frame.type !== "request") return;
  getInflight(ws).set(frame.reqId, { reply });
  ws.send(encodeFrame(frame));
}

function onCancelFromNats(
  ws: ServerWebSocket<WsAttachData>,
  data: Uint8Array,
): void {
  let frame: DispatchFrame;
  try {
    frame = decodeFrame(decoder.decode(data));
  } catch {
    return;
  }
  if (frame.type !== "cancel") return;
  if (!getInflight(ws).has(frame.reqId)) return;
  ws.send(encodeFrame(frame));
}

/**
 * Publish a frame to `reply`, splitting an oversized `chunk` into ordered
 * sub-chunks (same reqId) so each NATS message stays under the payload limit.
 * The dispatcher yields chunks in order and the consumer concatenates, so no
 * reassembly is needed. Non-chunk frames (headers/end/error) are small.
 */
function publishFrame(
  ws: ServerWebSocket<WsAttachData>,
  reply: string,
  frame: DispatchFrame,
): void {
  const nats = ws.data.deps.nats;
  if (frame.type !== "chunk") {
    nats.publish(reply, encoder.encode(encodeFrame(frame)));
    return;
  }
  const encoded = encoder.encode(encodeFrame(frame));
  if (encoded.length <= MAX_PUBLISH_BYTES) {
    nats.publish(reply, encoded);
    return;
  }
  const overhead = encoder.encode(
    encodeFrame({ type: "chunk", reqId: frame.reqId, data: "" }),
  ).length;
  for (const piece of splitChunkData(frame.data, MAX_PUBLISH_BYTES, overhead)) {
    nats.publish(
      reply,
      encoder.encode(
        encodeFrame({ type: "chunk", reqId: frame.reqId, data: piece }),
      ),
    );
  }
}

/** Best-effort clean error frame to a reply inbox. Returns whether it
 *  actually published — callers use this to decide if the inflight entry can
 *  be dropped or must be kept for the close-time fallback. */
function publishErrorFrame(
  ws: ServerWebSocket<WsAttachData>,
  reply: string,
  reqId: string,
  message: string,
  code: LinkErrorCode = "publish_failed",
): boolean {
  try {
    ws.data.deps.nats.publish(
      reply,
      encoder.encode(encodeFrame({ type: "error", reqId, code, message })),
    );
    return true;
  } catch {
    /* reply inbox unreachable — nothing more we can do */
    return false;
  }
}

async function onAfterHello(
  ws: ServerWebSocket<WsAttachData>,
  frame: DispatchFrame,
): Promise<void> {
  if (frame.type === "hello") {
    ws.close(WS_CLOSE_POLICY, "duplicate hello");
    return;
  }
  if (frame.type === "request" || frame.type === "cancel") return;

  const inflight = getInflight(ws);
  const entry = inflight.get(frame.reqId);
  if (!entry) return;

  try {
    publishFrame(ws, entry.reply, frame);
  } catch (err) {
    // A NATS publish error (e.g. connection gone) — surface it cleanly to the
    // waiting dispatcher instead of letting the throw escape the WS handler
    // and silently break the stream.
    const delivered = publishErrorFrame(
      ws,
      entry.reply,
      frame.reqId,
      err instanceof Error ? err.message : String(err),
    );
    // Only drop the inflight entry once the dispatcher has actually been told
    // the request ended. If even the error frame failed to publish (e.g. NATS
    // down), keep it so the close handler's ws_closed fallback can still fire —
    // the dispatcher has no idle timeout once it has received any chunk.
    if (delivered) inflight.delete(frame.reqId);
    return;
  }

  if (frame.type === "end" || frame.type === "error") {
    inflight.delete(frame.reqId);
  }
}

export const gatewayWsHandlers = {
  open(ws: ServerWebSocket<WsAttachData>) {
    ws.data.helloTimer = setTimeout(() => {
      ws.close(WS_CLOSE_POLICY, "hello timeout");
    }, ws.data.helloTimeoutMs);
  },

  async message(ws: ServerWebSocket<WsAttachData>, raw: string | Uint8Array) {
    const text = typeof raw === "string" ? raw : decoder.decode(raw);
    let frame: DispatchFrame;
    try {
      frame = decodeFrame(text);
    } catch (err) {
      ws.close(
        WS_CLOSE_POLICY,
        `bad frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!ws.data.state) {
      if (frame.type !== "hello") {
        ws.close(WS_CLOSE_POLICY, "first frame must be hello");
        return;
      }
      clearTimeout(ws.data.helloTimer);
      await onHello(ws, frame);
      return;
    }
    await onAfterHello(ws, frame);
  },

  close(ws: ServerWebSocket<WsAttachData>, _code: number, _reason: string) {
    clearTimeout(ws.data.helloTimer);

    // Notify any cluster pods still awaiting replies for in-flight requests
    // so their dispatchers throw promptly instead of hanging on the reply
    // inbox (the dispatcher has no idle timeout after the first frame).
    const inflight = ws.data._inflight;
    if (inflight && inflight.size > 0) {
      for (const [reqId, entry] of inflight) {
        try {
          const code: LinkErrorCode = "ws_closed";
          ws.data.deps.nats.publish(
            entry.reply,
            encoder.encode(
              encodeFrame({
                type: "error",
                reqId,
                code,
                message: "daemon WebSocket closed before response completed",
              }),
            ),
          );
        } catch {
          /* */
        }
      }
      inflight.clear();
    }

    const s = ws.data.state;
    if (!s) return;
    clearInterval(s.refreshTimer);
    try {
      s.stopWatch();
    } catch {
      /* ignore */
    }
    try {
      s.unsubscribeDispatch();
    } catch {
      /* ignore */
    }
    try {
      s.unsubscribeCancel();
    } catch {
      /* ignore */
    }

    // Only release the claim when we are still its owner — both locally
    // (no same-pod successor took over) and per the watcher flag (no
    // cross-pod takeover detected). Otherwise the delete would wipe a
    // successor pod's freshly-published claim.
    const stillLocalOwner = ws.data.localOwners.get(s.userSub) === ws;
    if (stillLocalOwner) ws.data.localOwners.delete(s.userSub);
    if (stillLocalOwner && !s.lostOwnership) {
      void ws.data.deps.registry.delete(s.userSub).catch(() => {});
    }
  },
};
