/**
 * The digest's wording and grouping. Pure functions, so this tier can cover
 * them fully — the recipient selection they feed on is a SQL WHERE clause and
 * is tested where it lives, against a real Postgres.
 */

import { describe, expect, test } from "bun:test";
import { TASK_BOARD_ACTIVITY_ACTIONS } from "../tools/task-board/schema";
import type { TaskBoardActivityAction } from "../storage/types";
import {
  type DigestEvent,
  describeEvent,
  digestSubject,
  escapeHtml,
  groupByTask,
  renderDigest,
} from "./digest-render";

function event(overrides: Partial<DigestEvent> = {}): DigestEvent {
  return {
    taskBoardItemId: "task_1",
    taskTitle: "Fix the checkout",
    taskKeySeq: 12,
    action: "status_changed",
    actorName: "Ana",
    data: { from: "todo", to: "in_review" },
    occurredAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("groupByTask", () => {
  test("groups a task's events together, newest task first", () => {
    const groups = groupByTask([
      event({ taskBoardItemId: "a", occurredAt: "2026-08-21T10:00:00.000Z" }),
      event({ taskBoardItemId: "b", occurredAt: "2026-08-21T12:00:00.000Z" }),
      event({ taskBoardItemId: "a", occurredAt: "2026-08-21T11:00:00.000Z" }),
    ]);

    expect(groups.map((g) => g.taskBoardItemId)).toEqual(["b", "a"]);
    expect(groups[1]!.events).toHaveLength(2);
  });

  test("keeps each task's events in the order they arrived", () => {
    const [group] = groupByTask([
      event({ action: "created", occurredAt: "2026-08-21T10:00:00.000Z" }),
      event({ action: "commented", occurredAt: "2026-08-21T11:00:00.000Z" }),
    ]);

    expect(group!.events.map((e) => e.action)).toEqual([
      "created",
      "commented",
    ]);
  });

  test("no events, no groups", () => {
    expect(groupByTask([])).toEqual([]);
  });
});

describe("digestSubject", () => {
  test("one task carries its key", () => {
    const groups = groupByTask([event(), event()]);
    expect(digestSubject(groups, "deco-cx")).toBe("DECO-12: 2 updates");
  });

  test("a single update is not pluralized", () => {
    expect(digestSubject(groupByTask([event()]), "deco-cx")).toBe(
      "DECO-12: 1 update",
    );
  });

  test("several tasks count both dimensions", () => {
    const groups = groupByTask([
      event({ taskBoardItemId: "a" }),
      event({ taskBoardItemId: "b" }),
      event({ taskBoardItemId: "b" }),
    ]);
    expect(digestSubject(groups, "deco-cx")).toBe("3 updates on 2 tasks");
  });

  test("a task with no key falls back to the bare count", () => {
    const groups = groupByTask([
      event({ taskKeySeq: null as unknown as number }),
    ]);
    expect(digestSubject(groups, "deco-cx")).toBe("1 update");
  });
});

describe("describeEvent", () => {
  test("every action produces a non-empty line", () => {
    for (const action of TASK_BOARD_ACTIVITY_ACTIONS) {
      const line = describeEvent(event({ action, data: {} }));
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toBe("undefined");
    }
  });

  test.each<[TaskBoardActivityAction, Record<string, unknown>, string]>([
    ["created", {}, "created this task"],
    [
      "status_changed",
      { from: "todo", to: "in_review" },
      "moved it from To do to In Review",
    ],
    ["status_changed", { to: "done" }, "moved it to Done"],
    [
      "status_changed",
      { retry: 2, of: 3, to: "in_progress" },
      "run failed, retrying (attempt 2 of 3)",
    ],
    ["assignee_changed", { to: null }, "unassigned it"],
    [
      "assignee_changed",
      { to: "super-agent" },
      "delegated it to the Super Agent",
    ],
    ["priority_changed", { to: "none" }, "cleared the priority"],
    ["priority_changed", { to: "high" }, "set the priority to High"],
    ["due_date_changed", { to: null }, "cleared the due date"],
    [
      "due_date_changed",
      { to: "2026-09-01T00:00:00.000Z" },
      "set the due date to 2026-09-01",
    ],
    ["title_changed", { to: "New name" }, 'renamed it to "New name"'],
    ["description_changed", {}, "updated the description"],
    ["tags_changed", { to: [] }, "cleared the tags"],
    [
      "tags_changed",
      { to: [{ name: "bug" }, { name: "p0" }] },
      "tagged it bug, p0",
    ],
    ["review_requested", { reviewer: "qa" }, "sent it to the QA Agent"],
    [
      "review_approved",
      { reviewer: "code_review" },
      "Code Reviewer approved it",
    ],
    [
      "review_changes_requested",
      { reviewer: "qa" },
      "QA Agent requested changes",
    ],
    ["commented", {}, "commented"],
    ["merge_failed", {}, "couldn't be merged"],
  ])("%s %o reads as %s", (action, data, expected) => {
    expect(describeEvent(event({ action, data }))).toBe(expected);
  });

  test("an assignee resolves through the caller's name lookup", () => {
    const line = describeEvent(
      event({ action: "assignee_changed", data: { to: "user_9" } }),
      (id) => (id === "user_9" ? "Bruno" : null),
    );
    expect(line).toBe("assigned it to Bruno");
  });

  test("an unresolvable assignee reads as someone, not as an id", () => {
    const line = describeEvent(
      event({ action: "assignee_changed", data: { to: "user_gone" } }),
    );
    expect(line).toBe("assigned it to someone");
  });
});

describe("escapeHtml", () => {
  test("neutralizes markup", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
  });
});

describe("renderDigest", () => {
  const render = (events: DigestEvent[]) =>
    renderDigest({
      groups: groupByTask(events),
      orgName: "Deco",
      orgSlug: "deco-cx",
      baseUrl: "https://studio.example.com",
    });

  test("names the task, its key, and each update", () => {
    const html = render([
      event({ action: "created", actorName: "Ana" }),
      event({ action: "commented", actorName: "Bruno" }),
    ]);

    expect(html).toContain("DECO-12 · Fix the checkout");
    expect(html).toContain("Ana created this task");
    expect(html).toContain("Bruno commented");
    expect(html).toContain("<strong>2</strong> updates");
  });

  test("deep-links the task by key, and the board from the CTA", () => {
    const html = render([event()]);
    expect(html).toContain("https://studio.example.com/deco-cx/t/DECO-12");
    expect(html).toContain("https://studio.example.com/deco-cx?main=board");
  });

  test("a keyless task links by id instead", () => {
    const html = render([event({ taskKeySeq: null as unknown as number })]);
    expect(html).toContain("?main=board&task=task_1");
  });

  test("an agent-driven update has no actor to name", () => {
    const html = render([
      event({ action: "review_approved", actorName: null, data: {} }),
    ]);
    expect(html).toContain(
      '<li style="margin:0 0 6px 0;">A reviewer approved it</li>',
    );
  });

  test("a task title cannot inject markup", () => {
    const html = render([
      event({ taskTitle: `<img src=x onerror="alert(1)">` }),
    ]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("a renamed-to title cannot inject markup either", () => {
    const html = render([
      event({ action: "title_changed", data: { to: "<b>bold</b>" } }),
    ]);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });
});
