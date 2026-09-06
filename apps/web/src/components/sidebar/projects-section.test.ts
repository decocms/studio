import { describe, expect, it } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import { buildProjectIndex } from "@/lib/project-index";
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
      buildProjectIndex([A]),
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
    const out = tasksNeedingMeByProject(buildProjectIndex([A]), many, ME);
    expect(out.get("p_a")?.map((t) => t.id)).toEqual(["t4", "t3", "t2"]);
  });

  it("leaves a project out entirely when nothing needs me", () => {
    const out = tasksNeedingMeByProject(
      buildProjectIndex([A]),
      [task("theirs", { assigneeId: "other", virtualMcpId: "p_a" })],
      ME,
    );
    expect(out.has("p_a")).toBe(false);
  });

  describe("two projects over one repository", () => {
    const mono = (id: string, title: string) =>
      ({
        id,
        title,
        metadata: {
          githubRepo: {
            url: "https://github.com/acme/mono",
            owner: "acme",
            name: "mono",
          },
        },
      }) as unknown as VirtualMCPEntity;
    const M1 = mono("p_m1", "storefront");
    const M2 = mono("p_m2", "checkout");

    /** REGRESSION. The `Map<repo, project>` this replaced nudged exactly one
     *  of the two, chosen by iteration order — a silence for the other. */
    it("nudges both when nothing says which owes the answer", () => {
      const out = tasksNeedingMeByProject(
        buildProjectIndex([M1, M2]),
        [task("shared", { assigneeId: ME, repo: "acme/mono" })],
        ME,
      );
      expect(out.get("p_m1")?.map((t) => t.id)).toEqual(["shared"]);
      expect(out.get("p_m2")?.map((t) => t.id)).toEqual(["shared"]);
    });

    it("nudges only the project a run identified", () => {
      const out = tasksNeedingMeByProject(
        buildProjectIndex([M1, M2]),
        [
          task("ran", {
            assigneeId: ME,
            repo: "acme/mono",
            virtualMcpId: "p_m2",
          }),
        ],
        ME,
      );
      expect(out.has("p_m1")).toBe(false);
      expect(out.get("p_m2")?.map((t) => t.id)).toEqual(["ran"]);
    });
  });
});
