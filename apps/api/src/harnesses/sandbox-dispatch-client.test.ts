import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { harnessRunResultSchema } from "@decocms/sandbox/dispatch/schemas";
import {
  describeTermination,
  dispatchWithContinuation,
  errorForTerminal,
  harnessRunsInSandbox,
  isRunSuperseded,
  isUnreachableStatus,
  ndjsonLines,
  RunSupersededError,
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

  test("a socket closed mid-stream is unreachable, so the run continues", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"chunks":[]}\n'));
      },
      pull(controller) {
        controller.error(
          new Error("The socket connection was closed unexpectedly."),
        );
      },
    });
    const seen: unknown[] = [];
    let thrown: unknown;
    try {
      for await (const line of ndjsonLines(body)) seen.push(line);
    } catch (err) {
      thrown = err;
    }
    expect(seen).toEqual([{ chunks: [] }]);
    expect(thrown).toBeInstanceOf(SandboxUnreachableError);
  });

  test("a non-transport read failure stays terminal", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("unauthorized"));
      },
    });
    let thrown: unknown;
    try {
      for await (const _ of ndjsonLines(body)) void _;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SandboxUnreachableError);
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

  test("an attempt that died before streaming anything lets the continuation open the message", async () => {
    // Dropping this `start` too left the run with parts and no message: the
    // projector never opened one, so the turn rendered empty.
    let attempt = 0;
    const chunks = await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: null,
        aborted: () => false,
        dispatchOnce: () =>
          ++attempt === 1
            ? dispatch([], new SandboxUnreachableError("pod never answered"))()
            : dispatch([
                chunk("start", { messageId: "msg_b" }),
                chunk("finish"),
              ])(),
      }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
    expect((chunks[0] as { messageId?: string }).messageId).toBe("msg_b");
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

  // The budget is CONSECUTIVE no-progress failures. A run that streamed work
  // between two unrelated apiserver hangups is the case this exists for: the
  // old lifetime count failed it on the second break however long it had run.
  test("a dispatch that made progress resets the continuation budget", async () => {
    let attempts = 0;
    const chunks = await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: null,
        aborted: () => false,
        maxAttempts: 2,
        dispatchOnce: () => {
          attempts++;
          if (attempts === 3) return dispatch([chunk("finish")])();
          return dispatch(
            [chunk("start"), chunk("text-delta")],
            new SandboxUnreachableError("pod gone"),
          )();
        },
      }),
    );
    expect(attempts).toBe(3);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-delta",
      "text-delta",
      "finish",
    ]);
  });

  test("the total ceiling stops a pod that dies after every chunk", async () => {
    let attempts = 0;
    const run = dispatchWithContinuation({
      runId: "run_1",
      resume: null,
      aborted: () => false,
      maxAttempts: 2,
      maxTotalAttempts: 3,
      dispatchOnce: () => {
        attempts++;
        return dispatch(
          [chunk("text-delta")],
          new SandboxUnreachableError("pod gone yet again"),
        )();
      },
    });
    await expect(collect(run)).rejects.toThrow("pod gone yet again");
    expect(attempts).toBe(3);
  });

  // A displaced attempt must NOT continue: continuing re-dispatches the same
  // runId, which takes the run back off the successor that displaced us — the
  // two attempts would trade it back and forth until maxAttempts.
  test("a superseded attempt stops instead of taking the run back", async () => {
    let attempts = 0;
    const run = dispatchWithContinuation({
      runId: "run_1",
      resume: null,
      aborted: () => false,
      dispatchOnce: () => {
        attempts++;
        return dispatch(
          [chunk("start"), chunk("text-delta")],
          new RunSupersededError("a newer dispatch took over this run"),
        )();
      },
    });
    await expect(collect(run)).rejects.toThrow("a newer dispatch took over");
    expect(attempts).toBe(1);
  });
});

// Which terminal code continues the turn, which drops it quietly, and which
// fails it. `sandbox_gone` is the one that changed: the daemon reported an
// evicted pod as `cancelled`, so a turn nobody stopped was settled as a
// deliberate cancel and never retried.
describe("errorForTerminal", () => {
  test("a sandbox that could not finish is continuable, not a failure", () => {
    const err = errorForTerminal("sandbox_gone", "the sandbox stopped mid-run");
    expect(err).toBeInstanceOf(SandboxUnreachableError);
    expect(isRunSuperseded(err)).toBe(false);
  });

  test("a takeover stops this attempt quietly", () => {
    const err = errorForTerminal("superseded", "a newer dispatch took over");
    expect(isRunSuperseded(err)).toBe(true);
    expect(err).not.toBeInstanceOf(SandboxUnreachableError);
  });

  // A cancel a human asked for, and a harness that really crashed, are the
  // run's own outcome — continuing either would re-run work that already ended.
  test("a real terminal fails the run", () => {
    for (const code of ["cancelled", "harness_crashed", "bad_input"]) {
      const err = errorForTerminal(code, "why");
      expect(err).not.toBeInstanceOf(SandboxUnreachableError);
      expect(isRunSuperseded(err)).toBe(false);
      expect(err.message).toBe(`${code}: why`);
    }
  });
});

describe("isRunSuperseded", () => {
  test("recognizes a superseded attempt", () => {
    expect(isRunSuperseded(new RunSupersededError("taken over"))).toBe(true);
  });

  test("does not mistake other failures for a takeover", () => {
    expect(isRunSuperseded(new SandboxUnreachableError("pod gone"))).toBe(
      false,
    );
    expect(isRunSuperseded(new Error("cancelled: run cancelled"))).toBe(false);
    expect(isRunSuperseded(undefined)).toBe(false);
  });

  // The error is thrown from inside a DBOS step, which serializes it into the
  // durable journal and rebuilds a PLAIN Error on replay — the subclass is gone,
  // so `instanceof` silently reports false and the run gets failed after all.
  // Only an own-enumerable property survives that round trip.
  test("survives the DBOS step boundary, where the subclass does not", () => {
    const thrown = new RunSupersededError("taken over");
    const replayed = Object.assign(
      new Error(thrown.message),
      JSON.parse(JSON.stringify({ ...thrown })),
    );
    expect(replayed instanceof RunSupersededError).toBe(false);
    expect(isRunSuperseded(replayed)).toBe(true);
  });
});

describe("describeTermination", () => {
  test("an OOM kill names the limit, because that is the actionable part", () => {
    expect(
      describeTermination({
        reason: "OOMKilled",
        oomKilled: true,
        exitCode: 137,
        memoryLimit: "4Gi",
      }),
    ).toBe(
      "it was killed by the kernel for exceeding its memory limit (memory limit 4Gi) — OOMKilled",
    );
  });

  test("an OOM kill still reports without a known limit", () => {
    expect(
      describeTermination({ reason: "OOMKilled", oomKilled: true }),
    ).toContain("OOMKilled");
  });

  // Null is what makes the caller fall back to its unqualified message, so
  // "nothing to add" must never render as a sentence.
  test("nothing to add returns null, not a sentence", () => {
    expect(describeTermination(null)).toBeNull();
    expect(
      describeTermination({ reason: "Completed", oomKilled: false }),
    ).toBeNull();
  });

  test("any other termination reason is reported with its exit code", () => {
    expect(
      describeTermination({ reason: "Error", oomKilled: false, exitCode: 1 }),
    ).toBe("the sandbox container terminated with reason Error (exit code 1)");
  });
});

describe("a lost sandbox's cause reaches the agent and the thread", () => {
  test("the continuation is told it was an OOM, and what to do about it", async () => {
    const resumes: Array<{ reason: string } | null> = [];
    let attempt = 0;
    await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: null,
        aborted: () => false,
        lastHandle: () => "thread-abc",
        describeTermination: async (handle) =>
          handle === "thread-abc"
            ? "it was OOMKilled (memory limit 4Gi)"
            : null,
        dispatchOnce: (resume) => {
          resumes.push(resume);
          return ++attempt === 1
            ? dispatch([], new SandboxUnreachableError("stream broke"))()
            : dispatch([chunk("start"), chunk("finish")])();
        },
      }),
    );
    expect(resumes[1]?.reason).toContain("OOMKilled");
    expect(resumes[1]?.reason).toContain("memory limit 4Gi");
    // Without these the model re-runs the step that was killed, or reports
    // edits it only remembers making.
    expect(resumes[1]?.reason).toContain("re-read the files");
    expect(resumes[1]?.reason).toContain("split it");
  });

  test("the last attempt's failure carries the OOM into the run's error, exactly one prefix", async () => {
    let thrown: unknown;
    try {
      await collect(
        dispatchWithContinuation({
          runId: "run_1",
          resume: null,
          aborted: () => false,
          maxAttempts: 1,
          lastHandle: () => "thread-abc",
          describeTermination: async () =>
            "it was OOMKilled (memory limit 4Gi)",
          dispatchOnce: () =>
            dispatch([], new SandboxUnreachableError("stream broke"))(),
        }),
      );
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as Error).message;
    expect(message).toContain("stream broke");
    expect(message).toContain("OOMKilled");
    // The prefix is what marks the failure transient downstream; doubling it
    // would still match, but the user reads this string.
    expect(message.match(/\[SANDBOX_UNREACHABLE\]/g)).toHaveLength(1);
  });

  test("an unknowable termination leaves the message it already had", async () => {
    let thrown: unknown;
    try {
      await collect(
        dispatchWithContinuation({
          runId: "run_1",
          resume: null,
          aborted: () => false,
          maxAttempts: 1,
          lastHandle: () => "thread-abc",
          describeTermination: async () => null,
          dispatchOnce: () =>
            dispatch([], new SandboxUnreachableError("stream broke"))(),
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe(
      "[SANDBOX_UNREACHABLE] stream broke",
    );
  });

  test("a probe that throws never fails the run it was explaining", async () => {
    let attempt = 0;
    const chunks = await collect(
      dispatchWithContinuation({
        runId: "run_1",
        resume: null,
        aborted: () => false,
        lastHandle: () => "thread-abc",
        describeTermination: async () => {
          throw new Error("kube api down");
        },
        dispatchOnce: () =>
          ++attempt === 1
            ? dispatch([], new SandboxUnreachableError("stream broke"))()
            : dispatch([chunk("start"), chunk("finish")])(),
      }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
  });
});
