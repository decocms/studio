import { describe, expect, it } from "bun:test";
import { businessCasePath } from "@decocms/shared/business-case";
import { formatCaseTabId } from "@/layouts/main-panel-tabs/tab-id";
import { readCaseSeed } from "./business-case/case-seed.ts";
import { startBusinessCase } from "./start-business-case.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

function setup(created: boolean) {
  const records: unknown[] = [];
  const tasks: {
    id?: string;
    tabId?: string;
    message: { parts: { type: "text"; text: string }[] };
  }[] = [];
  const storage = memoryStorage();
  const deps = {
    storage,
    studio: {
      call: (_name: "PLAN_GOAL_CASE_RECORD", input: unknown) => {
        records.push(input);
        return Promise.resolve({});
      },
    },
    createTaskWithMessage: (params: (typeof tasks)[number]) => {
      tasks.push(params);
      return Promise.resolve(created);
    },
  };
  return { deps, records, tasks, storage };
}

const input = {
  objective: "Grow mobile conversion",
  request: "On mobile, most product views end without a cart",
  title: "A sticky buy bar on mobile",
  prompt: (casePath: string) => `case at ${casePath}`,
};

describe("startBusinessCase", () => {
  it("records the case toward the goal, seeds it and opens its tab", async () => {
    const { deps, records, tasks, storage } = setup(true);
    const ok = await startBusinessCase(deps, { ...input, goalId: "goal_a" });
    expect(ok).toBe(true);
    const [task] = tasks;
    const threadId = task?.id ?? "";
    const casePath = businessCasePath(threadId);
    expect(records).toEqual([{ goal_id: "goal_a", thread_id: threadId }]);
    expect(task?.tabId).toBe(formatCaseTabId(casePath));
    expect(task?.message.parts[0]?.text).toContain("case at /app/org/home/");
    expect(readCaseSeed(storage, casePath)).toMatchObject({
      title: input.title,
      objective: input.objective,
      request: { text: input.request },
    });
  });

  it("records nothing without a goal and reports a chat that failed to open", async () => {
    const { deps, records, tasks } = setup(false);
    const ok = await startBusinessCase(deps, { ...input, goalId: null });
    expect(ok).toBe(false);
    expect(records).toEqual([]);
    expect(tasks).toHaveLength(1);
  });

  it("opens the case when recording it toward the goal fails", async () => {
    const { deps, tasks } = setup(true);
    const ok = await startBusinessCase(
      {
        ...deps,
        studio: { call: () => Promise.reject(new Error("down")) },
      },
      { ...input, goalId: "goal_a" },
    );
    expect(ok).toBe(true);
    expect(tasks).toHaveLength(1);
  });
});
