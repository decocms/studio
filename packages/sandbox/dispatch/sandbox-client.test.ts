import { describe, expect, test } from "bun:test";
import type {
  HarnessStreamInput,
  UIMessageChunk,
} from "@decocms/harness/types";
import type { SandboxClient } from "./sandbox-client";

describe("SandboxClient shape", () => {
  test("dispatch returns an AsyncIterable<UIMessageChunk>", async () => {
    const chunks: UIMessageChunk[] = [{ type: "start" } as UIMessageChunk];
    const client: SandboxClient = {
      dispatch(_input: HarnessStreamInput) {
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    };
    const out: UIMessageChunk[] = [];
    for await (const c of client.dispatch({} as HarnessStreamInput)) {
      out.push(c);
    }
    expect(out).toEqual(chunks);
  });
});
