/**
 * Raw WebSocket upstream bridge for Bun.serve reverse proxies.
 *
 * Bun.serve already accepts and decodes the client side for us. The upstream
 * side deliberately uses a Node TCP socket instead of Bun's global
 * `WebSocket`: Bun's WebSocket client can close its TCP socket with RST, which
 * trips Node 24-based dev servers such as Vite. Writing the HTTP upgrade by
 * hand gives us the raw socket so normal Node FIN semantics are used on close.
 */
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { ServerWebSocket } from "bun";
import { bracketHost, pickLoopback } from "./loopback";

const DEFAULT_MAX_PENDING_FRAMES = 256;
type ByteBuffer = Buffer<ArrayBufferLike>;

export interface NodeWebSocketProxyData {
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

export interface NodeWebSocketProxyOptions {
  maxPendingFrames?: number;
  noUpstreamReason?: string;
  unreachableReason?: string;
  backlogOverflowReason?: string;
  upstreamErrorReason?: string;
  onClientMessage?: () => void;
}

export function createNodeWebSocketProxyData(
  input: Pick<NodeWebSocketProxyData, "port" | "pathQuery" | "protocols">,
): NodeWebSocketProxyData {
  return {
    port: input.port,
    pathQuery: input.pathQuery,
    protocols: input.protocols,
    upstream: null,
    pending: [],
  };
}

export function createNodeWebSocketProxy<TData extends NodeWebSocketProxyData>(
  opts: NodeWebSocketProxyOptions = {},
) {
  const maxPendingFrames = opts.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
  const noUpstreamReason = opts.noUpstreamReason ?? "no upstream dev server";
  const unreachableReason = opts.unreachableReason ?? "upstream not reachable";
  const backlogOverflowReason =
    opts.backlogOverflowReason ?? "ws-proxy backlog overflow";
  const upstreamErrorReason = opts.upstreamErrorReason ?? "upstream error";

  return {
    open(ws: ServerWebSocket<TData>): void {
      if (ws.data.port === null) {
        closeClient(ws, 1011, noUpstreamReason);
        return;
      }
      void connectUpstream(ws, {
        unreachableReason,
        upstreamErrorReason,
      });
    },

    message(ws: ServerWebSocket<TData>, message: string | Buffer): void {
      opts.onClientMessage?.();
      const upstream = ws.data.upstream;
      if (upstream && !upstream.destroyed) {
        try {
          upstream.write(encodeFrame(message, /* isClient */ true));
        } catch {}
        return;
      }
      if (ws.data.pending.length >= maxPendingFrames) {
        closeClient(ws, 1011, backlogOverflowReason);
        try {
          ws.data.upstream?.end();
        } catch {}
        return;
      }
      ws.data.pending.push(message as ArrayBuffer | string);
    },

    close(ws: ServerWebSocket<TData>): void {
      const sock = ws.data.upstream;
      if (!sock || sock.destroyed) return;
      try {
        sock.write(encodeFrame(Buffer.alloc(0), true, /* opcode */ 0x8));
      } catch {}
      try {
        sock.end();
      } catch {}
    },
  };
}

async function connectUpstream<TData extends NodeWebSocketProxyData>(
  ws: ServerWebSocket<TData>,
  opts: {
    unreachableReason: string;
    upstreamErrorReason: string;
  },
): Promise<void> {
  const port = ws.data.port;
  if (port === null) return;
  const host = await pickLoopback(port);
  if (host === null) {
    closeClient(ws, 1011, opts.unreachableReason);
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
  const socket = connect({
    host,
    port,
  });
  let responseBuffer: ByteBuffer = Buffer.alloc(0);
  let upgraded = false;

  socket.on("connect", () => {
    socket.write(formatUpgradeRequest(ws.data.pathQuery, headers));
  });
  socket.on("error", () => {
    closeClient(ws, 1011, opts.upstreamErrorReason);
  });
  socket.on("close", () => {
    closeClient(ws);
  });
  socket.on("data", (chunk: ByteBuffer) => {
    if (upgraded) return;
    responseBuffer =
      responseBuffer.length === 0
        ? chunk
        : Buffer.concat([responseBuffer, chunk]);
    const headerEnd = responseBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const headerBlock = responseBuffer.subarray(0, headerEnd).toString("utf8");
    const head = responseBuffer.subarray(headerEnd + 4);
    const statusLine = headerBlock.split("\r\n", 1)[0] ?? "";
    if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(statusLine)) {
      closeClient(ws, 1011, opts.upstreamErrorReason);
      try {
        socket.end();
      } catch {}
      return;
    }
    upgraded = true;
    ws.data.upstream = socket;
    const decoder = createFrameDecoder((opcode, payload) => {
      try {
        if (opcode === 0x1) {
          ws.send(payload.toString("utf8"));
        } else if (opcode === 0x2) {
          ws.send(payload);
        } else if (opcode === 0x8) {
          const { code, reason } = decodeClosePayload(payload);
          closeClient(ws, code, reason);
          try {
            socket.end();
          } catch {}
        }
      } catch {}
    });
    socket.removeAllListeners("data");
    if (head.length > 0) decoder(head);
    socket.on("data", (chunk: ByteBuffer) => decoder(chunk));
    for (const frame of ws.data.pending) {
      try {
        socket.write(encodeFrame(frame, true));
      } catch {}
    }
    ws.data.pending.length = 0;
  });
}

function formatUpgradeRequest(
  pathQuery: string,
  headers: Record<string, string>,
): string {
  const lines = [`GET ${pathQuery} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return lines.join("\r\n");
}

function closeClient<TData>(
  ws: ServerWebSocket<TData>,
  code?: number,
  reason?: string,
): void {
  try {
    if (code !== undefined) {
      ws.close(code, reason ?? "");
    } else {
      ws.close();
    }
  } catch {}
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
): ByteBuffer {
  let payloadBuf: ByteBuffer;
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
  header.push(0x80 | (op & 0x0f));

  const maskBit = isClient ? 0x80 : 0x00;
  if (len < 126) {
    header.push(maskBit | len);
  } else if (len < 65536) {
    header.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  } else {
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
    for (let i = 0; i < len; i++) masked[i] = payloadBuf[i]! ^ mask[i & 3]!;
    return Buffer.concat([Buffer.from(header), mask, masked]);
  }
  return Buffer.concat([Buffer.from(header), payloadBuf]);
}

function decodeClosePayload(payload: ByteBuffer): {
  code: number;
  reason: string;
} {
  if (payload.length < 2) return { code: 1000, reason: "" };
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString("utf8"),
  };
}

/**
 * Stateful WS frame decoder for incoming server frames. Returns a function
 * that takes a chunk of bytes and invokes `onFrame` once per complete frame.
 * Buffers partial frames across chunks.
 *
 * Only handles non-fragmented frames in practice — Vite's HMR sends each
 * message as a single frame with FIN=1. Continuation frames would be dropped
 * (good enough for the use case; HMR doesn't use them).
 */
function createFrameDecoder(
  onFrame: (opcode: number, payload: ByteBuffer) => void,
): (chunk: ByteBuffer) => void {
  let buf: ByteBuffer = Buffer.alloc(0);
  return (chunk: ByteBuffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = (buf[offset]! << 8) | buf[offset + 1]!;
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        const lo =
          buf[offset + 4]! * 0x1000000 +
          ((buf[offset + 5]! << 16) |
            (buf[offset + 6]! << 8) |
            buf[offset + 7]!);
        payloadLen = lo;
        offset += 8;
      }
      let maskKey: ByteBuffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + payloadLen) return;
      let payload: ByteBuffer = buf.subarray(offset, offset + payloadLen);
      if (maskKey) {
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++)
          unmasked[i] = payload[i]! ^ maskKey[i & 3]!;
        payload = unmasked;
      }
      buf = buf.subarray(offset + payloadLen);
      onFrame(opcode, payload);
    }
  };
}
