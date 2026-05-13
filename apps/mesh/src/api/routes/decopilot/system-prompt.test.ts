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

describe("buildSystemMessages — current todos tail", () => {
  const now = new Date("2026-05-12T10:00:00Z");

  test("appends no extra system message when todos is empty", () => {
    const out = buildSystemMessages(["base", "agent"], now, []);
    // 2 parts + 1 <current-context> tail = 3 messages
    expect(out).toHaveLength(3);
    // The last message is <current-context>, NOT <current-todos>.
    expect(out[2]!.content).toContain("<current-context>");
    expect(out[2]!.content).not.toContain("<current-todos>");
  });

  test("appends <current-todos> after <current-context> when todos non-empty", () => {
    const out = buildSystemMessages(["base", "agent"], now, [
      { content: "x", status: "pending", activeForm: "doing x" },
    ]);
    // 2 parts + <current-context> + <current-todos> = 4 messages
    expect(out).toHaveLength(4);
    expect(out[2]!.content).toContain("<current-context>");
    expect(out[3]!.content).toContain("<current-todos>");
    expect(out[3]!.content).toContain("[pending] x");
  });

  test("the new <current-todos> tail message has NO cache markers", () => {
    const out = buildSystemMessages(["base", "agent"], now, [
      { content: "x", status: "pending", activeForm: "doing x" },
    ]);
    expect(out[3]!.providerOptions).toBeUndefined();
  });

  test("cache markers on BP1/BP2 are unchanged when todos non-empty", () => {
    const out = buildSystemMessages(["base", "agent"], now, [
      { content: "x", status: "pending", activeForm: "doing x" },
    ]);
    // parts.length === 2, so bp1Idx = 0, bp2Idx = 1 — both get markers.
    expect(out[0]!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
    expect(out[1]!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
    // <current-context> and <current-todos> tails both unmarked.
    expect(out[2]!.providerOptions).toBeUndefined();
    expect(out[3]!.providerOptions).toBeUndefined();
  });
});
