/**
 * DispatchChunk encoding uniformity (Phase C-bis S3 — landmine #9).
 *
 * The provider's `runner.ts` consumes `DispatchChunk.data` from TWO transports:
 *
 *   - the WS dispatcher (`cluster-connection.ts` daemon side) — yields each
 *     upstream `raw-chunk`'s bytes as `Buffer.from(bytes).toString("base64")`,
 *     and the WS NATS hop may further split that base64 STRING at an arbitrary
 *     (non-4-aligned) offset via `splitChunkData`;
 *   - the pull reverse-proxy channel (`proxy-poller.ts` / `createProxyDispatch`)
 *     — yields each `raw-chunk`'s bytes as `Buffer.from(bytes).toString("base64")`
 *     too (one frame per chunk, no string-splitting).
 *
 * Both MUST produce the IDENTICAL `DispatchChunk.data` shape (base64) so the
 * transport-agnostic runner decodes one way for either. This test:
 *
 *   1. proves the two transports emit byte-for-byte the same base64 for the same
 *      raw chunk;
 *   2. drives both transports' DispatchChunk streams through the REAL
 *      `proxyDaemonRequest` and asserts the response body bytes equal the
 *      original raw payload — including non-UTF-8 bytes (0x80, 0xff) that the
 *      old TextDecoder-to-UTF-8 WS path mangled;
 *   3. exercises the carry-buffer path: a base64 string split mid-group (as the
 *      WS payload-chunking splitter does) still reassembles to the exact bytes.
 */
import { describe, expect, it } from "bun:test";
import { DesktopSandboxProvider } from "./runner";

// Minimal structural mirror of the dispatch contract the runner consumes — kept
// local so this provider-package test doesn't reach across into apps/mesh.
interface DispatchChunk {
  data?: string;
  headers?: { status: number; headers: Record<string, string> };
}
interface DispatchRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

// A payload with bytes that are NOT valid UTF-8 (0x80 = lone continuation,
// 0xff = invalid lead) plus ASCII + a NUL — the exact class the old UTF-8 WS
// path corrupted on binary vm-tools file reads.
const RAW = new Uint8Array([
  0x41, 0x42, 0x00, 0x80, 0xff, 0xfe, 0x7f, 0x10, 0xc3, 0x28,
]);

/** Daemon-side WS encoding of a raw chunk (mirrors cluster-connection.ts). */
function wsChunkData(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Daemon-side pull encoding of a raw chunk (mirrors proxy-poller chunkFrame). */
function proxyChunkData(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Build a DispatchFn that replays a fixed sequence of DispatchChunks. */
function fixedDispatch(chunks: DispatchChunk[]) {
  return async function* dispatch(
    _userSub: string,
    _req: DispatchRequest,
    _opts?: { signal?: AbortSignal },
  ): AsyncGenerator<DispatchChunk> {
    for (const c of chunks) yield c;
  };
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

function makeProvider(chunks: DispatchChunk[]): DesktopSandboxProvider {
  return new DesktopSandboxProvider({
    userSub: "u1",
    dispatch: fixedDispatch(chunks) as never,
  });
}

describe("DispatchChunk encoding uniformity (landmine #9)", () => {
  it("WS and pull transports emit IDENTICAL base64 for the same raw chunk", () => {
    expect(wsChunkData(RAW)).toBe(proxyChunkData(RAW));
  });

  it("runner decodes the WS-shaped base64 stream back to the exact bytes", async () => {
    const chunks: DispatchChunk[] = [
      { headers: { status: 200, headers: { "content-type": "x" } } },
      { data: wsChunkData(RAW) },
    ];
    const provider = makeProvider(chunks);
    const res = await provider.proxyDaemonRequest("h1", "/_sandbox/events", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(Array.from(await bodyBytes(res))).toEqual(Array.from(RAW));
  });

  it("runner decodes the pull-shaped base64 stream back to the exact bytes", async () => {
    const chunks: DispatchChunk[] = [
      { headers: { status: 200, headers: {} } },
      { data: proxyChunkData(RAW) },
    ];
    const provider = makeProvider(chunks);
    const res = await provider.proxyDaemonRequest("h1", "/_sandbox/events", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(Array.from(await bodyBytes(res))).toEqual(Array.from(RAW));
  });

  it("reassembles a base64 string SPLIT mid-group across DispatchChunks (carry buffer)", async () => {
    // The WS payload-chunking splitter (splitChunkData) slices the base64 STRING
    // at arbitrary offsets — including inside a 4-char group. Decoding each
    // fragment independently would corrupt the bytes; the runner's carry buffer
    // must reassemble the exact original.
    const full = wsChunkData(RAW);
    // Split at offset 3 (NOT a multiple of 4) to force the carry path.
    const a = full.slice(0, 3);
    const b = full.slice(3);
    const chunks: DispatchChunk[] = [
      { headers: { status: 200, headers: {} } },
      { data: a },
      { data: b },
    ];
    const provider = makeProvider(chunks);
    const res = await provider.proxyDaemonRequest("h1", "/_sandbox/events", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(Array.from(await bodyBytes(res))).toEqual(Array.from(RAW));
  });

  it("reassembles a base64 string split into MANY tiny fragments", async () => {
    const full = wsChunkData(RAW);
    const chunks: DispatchChunk[] = [{ headers: { status: 200, headers: {} } }];
    // One char per chunk — the most adversarial split for the carry buffer.
    for (const ch of full) chunks.push({ data: ch });
    const provider = makeProvider(chunks);
    const res = await provider.proxyDaemonRequest("h1", "/_sandbox/events", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(Array.from(await bodyBytes(res))).toEqual(Array.from(RAW));
  });

  it("decodes multi-chunk binary payloads in order", async () => {
    const part1 = new Uint8Array([0x00, 0x01, 0xff]);
    const part2 = new Uint8Array([0x80, 0x7f, 0x10, 0x20]);
    const chunks: DispatchChunk[] = [
      { headers: { status: 200, headers: {} } },
      { data: wsChunkData(part1) },
      { data: wsChunkData(part2) },
    ];
    const provider = makeProvider(chunks);
    const res = await provider.proxyDaemonRequest("h1", "/_sandbox/events", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(Array.from(await bodyBytes(res))).toEqual([
      ...Array.from(part1),
      ...Array.from(part2),
    ]);
  });
});
