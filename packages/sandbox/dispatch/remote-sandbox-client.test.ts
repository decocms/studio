import { describe, expect, test } from "bun:test";
import type {
  HarnessStreamInput,
  UIMessageChunk,
} from "@decocms/harness/types";
import { RemoteSandboxClient } from "./remote-sandbox-client";

describe("RemoteSandboxClient", () => {
  test("dispatch yields the relayed chunks byte-identically (no reframing)", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      { type: "text-delta", delta: "hi" } as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    const seen: HarnessStreamInput[] = [];
    const client = new RemoteSandboxClient({
      relay: (input) => {
        seen.push(input);
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    });

    const out: UIMessageChunk[] = [];
    const input = { threadId: "t1" } as HarnessStreamInput;
    for await (const c of client.dispatch(input)) out.push(c);

    expect(out).toEqual(chunks); // same references, no adapter
    expect(seen).toEqual([input]); // input forwarded verbatim
  });

  test("getPreviewUrl delegates, defaulting to null when no dep is supplied", async () => {
    const withUrl = new RemoteSandboxClient({
      relay: () => (async function* () {})(),
      getPreviewUrl: async () => "https://preview.example",
    });
    const withoutUrl = new RemoteSandboxClient({
      relay: () => (async function* () {})(),
    });
    expect(await withUrl.getPreviewUrl()).toBe("https://preview.example");
    expect(await withoutUrl.getPreviewUrl()).toBeNull();
  });
});
