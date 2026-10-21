import { describe, expect, test } from "bun:test";
import { readCapped } from "./product-photo";

function streamingResponse(chunkBytes: number, chunkCount: number): Response {
  const chunk = new Uint8Array(chunkBytes).fill(1);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
  return new Response(stream);
}

describe("readCapped", () => {
  test("reads a body under the cap in full", async () => {
    const res = streamingResponse(10, 3);
    const bytes = await readCapped(res, 100);
    expect(bytes?.byteLength).toBe(30);
  });

  test("stops and returns null once the body passes the cap, without buffering it all", async () => {
    // No content-length header at all — the case a declared-size check can't catch.
    const res = streamingResponse(1024, 100_000);
    const bytes = await readCapped(res, 2048);
    expect(bytes).toBeNull();
  });
});
