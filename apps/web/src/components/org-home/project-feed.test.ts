import { describe, expect, it } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import { buildFeed } from "./project-feed";

function project(id: string, title: string, repo?: string): VirtualMCPEntity {
  return {
    id,
    title,
    metadata: repo
      ? {
          githubRepo: {
            url: `https://github.com/${repo}`,
            owner: repo.split("/")[0],
            name: repo.split("/")[1],
          },
        }
      : {},
  } as unknown as VirtualMCPEntity;
}

function task(
  id: string,
  updatedAt: string,
  link: { virtualMcpId?: string; repo?: string; status?: string },
): TaskBoardItem {
  return {
    id,
    title: id,
    updatedAt,
    status: link.status ?? "done",
    repo: link.repo ?? null,
    threads: link.virtualMcpId
      ? [{ threadId: `t_${id}`, virtualMcpId: link.virtualMcpId }]
      : [],
  } as unknown as TaskBoardItem;
}

const A = project("p_a", "alpha", "acme/alpha");
const B = project("p_b", "bravo", "acme/bravo");
const ids = (entries: { task: TaskBoardItem }[]) =>
  entries.map((e) => e.task.id);

describe("buildFeed", () => {
  it("interleaves projects into one chronological stack", () => {
    const feed = buildFeed(
      [A, B],
      [
        task("a_old", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" }),
        task("b_new", "2026-03-01T00:00:00Z", { virtualMcpId: "p_b" }),
        task("a_mid", "2026-02-01T00:00:00Z", { virtualMcpId: "p_a" }),
      ],
      null,
    );
    expect(ids(feed)).toEqual(["b_new", "a_mid", "a_old"]);
  });

  it("narrows to one project when filtered", () => {
    const feed = buildFeed(
      [A, B],
      [
        task("mine", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" }),
        task("theirs", "2026-03-01T00:00:00Z", { virtualMcpId: "p_b" }),
      ],
      "p_a",
    );
    expect(ids(feed)).toEqual(["mine"]);
  });

  it("carries the project on every entry, so a card can name it", () => {
    const feed = buildFeed(
      [A],
      [task("t", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" })],
      null,
    );
    expect(feed[0]?.project.title).toBe("alpha");
  });

  it("attributes a threadless card by its repo, case-insensitively", () => {
    const feed = buildFeed(
      [A],
      [task("byrepo", "2026-01-01T00:00:00Z", { repo: "ACME/Alpha" })],
      null,
    );
    expect(feed[0]?.project.id).toBe("p_a");
  });

  it("drops a card that names no project rather than guessing one", () => {
    const feed = buildFeed(
      [A],
      [task("orphan", "2026-01-01T00:00:00Z", {})],
      null,
    );
    expect(feed).toEqual([]);
  });

  /** The ORG home is a record of finished work, so it keeps the settled-only
   *  rule. The PROJECT home is a working surface whose composer creates cards
   *  in the intake lane, so it must carry them — a feed that could not show
   *  what the composer above it just made is the bug this pair pins. */
  const OPEN = ["todo", "in_progress", "in_review", "triage"];

  it("carries only settled work by default — the org home's rule", () => {
    const feed = buildFeed(
      [A],
      [
        ...[...OPEN, "archived"].map((status, i) =>
          task(status, `2026-03-0${i + 1}T00:00:00Z`, {
            virtualMcpId: "p_a",
            status,
          }),
        ),
        task("done", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" }),
      ],
      null,
    );
    expect(ids(feed)).toEqual(["done"]);
  });

  it("carries open cards too when asked — the project home's rule", () => {
    const feed = buildFeed(
      [A],
      [
        ...OPEN.map((status, i) =>
          task(status, `2026-03-0${i + 1}T00:00:00Z`, {
            virtualMcpId: "p_a",
            status,
          }),
        ),
        task("done", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" }),
      ],
      null,
      false,
      true,
    );
    // Newest first, so the open cards lead and `done` (January) trails.
    expect(ids(feed).sort()).toEqual([...OPEN, "done"].sort());
  });

  it("never carries archived work, even with open cards on", () => {
    const feed = buildFeed(
      [A],
      [
        task("archived", "2026-03-01T00:00:00Z", {
          virtualMcpId: "p_a",
          status: "archived",
        }),
        task("triage", "2026-03-02T00:00:00Z", {
          virtualMcpId: "p_a",
          status: "triage",
        }),
      ],
      null,
      false,
      true,
    );
    expect(ids(feed)).toEqual(["triage"]);
  });

  it("counts a delivery lane as settled only for an org that runs them", () => {
    const shipped = [
      task("merged", "2026-01-01T00:00:00Z", {
        virtualMcpId: "p_a",
        status: "merged",
      }),
    ];
    expect(ids(buildFeed([A], shipped, null, false))).toEqual([]);
    expect(ids(buildFeed([A], shipped, null, true))).toEqual(["merged"]);
  });

  it("caps the stack", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      task(`t${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, {
        virtualMcpId: "p_a",
      }),
    );
    const feed = buildFeed([A], many, null);
    expect(feed).toHaveLength(20);
    expect(feed[0]?.task.id).toBe("t39");
  });
});
