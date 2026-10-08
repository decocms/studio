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
  // Every case here is a rejection, and a rejection exits non-zero.
  expect(exitCode).not.toBe(0);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("harness-runner wire", () => {
  test.each([
    ["an unknown harness", { harnessId: "made-up", input: {} }],
    ["a missing harness", { input: {} }],
  ])("%s is an unknown_harness error frame", async (_, body) => {
    expect(await run(JSON.stringify(body))).toEqual({
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
    const result = await run("{}");
    expect(result.error).toMatchObject({ code: "bad_input" });
  });
});
