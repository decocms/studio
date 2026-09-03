import { describe, expect, it } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import { buildProjectIndex } from "@/lib/project-index";
import { buildFeed } from "./project-feed";

function project(
  id: string,
  title: string,
  repo?: string,
  createdAt = "2026-01-01T00:00:00Z",
): VirtualMCPEntity {
  return {
    id,
    title,
    created_at: createdAt,
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
      buildProjectIndex([A, B]),
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
      buildProjectIndex([A, B]),
      [
        task("mine", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" }),
        task("theirs", "2026-03-01T00:00:00Z", { virtualMcpId: "p_b" }),
      ],
      "acme/alpha",
    );
    expect(ids(feed)).toEqual(["mine"]);
  });

  it("carries the project on every entry, so a card can name it", () => {
    const feed = buildFeed(
      buildProjectIndex([A]),
      [task("t", "2026-01-01T00:00:00Z", { virtualMcpId: "p_a" })],
      null,
    );
    expect(feed[0]?.project?.title).toBe("alpha");
  });

  it("attributes a threadless card by its repo, case-insensitively", () => {
    const feed = buildFeed(
      buildProjectIndex([A]),
      [task("byrepo", "2026-01-01T00:00:00Z", { repo: "ACME/Alpha" })],
      null,
    );
    expect(feed[0]?.project?.id).toBe("p_a");
  });

  it("drops a card that names no project rather than guessing one", () => {
    const feed = buildFeed(
      buildProjectIndex([A]),
      [task("orphan", "2026-01-01T00:00:00Z", {})],
      null,
    );
    expect(feed).toEqual([]);
  });

  /** The project home passes ONE project, and that is what keeps its feed to
   *  one project's work: another project's card has no bucket in this index. */
  it("shows only the given projects' work", () => {
    const feed = buildFeed(
      buildProjectIndex([A]),
      [
        task("mine", "2026-01-01T00:00:00Z", { repo: "acme/alpha" }),
        task("theirs", "2026-03-01T00:00:00Z", { repo: "acme/bravo" }),
      ],
      null,
    );
    expect(ids(feed)).toEqual(["mine"]);
  });

  describe("two projects over one repository", () => {
    /** `created_at` is what `byCreation` orders on, so the fixtures have to
     *  carry it or the ordering under test is never exercised. */
    const M1 = project(
      "p_m1",
      "storefront",
      "acme/mono",
      "2026-01-01T00:00:00Z",
    );
    const M2 = project("p_m2", "checkout", "acme/mono", "2026-02-01T00:00:00Z");

    /** REGRESSION. The `Map<repo, project>` this replaced let the last project
     *  iterated win, so the card was silently filed under a sibling. */
    it("files the card once, under neither sibling", () => {
      const feed = buildFeed(
        buildProjectIndex([M1, M2]),
        [task("shared", "2026-01-01T00:00:00Z", { repo: "acme/mono" })],
        null,
      );
      expect(ids(feed)).toEqual(["shared"]);
      expect(feed[0]?.project).toBeNull();
      expect(feed[0]?.bucket.title).toBe("acme/mono");
    });

    /** `bucket.title` is the repo for any shared bucket, so comparing only that
     *  passes even with the ordering deleted. Compare what the ordering
     *  actually decides: which projects, in which order. */
    it("reversing the project order changes nothing", () => {
      const cards = [
        task("shared", "2026-01-01T00:00:00Z", { repo: "acme/mono" }),
      ];
      const forward = buildFeed(buildProjectIndex([M1, M2]), cards, null);
      const reverse = buildFeed(buildProjectIndex([M2, M1]), cards, null);
      expect(reverse[0]?.bucket.title).toBe(forward[0]?.bucket.title);
      expect(reverse[0]?.bucket.projects.map((p) => p.id)).toEqual(
        forward[0]?.bucket.projects.map((p) => p.id) ?? [],
      );
      expect(forward[0]?.bucket.projects.map((p) => p.id)).toEqual([
        "p_m1",
        "p_m2",
      ]);
    });

    /** A run names the project it ran in, which is a better answer than the
     *  repository they share. */
    it("names the project a run identified", () => {
      const feed = buildFeed(
        buildProjectIndex([M1, M2]),
        [
          task("ran", "2026-01-01T00:00:00Z", {
            repo: "acme/mono",
            virtualMcpId: "p_m2",
          }),
        ],
        null,
      );
      expect(feed[0]?.project?.id).toBe("p_m2");
    });
  });

  /** INVERTED, twice over. The feed carried only `done` (plus delivery lanes
   *  for orgs running them), which made the project home's composer create
   *  cards its own feed could not show, and left an org mid-flight with an
   *  empty home. The feed is the board's list view now — one rule on both
   *  homes — so the only status that is still excluded is the deleted one. */
  const LANES = [
    "todo",
    "in_progress",
    "in_review",
    "triage",
    "done",
    "merged",
  ];

  it("carries every lane, open or settled", () => {
    const feed = buildFeed(
      buildProjectIndex([A]),
      LANES.map((status, i) =>
        task(status, `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`, {
          virtualMcpId: "p_a",
          status,
        }),
      ),
      null,
    );
    expect(ids(feed).sort()).toEqual([...LANES].sort());
  });

  it("never carries archived work — deleted is not activity", () => {
    const feed = buildFeed(
      buildProjectIndex([A]),
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
    );
    expect(ids(feed)).toEqual(["triage"]);
  });

  it("caps the stack", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      task(`t${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, {
        virtualMcpId: "p_a",
      }),
    );
    const feed = buildFeed(buildProjectIndex([A]), many, null);
    expect(feed).toHaveLength(20);
    expect(feed[0]?.task.id).toBe("t39");
  });
});
