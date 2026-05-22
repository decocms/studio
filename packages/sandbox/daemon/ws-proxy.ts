/**
 * Transparent WebSocket reverse proxy for the daemon.
 *
 * The daemon's HTTP proxy uses fetch(), which doesn't carry WebSocket
 * upgrade semantics. Without this, Vite's HMR client (and any other
 * dev-server WS) gets 502 on the upgrade, retries a few times, then
 * triggers a full-page reload as recovery — the user sees the page load
 * then immediately reload, in a loop.
 *
 * Implementation notes:
 *
 * We CANNOT use Bun's global `WebSocket` or the `ws` npm package as the
 * client to upstream. Bun shims `ws` to its native WebSocket, and Bun's
 * WebSocket client closes its TCP socket with RST instead of FIN. Vite
 * on Node 24 emits an unhandled `error` event on the receiving socket
 * when it sees that RST, which exits the dev-server process.
 *
 * Instead we hand-roll the upstream side using `node:http.request` with
 * upgrade headers. The 'upgrade' event hands us the raw TCP socket post-
 * handshake; we then implement WebSocket framing inline to bridge bytes
 * between Bun.serve's already-decoded messages and the raw upstream
 * socket. Closing that socket goes through Node's standard FIN path —
 * no RST.
 *
 * Subprotocols (`vite-hmr`, `vite-ping`, …) are forwarded — Vite ignores
 * connections that drop them. The upstream loopback (IPv4 vs IPv6) is
 * picked by a TCP probe before connecting, so a mid-handshake failure
 * never silently retries on the other family.
 */
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import type { ServerWebSocket } from "bun";
import { bracketHost, pickLoopback } from "./loopback";

/**
 * Cap on frames buffered between client upgrade and upstream WS open. The
 * upstream here is the in-pod dev server on localhost; if it isn't yet
 * listening (booting / crashed), an unbounded pending queue would let a
 * chatty client exhaust the daemon's memory.
 */
const MAX_PENDING_FRAMES = 256;

export interface WsProxyData {
  /** Upstream dev-server port. Null when no port is known at upgrade time. */
  port: number | null;
  /** Path + query of the upgrade request, forwarded verbatim. */
  pathQuery: string;
  /** Subprotocols the client advertised on the upgrade request. */
  protocols: string[] | undefined;
  /** Raw TCP socket to upstream after the WS handshake, or null pre-handshake. */
  upstream: Socket | null;
  /** Frames received from the client before the upstream handshake completes. */
  pending: (string | ArrayBuffer | Uint8Array)[];
}

export interface WsUpgraderOptions {
  onClientMessage?: () => void;
}

export function makeWsUpgrader(
  getDevPort: () => number | null,
  opts: WsUpgraderOptions = {},
) {
  return {
    /** Build the per-connection state attached to ws.data at upgrade time.
     *  Falls back to `port=null` when no upstream port is known; `open()`
     *  closes the client immediately rather than connecting to a guess. */
    upgradeData(req: Request): WsProxyData {
      const url = new URL(req.url);
      const port = getDevPort();
      const protoHeader = req.headers.get("sec-websocket-protocol");
      const protocols = protoHeader
        ? protoHeader
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      return {
        port,
        pathQuery: `${url.pathname}${url.search}`,
        protocols,
        upstream: null,
        pending: [],
      };
    },

    open(ws: ServerWebSocket<WsProxyData>): void {
      if (ws.data.port === null) {
        try {
          ws.close(1011, "no upstream dev server");
        } catch {}
        return;
      }
      void connectUpstream(ws);
    },

    message(ws: ServerWebSocket<WsProxyData>, message: string | Buffer): void {
      opts.onClientMessage?.();
      const upstream = ws.data.upstream;
      if (upstream && !upstream.destroyed) {
        try {
          upstream.write(encodeFrame(message, /* isClient */ true));
        } catch {}
        return;
      }
      if (ws.data.pending.length >= MAX_PENDING_FRAMES) {
        // Backlog overflow: upstream isn't draining. 1011 = internal error.
        try {
          ws.close(1011, "ws-proxy backlog overflow");
        } catch {}
        try {
          ws.data.upstream?.end();
        } catch {}
        return;
      }
      ws.data.pending.push(message as ArrayBuffer | string);
    },

    close(ws: ServerWebSocket<WsProxyData>): void {
      const sock = ws.data.upstream;
      if (!sock || sock.destroyed) return;
      try {
        sock.write(encodeFrame(Buffer.alloc(0), true, /* opcode */ 0x8)); // close frame
      } catch {}
      try {
        sock.end();
      } catch {}
    },
  };
}

export type WsUpgrader = ReturnType<typeof makeWsUpgrader>;

async function connectUpstream(
  ws: ServerWebSocket<WsProxyData>,
): Promise<void> {
  const port = ws.data.port;
  if (port === null) return;
  const host = await pickLoopback(port);
  if (host === null) {
    try {
      ws.close(1011, "upstream not reachable");
    } catch {}
    return;
  }
  const wsKey = randomBytes(16).toString("base64");
  const headers: Record<string, string> = {
    Host: `${bracketHost(host)}:${port}`,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": wsKey,
    "Sec-WebSocket-Version": "13",
  };
  if (ws.data.protocols && ws.data.protocols.length > 0) {
    headers["Sec-WebSocket-Protocol"] = ws.data.protocols.join(", ");
  }
  const req = httpRequest({
    host,
    port,
    path: ws.data.pathQuery,
    method: "GET",
    headers,
  });
  req.on("error", () => {
    try {
      ws.close();
    } catch {}
  });
  req.on("response", () => {
    // Vite refused the upgrade — close the client.
    try {
      ws.close();
    } catch {}
  });
  req.on("upgrade", (_res, socket) => {
    ws.data.upstream = socket;
    // Server frames (upstream → client) are never masked. Decode and forward.
    const decoder = createFrameDecoder((opcode, payload) => {
      try {
        if (opcode === 0x1) {
          ws.send(payload.toString("utf8"));
        } else if (opcode === 0x2) {
          ws.send(payload);
        } else if (opcode === 0x8) {
          // close
          try {
            ws.close();
          } catch {}
        }
        // ping/pong: Bun.serve handles its side; ignore upstream's.
      } catch {}
    });
    socket.on("data", (chunk: Buffer) => decoder(chunk));
    socket.on("close", () => {
      try {
        ws.close();
      } catch {}
    });
    socket.on("error", () => {
      try {
        ws.close();
      } catch {}
    });
    // Flush any frames that arrived from the client before handshake completed.
    for (const frame of ws.data.pending) {
      try {
        socket.write(encodeFrame(frame, true));
      } catch {}
    }
    ws.data.pending.length = 0;
  });
  req.end();
}

/**
 * Encode a WebSocket data frame. `isClient=true` masks the payload (required
 * for client→server frames per RFC 6455 §5.3). Default opcode is text/binary
 * derived from the payload type; pass `opcode` to override (e.g. 0x8 for close).
 */
function encodeFrame(
  payload: string | Buffer | ArrayBuffer | Uint8Array,
  isClient: boolean,
  opcode?: number,
): Buffer {
  let payloadBuf: Buffer;
  let inferredOpcode: number;
  if (typeof payload === "string") {
    payloadBuf = Buffer.from(payload, "utf8");
    inferredOpcode = 0x1;
  } else if (payload instanceof ArrayBuffer) {
    payloadBuf = Buffer.from(payload);
    inferredOpcode = 0x2;
  } else if (Buffer.isBuffer(payload)) {
    payloadBuf = payload;
    inferredOpcode = 0x2;
  } else {
    payloadBuf = Buffer.from(payload as Uint8Array);
    inferredOpcode = 0x2;
  }
  const op = opcode ?? inferredOpcode;
  const len = payloadBuf.length;

  const header: number[] = [];
  header.push(0x80 | (op & 0x0f)); // FIN=1, opcode

  const maskBit = isClient ? 0x80 : 0x00;
  if (len < 126) {
    header.push(maskBit | len);
  } else if (len < 65536) {
    header.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  } else {
    // 64-bit length. JS integers are safe up to 2^53; high 32 bits are 0
    // for any payload size we'll ever see.
    header.push(maskBit | 127, 0, 0, 0, 0);
    header.push(
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
    );
  }

  if (isClient) {
    const mask = randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i & 3];
    return Buffer.concat([Buffer.from(header), mask, masked]);
  }
  return Buffer.concat([Buffer.from(header), payloadBuf]);
}

/**
 * Stateful WS frame decoder for incoming server frames (unmasked). Returns a
 * function that takes a chunk of bytes and invokes `onFrame` once per complete
 * frame. Buffers partial frames across chunks.
 *
 * Only handles non-fragmented frames in practice — Vite's HMR sends each
 * message as a single frame with FIN=1. Continuation frames would be dropped
 * (good enough for the use case; HMR doesn't use them).
 */
function createFrameDecoder(
  onFrame: (opcode: number, payload: Buffer) => void,
): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = (buf[offset] << 8) | buf[offset + 1];
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        // Skip high 32 bits (must be 0 for any realistic payload).
        const lo =
          buf[offset + 4] * 0x1000000 +
          ((buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7]);
        payloadLen = lo;
        offset += 8;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + payloadLen) return;
      let payload = buf.subarray(offset, offset + payloadLen);
      if (maskKey) {
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++)
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        payload = unmasked;
      }
      buf = buf.subarray(offset + payloadLen);
      onFrame(opcode, payload);
    }
  };
}
