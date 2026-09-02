import { describe, expect, it } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import { needsAttention, tasksNeedingMeByProject } from "./projects-section";

const ME = "user_me";

function task(
  id: string,
  over: Partial<{
    status: string;
    assigneeId: string | null;
    threadStatus: string;
    virtualMcpId: string;
    repo: string;
    updatedAt: string;
  }> = {},
): TaskBoardItem {
  return {
    id,
    title: id,
    status: over.status ?? "todo",
    assigneeId: over.assigneeId ?? null,
    repo: over.repo ?? null,
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00Z",
    threads:
      over.threadStatus || over.virtualMcpId
        ? [
            {
              threadId: `t_${id}`,
              virtualMcpId: over.virtualMcpId ?? null,
              status: over.threadStatus ?? "completed",
            },
          ]
        : [],
  } as unknown as TaskBoardItem;
}

describe("needsAttention", () => {
  it("takes a card assigned to me", () => {
    expect(needsAttention(task("t", { assigneeId: ME }), ME)).toBe(true);
  });

  it("ignores a card assigned to someone else", () => {
    expect(needsAttention(task("t", { assigneeId: "other" }), ME)).toBe(false);
  });

  it("takes a run stopped on a question, whoever owns it", () => {
    expect(
      needsAttention(task("t", { threadStatus: "requires_action" }), ME),
    ).toBe(true);
  });

  it("takes an unowned card parked in review", () => {
    expect(needsAttention(task("t", { status: "in_review" }), ME)).toBe(true);
  });

  it("leaves an owned in-review card to its owner", () => {
    expect(
      needsAttention(
        task("t", { status: "in_review", assigneeId: "other" }),
        ME,
      ),
    ).toBe(false);
  });

  it("never claims a terminal card, even one assigned to me", () => {
    for (const status of ["done", "archived"]) {
      expect(needsAttention(task("t", { status, assigneeId: ME }), ME)).toBe(
        false,
      );
    }
  });

  it("still surfaces blocked cards for a signed-out read", () => {
    expect(
      needsAttention(task("t", { threadStatus: "requires_action" }), undefined),
    ).toBe(true);
    expect(needsAttention(task("t", { assigneeId: ME }), undefined)).toBe(
      false,
    );
  });
});

const A = {
  id: "p_a",
  title: "alpha",
  metadata: {
    githubRepo: {
      url: "https://github.com/acme/alpha",
      owner: "acme",
      name: "alpha",
    },
  },
} as unknown as VirtualMCPEntity;

describe("tasksNeedingMeByProject", () => {
  it("buckets by thread first, then by repo", () => {
    const out = tasksNeedingMeByProject(
      [A],
      [
        task("viaThread", { assigneeId: ME, virtualMcpId: "p_a" }),
        task("viaRepo", { assigneeId: ME, repo: "ACME/Alpha" }),
        task("orphan", { assigneeId: ME }),
      ],
      ME,
    );
    expect(
      out
        .get("p_a")
        ?.map((t) => t.id)
        .sort(),
    ).toEqual(["viaRepo", "viaThread"]);
  });

  it("sorts newest first and caps at three", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      task(`t${i}`, {
        assigneeId: ME,
        virtualMcpId: "p_a",
        updatedAt: `2026-01-0${i + 1}T00:00:00Z`,
      }),
    );
    const out = tasksNeedingMeByProject([A], many, ME);
    expect(out.get("p_a")?.map((t) => t.id)).toEqual(["t4", "t3", "t2"]);
  });

  it("leaves a project out entirely when nothing needs me", () => {
    const out = tasksNeedingMeByProject(
      [A],
      [task("theirs", { assigneeId: "other", virtualMcpId: "p_a" })],
      ME,
    );
    expect(out.has("p_a")).toBe(false);
  });
});
