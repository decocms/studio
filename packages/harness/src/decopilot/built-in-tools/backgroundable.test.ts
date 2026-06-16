import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import {
  type BackgroundDispatcher,
  makeBackgroundable,
} from "./backgroundable";

function makeInnerTool(executeReturn: unknown) {
  return tool({
    description: "inner",
    inputSchema: z.object({ prompt: z.string() }),
    execute: async () => executeReturn,
  });
}

type Exec = (
  input: unknown,
  options: { toolCallId: string },
) => Promise<Record<string, unknown>>;

describe("makeBackgroundable", () => {
  test("returns the inline tool unchanged when no dispatcher", () => {
    const inner = makeInnerTool({ ok: true });
    expect(makeBackgroundable("generate_image", inner, null)).toBe(inner);
    expect(makeBackgroundable("generate_image", inner, undefined)).toBe(inner);
  });

  test("enqueues a job and returns a started handle (does not run inner)", async () => {
    let innerRan = false;
    const inner = tool({
      description: "inner",
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => {
        innerRan = true;
        return { ok: true };
      },
    });

    const calls: Array<{
      toolName: string;
      input: unknown;
      toolCallId: string;
    }> = [];
    const dispatcher: BackgroundDispatcher = {
      start: async (req) => {
        calls.push(req);
        return { jobId: "job-123" };
      },
    };

    const wrapped = makeBackgroundable("generate_image", inner, dispatcher);
    const exec = (wrapped as unknown as { execute: Exec }).execute;
    const out = await exec({ prompt: "a cat" }, { toolCallId: "call-abc" });

    expect(innerRan).toBe(false);
    expect(out.background).toBe(true);
    expect(out.status).toBe("started");
    expect(out.jobId).toBe("job-123");
    expect(typeof out.note).toBe("string");
    expect(calls).toEqual([
      {
        toolName: "generate_image",
        input: { prompt: "a cat" },
        toolCallId: "call-abc",
      },
    ]);
  });

  test("propagates dispatcher errors", async () => {
    const dispatcher: BackgroundDispatcher = {
      start: async () => {
        throw new Error("queue down");
      },
    };
    const wrapped = makeBackgroundable(
      "generate_image",
      makeInnerTool({ ok: true }),
      dispatcher,
    );
    const exec = (wrapped as unknown as { execute: Exec }).execute;
    await expect(exec({ prompt: "x" }, { toolCallId: "c" })).rejects.toThrow(
      "queue down",
    );
  });
});
