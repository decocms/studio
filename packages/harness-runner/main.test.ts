/**
 * Black-box test of the runner wire (`main.ts`) — the contract
 * `daemon-go/internal/dispatch/runner.go` depends on. Spawns the real process,
 * so a change to the stdin envelope or the result on stdout fails here instead
 * of in a pod.
 *
 * Deliberately does not exercise a real turn: that needs the `claude` CLI and a
 * live model.
 */

import { describe, expect, test } from "bun:test";

/** Run the real entry point with `body` on stdin and parse its result. */
async function run(body: string): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", `${import.meta.dir}/main.ts`], {
    stdin: new TextEncoder().encode(body),
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("harness-runner wire", () => {
  test("an unknown harness is a result with an error, not a crash", async () => {
    expect(
      await run(JSON.stringify({ harnessId: "codex", input: {} })),
    ).toEqual({
      chunks: [],
      error: { code: "unknown_harness", message: expect.any(String) },
    });
  });

  test("malformed stdin is bad_input", async () => {
    const result = await run("{not json");
    expect(result.chunks).toEqual([]);
    expect(result.error).toMatchObject({ code: "bad_input" });
  });

  test("a missing input is bad_input", async () => {
    const result = await run(JSON.stringify({ harnessId: "claude-code" }));
    expect(result.error).toMatchObject({ code: "bad_input" });
  });
});
