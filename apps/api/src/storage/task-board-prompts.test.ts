import { describe, expect, it } from "bun:test";
import {
  composeBoardPrompt,
  TaskBoardPromptStorage,
} from "./task-board-prompts";

describe("composeBoardPrompt", () => {
  it("is undefined when no scope carries anything", () => {
    expect(composeBoardPrompt([])).toBeUndefined();
    expect(composeBoardPrompt([{ prompt: "  ", skills: [] }])).toBeUndefined();
  });

  it("joins prompts in scope order and names each skill once", () => {
    const out = composeBoardPrompt([
      { prompt: "Use pnpm.", skills: ["home/pr", "core/pdf"] },
      { prompt: "", skills: ["home/pr", "home/tests"] },
    ]);
    expect(out).toBe(
      "Use pnpm.\n\nSkills configured for this work — load each one with the skill tool before you start: home/pr, core/pdf, home/tests",
    );
  });
});

describe("TaskBoardPromptStorage defaults", () => {
  // Minimal in-memory stand-in for the two queries listByOrg/remove/upsert run.
  function storage(
    rows: { column_key: string | null; prompt: string; skills: string[] }[],
  ) {
    const chain = {
      select: () => chain,
      where: () => chain,
      orderBy: () => chain,
      execute: async () => rows,
    };
    const db = {
      selectFrom: () => chain,
      insertInto: () => ({
        values: (v: {
          column_key: string | null;
          prompt: string;
          skills: string[];
        }) => ({
          onConflict: () => ({
            returning: () => ({
              executeTakeFirstOrThrow: async () => {
                const i = rows.findIndex((r) => r.column_key === v.column_key);
                const row = {
                  column_key: v.column_key,
                  prompt: v.prompt,
                  skills: v.skills,
                };
                if (i >= 0) rows[i] = row;
                else rows.push(row);
                return row;
              },
            }),
          }),
        }),
      }),
    };
    return new TaskBoardPromptStorage(db as never);
  }

  it("fills unset lanes with their defaults and lets a cleared lane stay clear", async () => {
    const s = storage([]);
    expect(await s.promptFor("o", "todo")).toContain("core/qa-screenshot");
    expect(await s.promptFor("o", "in_progress")).toContain("REVIEW the code");
    expect(await s.promptFor("o", null)).toBeUndefined();

    expect(await s.remove("o", "todo")).toBe(true);
    expect(await s.promptFor("o", "todo")).toBeUndefined();
    expect(await s.remove("o", "todo")).toBe(false);
  });
});
