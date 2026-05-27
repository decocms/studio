/**
 * runAgentLoop tests — shared core for parent + subagent.
 */

import { describe, expect, test } from "bun:test";
import { runAgentLoop, type RunAgentLoopOptions } from "./run-agent-loop";

describe("runAgentLoop", () => {
  test("rejects when kind is 'subagent' (Stage 1 stub)", async () => {
    const fakeOpts = {
      kind: "subagent",
    } as RunAgentLoopOptions;

    // runAgentLoop is async from the start so the Stage 1 → Stage 2
    // transition doesn't change call-site shape (no sync→async break).
    await expect(runAgentLoop(fakeOpts)).rejects.toThrow(
      /not yet implemented in Stage 1/,
    );
  });

  test("exports the expected types", () => {
    // Type-check at compile time. If this compiles, types are exported.
    const opts: Partial<RunAgentLoopOptions> = { kind: "agent" };
    expect(opts.kind).toBe("agent");
  });
});
