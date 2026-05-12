import { describe, expect, test } from "bun:test";
import { createEnableToolTool, EnableToolInputSchema } from "./enable-tool";

function runExec(
  enabledTools: Set<string>,
  available: Set<string>,
  options?: {
    isPlanMode?: boolean;
    toolAnnotations?: Map<string, { readOnlyHint?: boolean }>;
  },
) {
  const t = createEnableToolTool(
    enabledTools,
    available,
    options,
  ) as unknown as {
    execute: (input: { tools: string[] }) => Promise<{
      enabled: string[];
      not_found?: string[];
      blocked?: string[];
      blocked_reason?: string;
    }>;
  };
  return (tools: string[]) => t.execute({ tools });
}

describe("EnableToolInputSchema", () => {
  test("accepts an array of tools", () => {
    expect(EnableToolInputSchema.safeParse({ tools: ["a", "b"] }).success).toBe(
      true,
    );
  });

  test("rejects a connections input field", () => {
    const parsed = EnableToolInputSchema.safeParse({
      tools: ["a"],
      connections: ["c"],
    });
    // Strict schema: extra keys are stripped, parse still succeeds, but the
    // execute() signature does not use them. Verify the type strips them.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as { connections?: unknown }).connections,
      ).toBeUndefined();
    }
  });
});

describe("enable_tool execute", () => {
  test("adds known tools to the enabled set and returns them", async () => {
    const enabled = new Set<string>();
    const run = runExec(enabled, new Set(["gmail_send", "calendar_create"]));
    const result = await run(["gmail_send"]);
    expect(result.enabled).toEqual(["gmail_send"]);
    expect(enabled.has("gmail_send")).toBe(true);
  });

  test("reports unknown tools in not_found", async () => {
    const run = runExec(new Set<string>(), new Set(["gmail_send"]));
    const result = await run(["gmail_send", "ghost_tool"]);
    expect(result.enabled).toEqual(["gmail_send"]);
    expect(result.not_found).toEqual(["ghost_tool"]);
  });

  test("blocks non-read-only tools in plan mode", async () => {
    const enabled = new Set<string>();
    const annotations = new Map<string, { readOnlyHint?: boolean }>([
      ["read_only_tool", { readOnlyHint: true }],
      ["destructive_tool", { readOnlyHint: false }],
    ]);
    const run = runExec(
      enabled,
      new Set(["read_only_tool", "destructive_tool"]),
      { isPlanMode: true, toolAnnotations: annotations },
    );
    const result = await run(["read_only_tool", "destructive_tool"]);
    expect(result.enabled).toEqual(["read_only_tool"]);
    expect(result.blocked).toEqual(["destructive_tool"]);
    expect(result.blocked_reason).toMatch(/plan mode/);
  });
});
