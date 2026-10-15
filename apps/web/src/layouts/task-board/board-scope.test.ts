import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { scopedBoardItems } from "./board-scope";

function project(id: string, repo?: string): VirtualMCPEntity {
  return {
    id,
    title: id,
    created_at: "2026-01-01T00:00:00Z",
    metadata: repo
      ? {
          repository: {
            url: `https://github.com/${repo}`,
            owner: repo.split("/")[0],
            name: repo.split("/")[1],
          },
        }
      : {},
  } as unknown as VirtualMCPEntity;
}

/** A card, as `AttributableTask` reads one, plus an id to assert on. */
function task(
  id: string,
  link: { repo?: string; virtualMcpId?: string; stamp?: string } = {},
) {
  return {
    id,
    repo: link.repo ?? null,
    virtualMcpId: link.stamp ?? null,
    threads: [{ virtualMcpId: link.virtualMcpId ?? null }],
  };
}

const ALPHA = project("vir_a", "acme/alpha");
const BARE = project("vir_bare");

const ITEMS = [
  task("a1", { repo: "acme/alpha" }),
  task("b1", { repo: "acme/bravo" }),
  task("bare1", { virtualMcpId: "vir_bare" }),
];

describe("scopedBoardItems", () => {
  test("the org-wide board is every card, untouched", () => {
    const { items, isLoading } = scopedBoardItems({
      items: ITEMS,
      scopeId: null,
      project: null,
      projects: [],
      isLoading: false,
    });
    expect(items.map((i) => i.id)).toEqual(["a1", "b1", "bare1"]);
    expect(isLoading).toBe(false);
  });

  test("a project's board is only that project's cards", () => {
    const { items } = scopedBoardItems({
      items: ITEMS,
      scopeId: "vir_a",
      project: ALPHA,
      projects: [ALPHA, BARE],
      isLoading: false,
    });
    expect(items.map((i) => i.id)).toEqual(["a1"]);
  });

  /** The reason this narrows through `tasksForProject` and not a repo compare:
   *  a project with no repository is reached through its runs. */
  test("a repo-less project still claims the cards its runs made", () => {
    const { items } = scopedBoardItems({
      items: ITEMS,
      scopeId: "vir_bare",
      project: BARE,
      projects: [ALPHA, BARE],
      isLoading: false,
    });
    expect(items.map((i) => i.id)).toEqual(["bare1"]);
  });

  /** Two projects on one repository: each board holds only its own cards;
   *  the unstamped one waits on the org board. */
  test("a repository shared with a sibling shows only this project's cards", () => {
    const { items } = scopedBoardItems({
      items: [
        task("mine", { repo: "acme/alpha", stamp: "vir_a" }),
        task("sibling", { repo: "acme/alpha", stamp: "vir_a2" }),
        task("shared", { repo: "acme/alpha" }),
      ],
      scopeId: "vir_a",
      project: ALPHA,
      projects: [ALPHA, project("vir_a2", "acme/alpha")],
      isLoading: false,
    });
    expect(items.map((i) => i.id)).toEqual(["mine"]);
  });

  /** Without the siblings a shared repository reads as this project's alone. */
  test("a scope whose org project list has not landed is loading", () => {
    const { items, isLoading } = scopedBoardItems({
      items: ITEMS,
      scopeId: "vir_a",
      project: ALPHA,
      projects: [],
      isLoading: false,
    });
    expect(items).toEqual([]);
    expect(isLoading).toBe(true);
  });

  /** The load-bearing one: narrowing only once the project resolves paints
   *  every other project's cards for a frame. */
  test("a scope whose project has not resolved yet is loading, not empty", () => {
    const { items, isLoading } = scopedBoardItems({
      items: ITEMS,
      scopeId: "vir_a",
      project: null,
      projects: [],
      isLoading: false,
    });
    expect(items).toEqual([]);
    expect(isLoading).toBe(true);
  });

  test("a resolved scope that genuinely has no cards is not loading", () => {
    const { items, isLoading } = scopedBoardItems({
      items: [task("b1", { repo: "acme/bravo" })],
      scopeId: "vir_a",
      project: ALPHA,
      projects: [ALPHA, BARE],
      isLoading: false,
    });
    expect(items).toEqual([]);
    expect(isLoading).toBe(false);
  });

  test("the board's own loading survives every branch", () => {
    for (const scope of [
      { scopeId: null, project: null, projects: [] },
      { scopeId: "vir_a", project: ALPHA, projects: [ALPHA] },
    ]) {
      expect(
        scopedBoardItems({ items: ITEMS, ...scope, isLoading: true }).isLoading,
      ).toBe(true);
    }
  });
});
