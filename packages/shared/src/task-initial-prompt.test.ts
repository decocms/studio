import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TASK_INITIAL_PROMPT,
  jiraKeyFromUrl,
  renderTaskInitialPrompt,
  TASK_INITIAL_PROMPT_VARS,
  type TaskInitialPromptVars,
} from "./task-initial-prompt";

const VARS: TaskInitialPromptVars = {
  taskTitle: "Fix the header",
  taskDescription: "Description:\nIt overlaps on mobile.",
  taskId: "task_1",
  jiraId: "DECO-42",
  jiraUrl: "https://acme.atlassian.net/browse/DECO-42",
  repoContext: "The repository acme/site is already cloned.",
  prBullet: "- Open a pull request.",
  prContext: "",
};

describe("renderTaskInitialPrompt", () => {
  test("substitutes every variable, tolerating inner spaces", () => {
    expect(renderTaskInitialPrompt("{{taskTitle}} / {{ jiraId }}", VARS)).toBe(
      "Fix the header / DECO-42",
    );
  });

  test("leaves an unknown variable verbatim so a typo is visible", () => {
    expect(renderTaskInitialPrompt("{{taskTitel}}", VARS)).toBe(
      "{{taskTitel}}",
    );
  });

  test("an empty variable leaves no hole", () => {
    expect(
      renderTaskInitialPrompt("Title: {{taskTitle}}\n\n{{prContext}}\n\nEnd", {
        ...VARS,
        prContext: "",
      }),
    ).toBe("Title: Fix the header\n\nEnd");
  });

  test("the default template only uses declared variables", () => {
    const used = [
      ...DEFAULT_TASK_INITIAL_PROMPT.matchAll(/\{\{\s*(\w+)\s*\}\}/g),
    ].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(Object.keys(TASK_INITIAL_PROMPT_VARS)).toContain(name);
    }
  });
});

describe("jiraKeyFromUrl", () => {
  test("reads the key out of an issue URL", () => {
    expect(jiraKeyFromUrl("https://acme.atlassian.net/browse/DECO-42")).toBe(
      "DECO-42",
    );
  });

  test("is empty for a card Studio owns", () => {
    expect(jiraKeyFromUrl(null)).toBe("");
    expect(jiraKeyFromUrl("https://example.com/whatever")).toBe("");
  });
});
