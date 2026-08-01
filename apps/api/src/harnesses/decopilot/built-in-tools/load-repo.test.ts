import { expect, test } from "bun:test";
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
