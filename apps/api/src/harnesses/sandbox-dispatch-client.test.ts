import { describe, expect, test } from "bun:test";
import { harnessRunResultSchema } from "@decocms/sandbox/dispatch/schemas";
import { harnessRunsInSandbox } from "./sandbox-dispatch-client";

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
});
