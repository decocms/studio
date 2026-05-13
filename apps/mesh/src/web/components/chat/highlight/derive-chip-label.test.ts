import { describe, expect, test } from "bun:test";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { deriveChipLabel } from "./derive-chip-label";

const todo = (
  status: Todo["status"],
  content: string,
  activeForm = content.replace(/^[A-Z]/, (c) => c.toLowerCase()),
): Todo => ({
  status,
  content,
  activeForm: `${activeForm.charAt(0).toUpperCase()}${activeForm.slice(1)}ing`,
});

describe("deriveChipLabel", () => {
  test("returns pending icon and 'not started' summary when nothing is in progress", () => {
    const result = deriveChipLabel([
      todo("pending", "Read the file"),
      todo("pending", "Write the test"),
      todo("pending", "Implement"),
    ]);
    expect(result).toEqual({
      icon: "pending",
      activity: "3 todos",
      progress: "not started",
    });
  });

  test("returns in_progress icon and activeForm when exactly one todo is in progress", () => {
    const result = deriveChipLabel([
      todo("completed", "Read the file"),
      {
        status: "in_progress",
        content: "Implement the function",
        activeForm: "Implementing the function",
      },
      todo("pending", "Add tests"),
    ]);
    expect(result).toEqual({
      icon: "in_progress",
      activity: "Implementing the function",
      progress: "1/3 done",
    });
  });

  test("returns pending icon and partial-progress summary when some are done and nothing is in progress", () => {
    const result = deriveChipLabel([
      {
        status: "completed",
        content: "Extract types",
        activeForm: "Extracting types",
      },
      {
        status: "completed",
        content: "Add unit tests",
        activeForm: "Adding unit tests",
      },
      todo("pending", "Migrate callsites"),
      todo("pending", "Update docs"),
      todo("pending", "Delete old file"),
    ]);
    expect(result).toEqual({
      icon: "pending",
      activity: "3 pending",
      progress: "2/5 done",
    });
  });

  test("returns in_progress icon and a count when more than one todo is in progress", () => {
    const result = deriveChipLabel([
      {
        status: "in_progress",
        content: "First",
        activeForm: "Doing first",
      },
      {
        status: "in_progress",
        content: "Second",
        activeForm: "Doing second",
      },
      todo("completed", "Third"),
    ]);
    expect(result).toEqual({
      icon: "in_progress",
      activity: "2 in progress",
      progress: "1/3 done",
    });
  });

  test("returns completed icon when every todo is done", () => {
    const result = deriveChipLabel([
      todo("completed", "One"),
      todo("completed", "Two"),
      todo("completed", "Three"),
    ]);
    expect(result).toEqual({
      icon: "completed",
      activity: "All done",
      progress: "3/3",
    });
  });

  test("tolerates the empty list (caller is responsible for early return)", () => {
    const result = deriveChipLabel([]);
    expect(result.icon).toBe("pending");
  });
});
