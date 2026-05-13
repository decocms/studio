import { describe, expect, test } from "bun:test";
import type { Todo } from "./built-in-tools/todo-write";
import { buildBasePlatformPrompt } from "./constants";
import {
  buildCurrentContextPrompt,
  buildCurrentTodosPrompt,
  buildSystemMessages,
} from "./system-prompt";

describe("buildBasePlatformPrompt", () => {
  test("is byte-stable across calls (no embedded date)", () => {
    const a = buildBasePlatformPrompt();
    const b = buildBasePlatformPrompt();
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("buildCurrentContextPrompt", () => {
  test("returns an XML-tagged block containing the ISO date and UTC time", () => {
    const out = buildCurrentContextPrompt(new Date("2026-05-12T12:34:56Z"));
    expect(out).toContain("<current-context>");
    expect(out).toContain("Current date: 2026-05-12");
    expect(out).toContain("Current time: 12:34 UTC");
    expect(out).toContain("</current-context>");
  });

  test("two calls within the same minute produce byte-identical output", () => {
    expect(buildCurrentContextPrompt(new Date("2026-05-12T12:34:00Z"))).toBe(
      buildCurrentContextPrompt(new Date("2026-05-12T12:34:59Z")),
    );
  });
});

const FIXED_NOW = new Date("2026-05-12T12:00:00Z");

describe("buildSystemMessages", () => {
  test("preserves the order of input parts and appends current-context", () => {
    const out = buildSystemMessages(["A", "B", "C", "D"], FIXED_NOW);
    expect(out.map((m) => m.content.slice(0, 1))).toEqual([
      "A",
      "B",
      "C",
      "D",
      "<", // current-context starts with "<"
    ]);
    expect(out.every((m) => m.role === "system")).toBe(true);
  });

  test("attaches anthropic.cacheControl only on the last two parts (BP1, BP2)", () => {
    const out = buildSystemMessages(["A", "B", "C", "D"], FIXED_NOW);
    const cached = out.filter(
      (m) => m.providerOptions?.anthropic?.cacheControl?.type === "ephemeral",
    );
    expect(cached.map((m) => m.content)).toEqual(["C", "D"]);
  });

  test("cacheControl uses ttl=5m", () => {
    const out = buildSystemMessages(["A", "B", "C"], FIXED_NOW);
    const cached = out.filter(
      (m) => m.providerOptions?.anthropic?.cacheControl,
    );
    for (const m of cached) {
      expect(m.providerOptions!.anthropic!.cacheControl).toEqual({
        type: "ephemeral",
        ttl: "5m",
      });
    }
  });

  test("current-context tail is never cached", () => {
    const out = buildSystemMessages(["A", "B"], FIXED_NOW);
    const tail = out[out.length - 1]!;
    expect(tail.content).toContain("<current-context>");
    expect(tail.providerOptions?.anthropic?.cacheControl).toBeFalsy();
  });

  test("two consecutive calls with identical inputs produce identical JSON", () => {
    expect(
      JSON.stringify(buildSystemMessages(["A", "B", "C"], FIXED_NOW)),
    ).toBe(JSON.stringify(buildSystemMessages(["A", "B", "C"], FIXED_NOW)));
  });

  test("single-part input: only one cache marker (BP1 collapses)", () => {
    const out = buildSystemMessages(["only"], FIXED_NOW);
    expect(out).toHaveLength(2); // part + currentContext
    expect(out[0]!.providerOptions?.anthropic?.cacheControl?.type).toBe(
      "ephemeral",
    );
    expect(out[1]!.providerOptions?.anthropic?.cacheControl).toBeFalsy();
  });

  test("empty parts: still emits current-context", () => {
    const out = buildSystemMessages([], FIXED_NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain("<current-context>");
    expect(out[0]!.providerOptions?.anthropic?.cacheControl).toBeFalsy();
  });
});

describe("buildCurrentTodosPrompt", () => {
  test("returns null for empty todo list", () => {
    expect(buildCurrentTodosPrompt([])).toBeNull();
  });

  test("renders a single pending todo with content", () => {
    const todos: Todo[] = [
      {
        content: "Implement login",
        status: "pending",
        activeForm: "Implementing login",
      },
    ];
    const block = buildCurrentTodosPrompt(todos);
    expect(block).toContain("<current-todos>");
    expect(block).toContain("</current-todos>");
    expect(block).toContain("[pending] Implement login");
  });

  test("renders an in_progress todo with activeForm (not content)", () => {
    const todos: Todo[] = [
      {
        content: "Run tests",
        status: "in_progress",
        activeForm: "Running tests",
      },
    ];
    const block = buildCurrentTodosPrompt(todos);
    expect(block).toContain("[in_progress] Running tests");
    expect(block).not.toContain("Run tests");
  });

  test("renders completed todos with content (not activeForm)", () => {
    const todos: Todo[] = [
      {
        content: "Wrote docs",
        status: "completed",
        activeForm: "Writing docs",
      },
    ];
    const block = buildCurrentTodosPrompt(todos);
    expect(block).toContain("[completed] Wrote docs");
  });

  test("renders a full mixed list in order", () => {
    const todos: Todo[] = [
      { content: "Done item", status: "completed", activeForm: "Doing done" },
      {
        content: "Active item",
        status: "in_progress",
        activeForm: "Doing active",
      },
      {
        content: "Pending item",
        status: "pending",
        activeForm: "Doing pending",
      },
    ];
    const block = buildCurrentTodosPrompt(todos)!;
    const lines = block.split("\n");
    expect(lines).toEqual([
      "<current-todos>",
      "- [completed] Done item",
      "- [in_progress] Doing active",
      "- [pending] Pending item",
      "</current-todos>",
    ]);
  });
});
