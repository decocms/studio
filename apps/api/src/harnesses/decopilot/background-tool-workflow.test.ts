import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHostedDecopilotThread } from "./background-tool-workflow";

describe("isHostedDecopilotThread", () => {
  test("accepts current and legacy hosted Decopilot pins", () => {
    expect(
      isHostedDecopilotThread({
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
      }),
    ).toBe(true);
    expect(
      isHostedDecopilotThread({
        harness_id: "decopilot",
        sandbox_provider_kind: null,
      }),
    ).toBe(true);
  });

  test("rejects unpinned, native, retired, and unknown runtimes", () => {
    for (const thread of [
      null,
      { harness_id: null, sandbox_provider_kind: null },
      { harness_id: "codex", sandbox_provider_kind: "user-desktop" },
      { harness_id: "future", sandbox_provider_kind: null },
      { harness_id: "decopilot", sandbox_provider_kind: "user-desktop" },
      { harness_id: "decopilot" },
    ]) {
      expect(isHostedDecopilotThread(thread)).toBe(false);
    }
  });
});

describe("backgroundToolWorkflow runtime boundary", () => {
  const source = readFileSync(
    join(import.meta.dir, "background-tool-workflow.ts"),
    "utf8",
  );

  test("validates the persisted hosted runtime before selecting a producer", () => {
    const workflowStart = source.indexOf(
      "async function backgroundToolWorkflowFn(",
    );
    const guard = source.indexOf(
      '{ name: "validateHostedThread" }',
      workflowStart,
    );
    const producer = source.indexOf(
      "const producer = PRODUCERS[ctx.toolName]",
      workflowStart,
    );

    expect(workflowStart).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(workflowStart);
    expect(producer).toBeGreaterThan(guard);
  });

  test("rechecks the hosted runtime inside the recorded append step", () => {
    const appendStart = source.indexOf("async function appendPartsStep(");
    const appendEnd = source.indexOf(
      "async function resolveReactionTargetStep(",
      appendStart,
    );
    const appendBody = source.slice(appendStart, appendEnd);

    expect(appendStart).toBeGreaterThan(-1);
    expect(appendEnd).toBeGreaterThan(appendStart);
    expect(appendBody).toContain("await requireHostedThreadContext(ctx)");
  });
});
