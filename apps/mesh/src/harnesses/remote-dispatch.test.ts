import { describe, expect, test } from "bun:test";
import { remoteDispatch } from "./remote-dispatch";
import type { DispatchChunk, DispatchFn } from "../links/dispatcher";

function makeStubDispatch(events: Array<Record<string, unknown>>): DispatchFn {
  return function dispatch(_userSub, req) {
    return {
      async *[Symbol.asyncIterator]() {
        expect(req.path).toMatch(/^\/_sandbox\/[^/]+\/dispatch$/);
        // The daemon reverse-proxies the sandbox's SSE response, so we ship
        // raw SSE bytes (one `data:` line per event, terminated by \n\n).
        for (const ev of events) {
          yield {
            data: `data: ${JSON.stringify(ev)}\n\n`,
          } as DispatchChunk;
        }
      },
    };
  };
}

describe("remoteDispatch (NATS-backed)", () => {
  test("yields ui-message-chunks", async () => {
    const dispatch = makeStubDispatch([
      { type: "ui-message-chunk", chunk: { id: "1" } },
      { type: "ui-message-chunk", chunk: { id: "2" } },
      { type: "done" },
    ]);
    const chunks: unknown[] = [];
    for await (const c of remoteDispatch(
      "claude-code",
      {
        runId: "run-1",
        agentMessages: [],
      } as never,
      "user-1",
      "abc",
      { dispatch },
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("throws on error event", async () => {
    const dispatch = makeStubDispatch([
      { type: "error", code: "X", message: "boom" },
    ]);
    await expect(async () => {
      for await (const _ of remoteDispatch(
        "codex",
        { runId: "r" } as never,
        "u",
        "abc",
        { dispatch },
      ));
    }).toThrow(/boom/);
  });
});
