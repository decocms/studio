import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { buildProjectTree } from "./project-tree";

function project(
  id: string,
  title: string,
  opts: { repo?: string } = {},
): VirtualMCPEntity {
  const [owner, name] = (opts.repo ?? "/").split("/");
  return {
    id,
    title,
    created_at: "2026-01-01T00:00:00Z",
    metadata: opts.repo
      ? { githubRepo: { url: `https://github.com/${opts.repo}`, owner, name } }
      : {},
  } as unknown as VirtualMCPEntity;
}

const names = (projects: readonly VirtualMCPEntity[]) =>
  projects.map((p) => p.title);

describe("buildProjectTree", () => {
  test("splits projects with a repository from those without", () => {
    const tree = buildProjectTree([
      project("a", "Farm", { repo: "deco-sites/farmrio" }),
      project("b", "Tracking"),
      project("c", "Osklen", { repo: "deco-sites/osklenbr" }),
    ]);

    expect(tree.folders.map((f) => f.kind)).toEqual(["code", "other"]);
    expect(names(tree.folders[0]!.projects)).toEqual(["Farm", "Osklen"]);
    expect(names(tree.folders[1]!.projects)).toEqual(["Tracking"]);
    expect(tree.loose).toEqual([]);
  });

  test("keeps each folder in the org's own order, not sorted by title", () => {
    const tree = buildProjectTree([
      project("a", "Zebra", { repo: "acme/zebra" }),
      project("b", "Alpha", { repo: "acme/alpha" }),
      project("c", "Loose"),
    ]);

    expect(names(tree.folders[0]!.projects)).toEqual(["Zebra", "Alpha"]);
  });

  test("all-code is the flat list — a lid over every row says nothing", () => {
    const tree = buildProjectTree([
      project("a", "Farm", { repo: "deco-sites/farmrio" }),
      project("b", "Osklen", { repo: "deco-sites/osklenbr" }),
    ]);

    expect(tree.folders).toEqual([]);
    expect(names(tree.loose)).toEqual(["Farm", "Osklen"]);
  });

  test("no project with a repository is the flat list too", () => {
    const tree = buildProjectTree([
      project("a", "Tracking"),
      project("b", "GA4"),
    ]);

    expect(tree.folders).toEqual([]);
    expect(names(tree.loose)).toEqual(["Tracking", "GA4"]);
  });

  test("an empty org has nothing to draw", () => {
    expect(buildProjectTree([])).toEqual({ folders: [], loose: [] });
  });

  test("a repository whose url is empty is not code", () => {
    const bare = {
      id: "a",
      title: "Half-connected",
      metadata: { githubRepo: { url: "", owner: "", name: "" } },
    } as unknown as VirtualMCPEntity;

    const tree = buildProjectTree([
      bare,
      project("b", "Farm", { repo: "deco-sites/farmrio" }),
    ]);

    expect(names(tree.folders[1]!.projects)).toEqual(["Half-connected"]);
  });
});
