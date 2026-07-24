/**
 * DispatchChunk encoding invariant.
 *
 * The provider's `runner.ts` consumes base64 `DispatchChunk.data` frames from
 * the link transport. This test drives DispatchChunk streams through the real
 * `proxyDaemonRequest` and asserts the response body bytes equal the original
 * raw payload, including non-UTF-8 bytes (0x80, 0xff). It also exercises the
 * carry-buffer path: a base64 string split mid-group still reassembles to the
 * exact bytes.
 */
import { describe, expect, it } from "bun:test";
import { DesktopSandboxProvider } from "./runner";

// Minimal structural mirror of the dispatch contract the runner consumes — kept
// local so this provider-package test doesn't reach into an application tree.
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
// 0xff = invalid lead) plus ASCII + a NUL.
const RAW = new Uint8Array([
  0x41, 0x42, 0x00, 0x80, 0xff, 0xfe, 0x7f, 0x10, 0xc3, 0x28,
]);

/** Daemon-side encoding of a raw chunk. */
function chunkData(bytes: Uint8Array): string {
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

describe("DispatchChunk encoding invariant", () => {
  it("runner decodes the base64 stream back to the exact bytes", async () => {
    const chunks: DispatchChunk[] = [
      { headers: { status: 200, headers: { "content-type": "x" } } },
      { data: chunkData(RAW) },
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
    const full = chunkData(RAW);
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
    const full = chunkData(RAW);
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
      { data: chunkData(part1) },
      { data: chunkData(part2) },
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
