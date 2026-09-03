import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  buildProjectIndex,
  entryForTask,
  filterAfterCreate,
  NO_PROJECT_FILTER,
  normalizeRepo,
  projectFilterNarrows,
  projectForTask,
  projectsForTask,
  stampableEntries,
  taskMatchesProjectFilter,
  type AttributableTask,
} from "./project-index";

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
  link: { repo?: string | null; virtualMcpId?: string } = {},
): AttributableTask {
  return {
    repo: link.repo ?? null,
    threads: link.virtualMcpId
      ? [{ virtualMcpId: link.virtualMcpId }]
      : [{ virtualMcpId: null }],
  };
}

const ALPHA = project("vir_a", "Alpha", "acme/alpha");
const BRAVO = project("vir_b", "Bravo", "acme/bravo");
/** Two projects over ONE monorepo — legal since migration 158 dropped the
 *  one-parent trigger, and the case the two `Map<repo, project>` copies this
 *  index replaces resolved by iteration order. */
const MONO_1 = project("vir_m1", "Storefront", "acme/mono", "2026-01-01Z");
const MONO_2 = project("vir_m2", "Checkout", "acme/mono", "2026-02-01Z");
/** A project created from scratch — no repository for a card to point at. */
const BARE = project("vir_bare", "Ideas");

describe("normalizeRepo", () => {
  test("folds case and trims, the way GitHub reads owner/repo", () => {
    expect(normalizeRepo(" ACME/Alpha ")).toBe("acme/alpha");
    expect(normalizeRepo(null)).toBe("");
    expect(normalizeRepo(undefined)).toBe("");
  });
});

describe("buildProjectIndex", () => {
  test("a project with a repository is one bucket, named after the project", () => {
    const index = buildProjectIndex([ALPHA]);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      id: "acme/alpha",
      kind: "repo",
      repo: "acme/alpha",
      title: "Alpha",
    });
    expect(index.byProject.get("vir_a")).toBe(index.entries[0]!);
  });

  test("a project with no repository is its own bucket, keyed by its id", () => {
    const index = buildProjectIndex([BARE]);
    expect(index.entries[0]).toMatchObject({
      id: "vir_bare",
      kind: "project",
      repo: null,
      title: "Ideas",
    });
  });

  test("a repository no project claims is a bucket with no projects", () => {
    const index = buildProjectIndex([], ["acme/orphan"]);
    expect(index.entries[0]).toMatchObject({
      id: "acme/orphan",
      kind: "repo",
      repo: "acme/orphan",
      title: "acme/orphan",
      projects: [],
    });
  });

  test("case and whitespace never split one repository into two buckets", () => {
    const index = buildProjectIndex([ALPHA], [" ACME/Alpha ", "acme/ALPHA"]);
    expect(index.entries).toHaveLength(1);
    expect(index.byRepo.get("acme/alpha")).toBe(index.entries[0]!);
  });

  /** THE COLLISION FIX. The two `Map<repo, project>` copies this replaces let
   *  the last project iterated win, silently routing its sibling's cards to it.
   *  One bucket, both projects, and the answer cannot depend on input order. */
  test("two projects on one repository share ONE bucket, named after the repo", () => {
    const index = buildProjectIndex([MONO_1, MONO_2]);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      id: "acme/mono",
      title: "acme/mono",
    });
    expect(index.entries[0]!.projects.map((p) => p.id)).toEqual([
      "vir_m1",
      "vir_m2",
    ]);
    expect(index.byProject.get("vir_m1")).toBe(index.entries[0]!);
    expect(index.byProject.get("vir_m2")).toBe(index.entries[0]!);
  });

  test("reversing the input does not change a shared bucket's answer", () => {
    const forward = buildProjectIndex([MONO_1, MONO_2]);
    const reverse = buildProjectIndex([MONO_2, MONO_1]);
    expect(reverse.entries[0]!.title).toBe(forward.entries[0]!.title);
    expect(reverse.entries[0]!.projects.map((p) => p.id)).toEqual(
      forward.entries[0]!.projects.map((p) => p.id),
    );
  });

  test("orders projects first by title, then unclaimed repositories", () => {
    const index = buildProjectIndex(
      [BRAVO, ALPHA, BARE],
      ["acme/zulu", "acme/orphan"],
    );
    expect(index.entries.map((e) => e.title)).toEqual([
      "Alpha",
      "Bravo",
      "Ideas",
      "acme/orphan",
      "acme/zulu",
    ]);
  });

  /**
   * THE ONE-INDEX INVARIANT. The board enriches the option set with the org's
   * imported repositories; the sidebar and the feed do not. That difference
   * must never change what a card is attributed to — otherwise "one index" is
   * a claim rather than a property.
   */
  test("extra repositories add buckets but never move a card", () => {
    const cards = [
      task({ repo: "acme/alpha" }),
      task({ repo: "acme/mono" }),
      task({ virtualMcpId: "vir_bare" }),
      task(),
    ];
    const lean = buildProjectIndex([ALPHA, MONO_1, MONO_2, BARE]);
    const rich = buildProjectIndex(
      [ALPHA, MONO_1, MONO_2, BARE],
      ["acme/unused", "acme/also-unused"],
    );
    for (const card of cards) {
      expect(entryForTask(card, rich)?.id ?? null).toBe(
        entryForTask(card, lean)?.id ?? null,
      );
    }
    expect(rich.entries.length).toBe(lean.entries.length + 2);
  });
});

describe("entryForTask", () => {
  const index = buildProjectIndex([ALPHA, BRAVO, BARE]);

  /** Today's precedence, asserted so replacing the feed's and the sidebar's
   *  copies with this one is provably behaviour-neutral. */
  test("prefers the project a run named over the card's repo", () => {
    expect(
      entryForTask(
        { repo: "acme/bravo", threads: [{ virtualMcpId: "vir_a" }] },
        index,
      )?.id,
    ).toBe("acme/alpha");
  });

  test("falls back to the repo for a card nobody has run", () => {
    expect(entryForTask(task({ repo: "ACME/Alpha" }), index)?.id).toBe(
      "acme/alpha",
    );
  });

  test("reaches a repo-less project only through its thread", () => {
    expect(entryForTask(task({ virtualMcpId: "vir_bare" }), index)?.id).toBe(
      "vir_bare",
    );
  });

  test("ignores a thread naming a project the org does not list", () => {
    expect(
      entryForTask(
        task({ repo: "acme/bravo", virtualMcpId: "decopilot_org" }),
        index,
      )?.id,
    ).toBe("acme/bravo");
  });

  test("null when nothing says", () => {
    expect(entryForTask(task(), index)).toBeNull();
    expect(entryForTask({}, index)).toBeNull();
  });
});

describe("projectsForTask / projectForTask", () => {
  const index = buildProjectIndex([ALPHA, MONO_1, MONO_2]);

  test("one project for an ordinary bucket", () => {
    expect(projectForTask(task({ repo: "acme/alpha" }), index)?.id).toBe(
      "vir_a",
    );
  });

  test("a shared bucket with a thread hint resolves to the one that ran it", () => {
    const card = task({ repo: "acme/mono", virtualMcpId: "vir_m2" });
    expect(projectsForTask(card, index).map((p) => p.id)).toEqual(["vir_m2"]);
    expect(projectForTask(card, index)?.id).toBe("vir_m2");
  });

  /** Listing a shared card under both is honest; listing it under one at
   *  random is the bug this index exists to remove. */
  test("a shared bucket with no hint resolves to every project in it", () => {
    const card = task({ repo: "acme/mono" });
    expect(projectsForTask(card, index).map((p) => p.id)).toEqual([
      "vir_m1",
      "vir_m2",
    ]);
    expect(projectForTask(card, index)).toBeNull();
  });

  test("nothing for an unattributable card", () => {
    expect(projectsForTask(task(), index)).toEqual([]);
    expect(projectForTask(task(), index)).toBeNull();
  });
});

describe("taskMatchesProjectFilter", () => {
  const index = buildProjectIndex(
    [ALPHA, BRAVO, BARE, MONO_1, MONO_2],
    ["acme/orphan"],
  );

  test("no filter keeps everything", () => {
    expect(taskMatchesProjectFilter(task(), null, index)).toBe(true);
    expect(
      taskMatchesProjectFilter(task({ repo: "acme/alpha" }), null, index),
    ).toBe(true);
  });

  test("matches a card carrying the bucket's repo, case-insensitively", () => {
    expect(
      taskMatchesProjectFilter(
        task({ repo: "ACME/Alpha" }),
        "acme/alpha",
        index,
      ),
    ).toBe(true);
    expect(
      taskMatchesProjectFilter(
        task({ repo: "acme/bravo" }),
        "acme/alpha",
        index,
      ),
    ).toBe(false);
  });

  /** The widening the merge buys: a card with no repo whose run named a
   *  project pinning one now belongs to that project's bucket. */
  test("matches a repo-less card whose run named a project in the bucket", () => {
    expect(
      taskMatchesProjectFilter(
        task({ virtualMcpId: "vir_a" }),
        "acme/alpha",
        index,
      ),
    ).toBe(true);
  });

  test("a repo-less project's bucket matches by thread only", () => {
    expect(
      taskMatchesProjectFilter(
        task({ virtualMcpId: "vir_bare" }),
        "vir_bare",
        index,
      ),
    ).toBe(true);
    expect(
      taskMatchesProjectFilter(task({ repo: "acme/alpha" }), "vir_bare", index),
    ).toBe(false);
  });

  test("either project of a shared monorepo bucket selects the same cards", () => {
    const card = task({ repo: "acme/mono", virtualMcpId: "vir_m1" });
    expect(taskMatchesProjectFilter(card, "acme/mono", index)).toBe(true);
  });

  test("an unclaimed repository still filters", () => {
    expect(
      taskMatchesProjectFilter(
        task({ repo: "acme/orphan" }),
        "acme/orphan",
        index,
      ),
    ).toBe(true);
    expect(
      taskMatchesProjectFilter(
        task({ repo: "acme/alpha" }),
        "acme/orphan",
        index,
      ),
    ).toBe(false);
  });

  describe("the no-project bucket", () => {
    test("keeps exactly the cards no bucket claims", () => {
      expect(taskMatchesProjectFilter(task(), NO_PROJECT_FILTER, index)).toBe(
        true,
      );
      expect(
        taskMatchesProjectFilter(
          task({ repo: "acme/alpha" }),
          NO_PROJECT_FILTER,
          index,
        ),
      ).toBe(false);
    });

    /**
     * INVERTED from the repo filter's `item.repo == null`. A repo-less card
     * whose run named a real project is that project's work, so it leaves this
     * bucket — the one behavioural delta of the merge, and the only direction
     * it moves.
     */
    test("no longer keeps a repo-less card whose run named a project", () => {
      expect(
        taskMatchesProjectFilter(
          task({ virtualMcpId: "vir_a" }),
          NO_PROJECT_FILTER,
          index,
        ),
      ).toBe(false);
    });

    /** A card stamped with a repository nothing declares is still SOMEWHERE:
     *  callers union every loaded card's repo into the index, which is what
     *  makes this bucket a strict subset rather than a superset. */
    test("keeps a stamped card out, even when only the card declares the repo", () => {
      const closed = buildProjectIndex([ALPHA], ["acme/only-on-a-card"]);
      expect(
        taskMatchesProjectFilter(
          task({ repo: "acme/only-on-a-card" }),
          NO_PROJECT_FILTER,
          closed,
        ),
      ).toBe(false);
    });
  });

  describe("an id the index cannot resolve", () => {
    /** The first frame, before the project list has loaded, and a link naming
     *  a project since deleted. Failing closed here blanks the board. */
    test("an unresolved project id resolves like an absent filter", () => {
      const empty = buildProjectIndex([]);
      expect(
        taskMatchesProjectFilter(
          task({ repo: "acme/alpha" }),
          "vir_gone",
          empty,
        ),
      ).toBe(true);
      expect(taskMatchesProjectFilter(task(), "vir_gone", empty)).toBe(true);
    });

    /** A shared `?repo=` link naming a repository nothing carries: the raw
     *  compare it always did, byte for byte. */
    test("an unresolved repo id falls back to the raw compare", () => {
      const empty = buildProjectIndex([]);
      expect(
        taskMatchesProjectFilter(
          task({ repo: "Acme/Ghost" }),
          "acme/ghost",
          empty,
        ),
      ).toBe(true);
      expect(
        taskMatchesProjectFilter(
          task({ repo: "acme/alpha" }),
          "acme/ghost",
          empty,
        ),
      ).toBe(false);
    });
  });
});

/**
 * The control has to READ the way it behaves. The one id
 * `taskMatchesProjectFilter` lets every card through must not render as a set
 * filter — otherwise the chip claims a narrowing the board is not doing.
 */
describe("projectFilterNarrows", () => {
  const index = buildProjectIndex([ALPHA, BARE]);

  test("no filter narrows nothing", () => {
    expect(projectFilterNarrows(null, index)).toBe(false);
  });

  test("a resolved bucket narrows", () => {
    expect(projectFilterNarrows("acme/alpha", index)).toBe(true);
    expect(projectFilterNarrows("vir_bare", index)).toBe(true);
  });

  test("the no-project bucket narrows", () => {
    expect(projectFilterNarrows(NO_PROJECT_FILTER, index)).toBe(true);
  });

  /** The cold-load frame and a link naming a deleted project: every card
   *  passes, so the chip must read unset. */
  test("an unresolved project id narrows nothing", () => {
    expect(projectFilterNarrows("vir_gone", index)).toBe(false);
    expect(projectFilterNarrows("vir_bare", buildProjectIndex([]))).toBe(false);
  });

  /** An unresolved REPO id still narrows — it falls back to an exact compare
   *  against the card's own `repo`, which is a real answer. */
  test("an unresolved repo id still narrows", () => {
    expect(projectFilterNarrows("acme/ghost", index)).toBe(true);
  });

  /** The invariant tying the two together: anything that does not narrow must
   *  keep every card, and anything that keeps every card must not narrow. */
  test("agrees with the matcher on every card", () => {
    const cards = [
      task({ repo: "acme/alpha" }),
      task({ virtualMcpId: "vir_bare" }),
      task(),
    ];
    for (const filterId of [
      null,
      "vir_gone",
      "acme/alpha",
      NO_PROJECT_FILTER,
    ]) {
      const keepsEverything = cards.every((c) =>
        taskMatchesProjectFilter(c, filterId, index),
      );
      if (!projectFilterNarrows(filterId, index)) {
        expect(keepsEverything).toBe(true);
      }
    }
  });
});

describe("filterAfterCreate", () => {
  const index = buildProjectIndex([ALPHA]);

  test("keeps a filter the new card survives", () => {
    expect(
      filterAfterCreate(task({ repo: "acme/alpha" }), "acme/alpha", index),
    ).toBe("acme/alpha");
  });

  /** A card you just typed must never be invisible on the board that made it.
   *  Widening is visible; an empty lane is not. */
  test("clears a filter the new card would fall outside", () => {
    expect(filterAfterCreate(task(), "acme/alpha", index)).toBeNull();
  });

  test("leaves an unfiltered board unfiltered", () => {
    expect(filterAfterCreate(task(), null, index)).toBeNull();
  });
});

describe("stampableEntries", () => {
  /** `task_board_items.repo` is the only per-card link, so a project pinning
   *  no repository has nothing a card can point at. */
  test("offers only buckets a card can be stamped with", () => {
    const index = buildProjectIndex([ALPHA, BARE], ["acme/orphan"]);
    expect(stampableEntries(index).map((e) => e.id)).toEqual([
      "acme/alpha",
      "acme/orphan",
    ]);
  });
});
