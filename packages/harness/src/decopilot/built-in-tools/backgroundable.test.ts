import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import {
  type BackgroundDispatcher,
  makeBackgroundable,
} from "./backgroundable";

const BASE = z.object({ prompt: z.string() });

function makeInnerTool(executeReturn: unknown, onRun?: () => void) {
  return tool({
    description: "inner",
    inputSchema: BASE,
    execute: async () => {
      onRun?.();
      return executeReturn;
    },
  });
}

type Exec = (
  input: unknown,
  options: { toolCallId: string },
) => Promise<Record<string, unknown>>;

describe("makeBackgroundable", () => {
  test("returns the inline tool unchanged when no dispatcher", () => {
    const inner = makeInnerTool({ ok: true });
    expect(makeBackgroundable("generate_image", BASE, inner, null)).toBe(inner);
    expect(makeBackgroundable("generate_image", BASE, inner, undefined)).toBe(
      inner,
    );
  });

  test("background:true enqueues a job and returns a started handle (does not run inner)", async () => {
    let innerRan = false;
    const inner = makeInnerTool({ ok: true }, () => {
      innerRan = true;
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

    const wrapped = makeBackgroundable(
      "generate_image",
      BASE,
      inner,
      dispatcher,
    );
    const exec = (wrapped as unknown as { execute: Exec }).execute;
    const out = await exec(
      { prompt: "a cat", background: true },
      { toolCallId: "call-abc" },
    );

    expect(innerRan).toBe(false);
    expect(out.background).toBe(true);
    expect(out.status).toBe("started");
    expect(out.jobId).toBe("job-123");
    expect(typeof out.note).toBe("string");
    // `background` is stripped from the forwarded input.
    expect(calls).toEqual([
      {
        toolName: "generate_image",
        input: { prompt: "a cat" },
        toolCallId: "call-abc",
      },
    ]);
  });

  test("no background runs the inner tool inline (does not enqueue)", async () => {
    let innerRan = false;
    const inner = makeInnerTool({ ok: true }, () => {
      innerRan = true;
    });
    let enqueued = false;
    const dispatcher: BackgroundDispatcher = {
      start: async () => {
        enqueued = true;
        return { jobId: "x" };
      },
    };

    const wrapped = makeBackgroundable(
      "generate_image",
      BASE,
      inner,
      dispatcher,
    );
    const exec = (wrapped as unknown as { execute: Exec }).execute;
    const out = await exec({ prompt: "a cat" }, { toolCallId: "c" });

    expect(enqueued).toBe(false);
    expect(innerRan).toBe(true);
    expect(out).toEqual({ ok: true });
  });

  test("propagates dispatcher errors on background:true", async () => {
    const dispatcher: BackgroundDispatcher = {
      start: async () => {
        throw new Error("queue down");
      },
    };
    const wrapped = makeBackgroundable(
      "generate_image",
      BASE,
      makeInnerTool({ ok: true }),
      dispatcher,
    );
    const exec = (wrapped as unknown as { execute: Exec }).execute;
    await expect(
      exec({ prompt: "x", background: true }, { toolCallId: "c" }),
    ).rejects.toThrow("queue down");
  });
});
