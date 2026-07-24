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

  // --- flip-to-background (generator path) -------------------------------

  /** A generator inner tool: yields `step 1`, then blocks until its abort
   *  signal fires (simulating long-running work), recording the abort. */
  function makeGeneratorInnerTool(onAbort?: () => void) {
    return tool({
      description: "inner-gen",
      inputSchema: BASE,
      execute: async function* (
        _input: unknown,
        { abortSignal }: { abortSignal?: AbortSignal },
      ) {
        yield { text: "step 1" };
        await new Promise<void>((resolve) => {
          if (abortSignal?.aborted) return resolve();
          abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        onAbort?.();
        yield { text: "final", finishReason: "stop" };
      },
    });
  }

  /** A generator inner tool that completes on its own (no abort needed). */
  function makeSelfCompletingGenTool() {
    return tool({
      description: "inner-gen-simple",
      inputSchema: BASE,
      execute: async function* () {
        yield { text: "step 1" };
        yield { text: "final", finishReason: "stop" };
      },
    });
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  type GenExec = (
    input: unknown,
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ) => AsyncGenerator<Record<string, unknown>>;

  test("flip mid-stream aborts the inline run and returns a started handle", async () => {
    let aborted = false;
    const inner = makeGeneratorInnerTool(() => {
      aborted = true;
    });
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const dispatcher: BackgroundDispatcher = {
      start: async (req) => {
        calls.push({ toolName: req.toolName, input: req.input });
        return { jobId: "job-flip" };
      },
    };
    const flipCtl = deferred();
    let disposed = false;
    const wrapped = makeBackgroundable(
      "subtask",
      BASE,
      inner,
      dispatcher,
      () => ({ flipped: flipCtl.promise, dispose: () => (disposed = true) }),
    );
    const iter = (wrapped as unknown as { execute: GenExec }).execute(
      { prompt: "dig" },
      { toolCallId: "call-1" },
    );

    // First preview streams through untouched.
    expect((await iter.next()).value).toEqual({ text: "step 1" });

    // User flips: next pull should abort the inner and yield the started handle.
    flipCtl.resolve();
    const started = await iter.next();
    expect(started.value.status).toBe("started");
    expect(started.value.jobId).toBe("job-flip");
    expect((await iter.next()).done).toBe(true);

    // Re-ran as a durable job with `background`/flip stripped from the input.
    expect(calls).toEqual([{ toolName: "subtask", input: { prompt: "dig" } }]);
    expect(disposed).toBe(true);
    // The inline run was aborted (its teardown is fire-and-forget).
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
  });

  test("flip when the inner throws on abort (real subtask shape) still backgrounds cleanly", async () => {
    // The real subtask generator throws AbortError out of its stream loop when
    // aborted. The flip branch must swallow that (no unhandled rejection) and
    // still return the started handle.
    const inner = tool({
      description: "inner-gen-throw",
      inputSchema: BASE,
      execute: async function* (
        _input: unknown,
        { abortSignal }: { abortSignal?: AbortSignal },
      ) {
        yield { text: "step 1" };
        await new Promise<void>((_resolve, reject) => {
          if (abortSignal?.aborted) return reject(new Error("aborted"));
          abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        yield { text: "unreached" };
      },
    });
    const dispatcher: BackgroundDispatcher = {
      start: async () => ({ jobId: "job-throw" }),
    };
    const flipCtl = deferred();
    const wrapped = makeBackgroundable(
      "subtask",
      BASE,
      inner,
      dispatcher,
      () => ({
        flipped: flipCtl.promise,
        dispose: () => {},
      }),
    );
    const iter = (wrapped as unknown as { execute: GenExec }).execute(
      { prompt: "dig" },
      { toolCallId: "c" },
    );
    expect((await iter.next()).value).toEqual({ text: "step 1" });
    flipCtl.resolve();
    const started = await iter.next();
    expect(started.value.status).toBe("started");
    expect(started.value.jobId).toBe("job-throw");
    expect((await iter.next()).done).toBe(true);
    // Let the fire-and-forget teardown settle; no unhandled rejection should surface.
    await new Promise((r) => setTimeout(r, 0));
  });

  test("no flip: the generator runs to completion and never enqueues", async () => {
    const inner = makeSelfCompletingGenTool();
    let enqueued = false;
    const dispatcher: BackgroundDispatcher = {
      start: async () => {
        enqueued = true;
        return { jobId: "x" };
      },
    };
    // A flip subscriber is wired but never triggered.
    const flipCtl = deferred();
    let disposed = false;
    const wrapped = makeBackgroundable(
      "subtask",
      BASE,
      inner,
      dispatcher,
      () => ({ flipped: flipCtl.promise, dispose: () => (disposed = true) }),
    );
    const iter = (wrapped as unknown as { execute: GenExec }).execute(
      { prompt: "dig" },
      { toolCallId: "c" },
    );
    const seen: unknown[] = [];
    for await (const v of iter) seen.push(v);

    expect(seen).toEqual([
      { text: "step 1" },
      { text: "final", finishReason: "stop" },
    ]);
    expect(enqueued).toBe(false);
    expect(disposed).toBe(true);
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
