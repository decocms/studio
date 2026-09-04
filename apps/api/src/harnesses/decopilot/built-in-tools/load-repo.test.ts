import { expect, test } from "bun:test";
import type { RepoChoice } from "@/git-providers/repo-choices";
import {
  buildDescription,
  createLoadRepoTool,
  parseCloneProbe,
  selectLoadableRepos,
} from "./load-repo";

test("createLoadRepoTool is super-agent-only", async () => {
  // A non-decopilot agent gets no tool — and the check happens before any
  // storage access, so a bare ctx suffices.
  const args = {
    ctx: {} as never,
    orgId: "org_1",
    userId: "user_1",
    threadId: "thread_1",
    writer: {} as never,
  };
  expect(
    await createLoadRepoTool({ ...args, virtualMcpId: "vm_regular_agent" }),
  ).toBeNull();
  await expect(
    createLoadRepoTool({ ...args, virtualMcpId: "decopilot_org_1" }),
  ).rejects.toThrow(); // got past the gate, then hit the empty ctx
});

const choice = (
  id: string,
  label: string,
  overrides?: Partial<RepoChoice>,
): RepoChoice => ({
  id,
  owner: "acme",
  name: "web",
  label,
  webUrl: "https://github.com/acme/web",
  repository: null,
  connectionId: id,
  installationId: 1,
  ...overrides,
});

test("buildDescription lists each repo with its opaque id", () => {
  const desc = buildDescription([
    choice("conn_a", "acme/web (github.com)"),
    choice("repo_b", "group/sub/api (gitlab.acme.com)", {
      connectionId: null,
      installationId: undefined,
    }),
  ]);
  expect(desc).toContain("acme/web (github.com) (id: conn_a)");
  expect(desc).toContain("group/sub/api (gitlab.acme.com) (id: repo_b)");
  // The model is told to pass an id, and the copy is provider-neutral.
  expect(desc).toContain("Pass the id of the repo to load");
  expect(desc).not.toContain("GitHub");
  expect(desc).not.toContain("connectionId");
});

const repoScope = (owner: string, repo: string) => ({
  installationId: 7,
  owner,
  repo,
  permissions: {},
});

test("selectLoadableRepos lists every imported repo — org-shared AND per-agent", () => {
  // Both are the user's own org repos; both are loadable. `orgShared` only
  // governs auto-injection into other agents' toolsets, not load_repo's list.
  const repos = selectLoadableRepos([
    {
      id: "conn_shared",
      status: "active",
      metadata: { orgShared: true, repoScope: repoScope("acme", "web") },
    },
    {
      id: "conn_peragent",
      status: "active",
      metadata: { repoScope: repoScope("acme", "api") },
    },
  ]);
  expect(repos).toEqual([
    {
      connectionId: "conn_shared",
      owner: "acme",
      repo: "web",
      installationId: 7,
    },
    {
      connectionId: "conn_peragent",
      owner: "acme",
      repo: "api",
      installationId: 7,
    },
  ]);
});

test("selectLoadableRepos excludes inactive and non-repo connections", () => {
  const repos = selectLoadableRepos([
    {
      id: "conn_inactive",
      status: "inactive",
      metadata: { repoScope: repoScope("acme", "web") },
    },
    // Base org mcp-github connection — no repoScope.
    { id: "conn_base", status: "active", metadata: {} },
  ]);
  expect(repos).toEqual([]);
});

test("parseCloneProbe reports cloned when HEAD marker + working tree present", () => {
  const { cloned, listing } = parseCloneProbe(
    "__CLONED__\npackage.json\nsrc\n.git\n",
  );
  expect(cloned).toBe(true);
  expect(listing).toBe("package.json\nsrc");
});

test("parseCloneProbe reports NOT cloned when HEAD exists but the tree is empty", () => {
  // The clone race: the HEAD ref (marker) lands before the working tree is
  // checked out. HEAD alone must NOT count as cloned, or file tools hit an
  // empty /app/repo. (Was asserted true — inverted with the fix.)
  const { cloned, listing } = parseCloneProbe("__CLONED__");
  expect(cloned).toBe(false);
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
