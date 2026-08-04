import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { harnessRunResultSchema } from "@decocms/sandbox/dispatch/schemas";
import {
  dispatchWithContinuation,
  harnessRunsInSandbox,
  isUnreachableStatus,
  ndjsonLines,
  SandboxUnreachableError,
} from "./sandbox-dispatch-client";

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("harnessRunsInSandbox", () => {
  test("claude-code is sandbox-hosted", () => {
    expect(harnessRunsInSandbox("claude-code")).toBe(true);
  });

  test("decopilot is not — it runs in-process", () => {
    expect(harnessRunsInSandbox("decopilot")).toBe(false);
  });
});

describe("the dispatch result wire", () => {
  test("a clean run parses to chunks and no error", () => {
    const parsed = harnessRunResultSchema.parse({
      chunks: [{ type: "start" }, { type: "finish" }],
      error: null,
    });
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.error).toBeNull();
  });

  test("a crash carries its partial chunks alongside the error", () => {
    const parsed = harnessRunResultSchema.parse({
      chunks: [{ type: "start" }],
      error: { code: "harness_crashed", message: "boom" },
    });
    expect(parsed.chunks).toEqual([{ type: "start" }]);
    expect(parsed.error).toEqual({ code: "harness_crashed", message: "boom" });
  });

  test("a missing error field is the same as none", () => {
    expect(harnessRunResultSchema.parse({ chunks: [] }).error).toBeNull();
  });

  test("a body without chunks is malformed, not an empty run", () => {
    // The client throws on this rather than recording a silent success.
    expect(harnessRunResultSchema.safeParse({ error: null }).success).toBe(
      false,
    );
    expect(harnessRunResultSchema.safeParse(null).success).toBe(false);
  });

  test("keepalive whitespace before the body stays parseable", () => {
    // The daemon pads a quiet run with newlines so the transport doesn't hang
    // up; `res.json()` has to skip them without any framing.
    expect(
      harnessRunResultSchema.parse(
        JSON.parse('\n\n\n{"chunks":[],"error":null}'),
      ).chunks,
    ).toEqual([]);
  });

  test("`done` marks the run's last frame, and defaults to false", () => {
    // The client tells "the run ended" from "the pod vanished mid-turn" by this
    // flag alone, so an absent one must never read as a finished run.
    expect(harnessRunResultSchema.parse({ chunks: [], done: true }).done).toBe(
      true,
    );
    expect(harnessRunResultSchema.parse({ chunks: [] }).done).toBe(false);
  });
});

describe("ndjsonLines", () => {
  test("a corrupt line throws a clear error instead of a bare SyntaxError", async () => {
    const seen: unknown[] = [];
    let thrown: unknown;
    try {
      for await (const line of ndjsonLines(
        bodyOf('{"chunks":[]}\nnot json\n'),
      )) {
        seen.push(line);
      }
    } catch (err) {
      thrown = err;
    }
    expect(seen).toEqual([{ chunks: [] }]);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/non-JSON line/);
  });
});

describe("isUnreachableStatus", () => {
  test("404/410/5xx are the pod being gone", () => {
    // 404: the proxy found no sandbox. 410: the claim was reaped.
    for (const status of [404, 410, 500, 502, 503]) {
      expect(isUnreachableStatus(status)).toBe(true);
    }
  });

  test("the daemon's own rejections are not", () => {
    // These fail the same way on a fresh pod, so continuing there just burns a
    // boot and a model turn.
    for (const status of [400, 401, 403, 409]) {
      expect(isUnreachableStatus(status)).toBe(false);
    }
  });
});

describe("dispatchWithContinuation", () => {
  const chunk = (type: string, extra: Record<string, unknown> = {}) =>
    ({ type, ...extra }) as UIMessageChunk;

  /** A dispatch that streams `chunks`, then optionally dies. */
  const dispatch = (chunks: UIMessageChunk[], err?: Error) =>
    async function* () {
      for (const c of chunks) yield c;
      if (err) throw err;
    };

  const collect = async (it: AsyncIterable<UIMessageChunk>) => {
    const out: UIMessageChunk[] = [];
    for await (const c of it) out.push(c);
    return out;
  };

  test("a healthy dispatch is forwarded verbatim", async () => {
    const seen: Array<{ reason: string } | null> = [];
    const chunks = await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: null,
        aborted: () => false,
        dispatchOnce: (resume) => {
          seen.push(resume);
          return dispatch([chunk("start"), chunk("finish")])();
        },
      }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
    expect(seen).toEqual([null]);
  });

  test("a lost sandbox continues the turn: partial work kept, resume passed, second `start` dropped", async () => {
    const resumes: Array<{ reason: string } | null> = [];
    let attempt = 0;
    const chunks = await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: null,
        aborted: () => false,
        dispatchOnce: (resume) => {
          resumes.push(resume);
          attempt++;
          return attempt === 1
            ? dispatch(
                [chunk("start", { messageId: "msg_a" }), chunk("text-delta")],
                new SandboxUnreachableError("pod gone"),
              )()
            : dispatch([
                chunk("start", { messageId: "msg_b" }),
                chunk("text-delta"),
                chunk("finish"),
              ])();
        },
      }),
    );
    // The interrupted attempt's chunks reach the projector, then the
    // continuation extends the SAME message — its `start` (which would re-id
    // that message) is dropped.
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-delta",
      "text-delta",
      "finish",
    ]);
    expect((chunks[0] as { messageId?: string }).messageId).toBe("msg_a");
    // The second dispatch is told it is continuing, and why.
    expect(resumes[0]).toBeNull();
    expect(resumes[1]?.reason).toContain("pod gone");
  });

  test("a caller-supplied resume drops the harness's first `start` too", async () => {
    // The run already streamed on another pod, so this dispatch's `start` would
    // re-id a message the projector has written parts for.
    const chunks = await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: { reason: "the previous studio process stopped" },
        aborted: () => false,
        dispatchOnce: () =>
          dispatch([chunk("start"), chunk("text-delta"), chunk("finish")])(),
      }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["text-delta", "finish"]);
  });

  test("a harness failure is NOT continued — that turn already reported its terminal", async () => {
    let attempts = 0;
    const run = dispatchWithContinuation({
      runId: "run_1",
      resume: null,
      aborted: () => false,
      dispatchOnce: () => {
        attempts++;
        return dispatch([chunk("start")], new Error("harness_crashed: boom"))();
      },
    });
    await expect(collect(run)).rejects.toThrow("harness_crashed");
    expect(attempts).toBe(1);
  });

  test("an aborted run is not continued", async () => {
    let attempts = 0;
    const run = dispatchWithContinuation({
      runId: "run_1",
      resume: null,
      aborted: () => true,
      dispatchOnce: () => {
        attempts++;
        return dispatch([], new SandboxUnreachableError("pod gone"))();
      },
    });
    await expect(collect(run)).rejects.toThrow("pod gone");
    expect(attempts).toBe(1);
  });

  test("a sandbox that keeps dying fails the run instead of looping", async () => {
    let attempts = 0;
    const run = dispatchWithContinuation({
      runId: "run_1",
      resume: null,
      aborted: () => false,
      maxAttempts: 2,
      dispatchOnce: () => {
        attempts++;
        return dispatch([], new SandboxUnreachableError("pod gone again"))();
      },
    });
    await expect(collect(run)).rejects.toThrow("pod gone again");
    expect(attempts).toBe(2);
  });
});
