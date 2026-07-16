import { expect, test } from "bun:test";
import {
  buildDescription,
  parseCloneProbe,
  selectLoadableRepos,
} from "./load-repo";

test("buildDescription lists each repo with its connectionId", () => {
  const desc = buildDescription([
    { connectionId: "conn_a", owner: "acme", repo: "web", installationId: 1 },
    { connectionId: "conn_b", owner: "acme", repo: "api", installationId: 2 },
  ]);
  expect(desc).toContain("acme/web (connectionId: conn_a)");
  expect(desc).toContain("acme/api (connectionId: conn_b)");
  // The model is told to pass a connectionId.
  expect(desc).toContain("connectionId of the repo to load");
});

const repoScope = (owner: string, repo: string) => ({
  installationId: 7,
  owner,
  repo,
  permissions: {},
});

test("selectLoadableRepos keeps active org-shared repo connections", () => {
  const repos = selectLoadableRepos([
    {
      id: "conn_shared",
      status: "active",
      metadata: { orgShared: true, repoScope: repoScope("acme", "web") },
    },
  ]);
  expect(repos).toEqual([
    {
      connectionId: "conn_shared",
      owner: "acme",
      repo: "web",
      installationId: 7,
    },
  ]);
});

test("selectLoadableRepos excludes per-agent-private repos (no orgShared)", () => {
  const repos = selectLoadableRepos([
    {
      id: "conn_private",
      status: "active",
      metadata: { repoScope: repoScope("acme", "secret") },
    },
  ]);
  expect(repos).toEqual([]);
});

test("selectLoadableRepos excludes inactive and non-repo connections", () => {
  const repos = selectLoadableRepos([
    {
      id: "conn_inactive",
      status: "inactive",
      metadata: { orgShared: true, repoScope: repoScope("acme", "web") },
    },
    // Base org mcp-github connection — org-shared marker absent AND no repoScope.
    { id: "conn_base", status: "active", metadata: {} },
  ]);
  expect(repos).toEqual([]);
});

test("parseCloneProbe reports cloned when the marker is present", () => {
  const { cloned, listing } = parseCloneProbe(
    "__CLONED__\npackage.json\nsrc\n.git\n",
  );
  expect(cloned).toBe(true);
  expect(listing).toBe("package.json\nsrc");
});

test("parseCloneProbe never leaks the marker into the listing", () => {
  // Marker without a trailing newline must not appear as a file entry.
  const { cloned, listing } = parseCloneProbe("__CLONED__");
  expect(cloned).toBe(true);
  expect(listing).toBe("");
});

test("parseCloneProbe reports cloned when files exist without the marker", () => {
  const { cloned, listing } = parseCloneProbe("README.md\n");
  expect(cloned).toBe(true);
  expect(listing).toBe("README.md");
});

test("parseCloneProbe reports not-cloned for empty or .git-only output", () => {
  expect(parseCloneProbe("")).toEqual({ cloned: false, listing: "" });
  expect(parseCloneProbe(".git\n")).toEqual({ cloned: false, listing: "" });
});
