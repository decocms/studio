/**
 * End-to-end contract for "Get latest" on a sandbox-less Fast Preview project:
 *
 *   POST /api/:org/sandbox/:virtualMcpId/:branch/git/rebase   { base }
 *
 * The contract this suite pins is the SHAPE of the result, because that is what
 * everything downstream depends on: after a sync the branch is exactly ONE
 * commit whose single parent is the base head. It is not a merge commit — a
 * merge's conflict resolution lives only in its tree, and `git rebase` drops
 * merge commits, so anyone who pulled the branch and rebased onto the base got
 * the resolved conflicts back.
 *
 * Content resolution is asserted alongside it and is deliberately
 * branch-favoured, with no way to ask for anything else: on a git-level
 * conflict the branch's version of every file it touched wins WHOLE FILE,
 * while files only the base changed come along.
 *
 * All GitHub traffic lands on the local Git Data stub (fixtures/github-stub.ts).
 * Contract shapes are INLINED (black-box suite — no app imports).
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  type FastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  setStubMergeMode,
  type StubRepoInspection,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { expect, newApiContext, test } from "../fixtures/test";

const decofileUrl = (p: FastPreviewProject, branch: string): string =>
  `/api/${p.org}/decofile/${p.vmcpId}/${branch}`;

const rebaseUrl = (p: FastPreviewProject, branch: string): string =>
  `/api/${p.org}/sandbox/${p.vmcpId}/${branch}/git/rebase`;

/** One decofile write = one commit on `branch`. */
async function writeBlock(
  ctx: APIRequestContext,
  project: FastPreviewProject,
  branch: string,
  key: string,
  value: unknown,
): Promise<void> {
  const res = await ctx.patch(decofileUrl(project, branch), {
    data: { set: { [key]: value } },
    headers: { "Content-Type": "application/json" },
  });
  expect(res.ok()).toBe(true);
}

function commitOf(
  repo: StubRepoInspection,
  sha: string,
): { sha: string; message: string; parents: string[] } {
  const commit = repo.commits.find((c) => c.sha === sha);
  expect(commit, `commit ${sha} missing from the stub log`).toBeTruthy();
  return commit as { sha: string; message: string; parents: string[] };
}

test.describe("fast preview git sync", () => {
  test("a clean sync leaves the branch as ONE commit parented on base, keeping base-only files", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      const repo = "site";
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo,
      });
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
          draft: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
        },
      });

      // Several commits on the branch, and one on base it does not have.
      await writeBlock(ctx, project, "draft", "Hero", { n: 2 });
      await writeBlock(ctx, project, "draft", "Hero", { n: 3 });
      await writeBlock(ctx, project, "main", "Footer", { f: 1 });

      const before = await inspectStubRepo(ctx, owner, repo);
      const baseHead = before.refs["main"] as string;

      const res = await ctx.post(rebaseUrl(project, "draft"), {
        data: { base: "main" },
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status()).toBe(200);

      const after = await inspectStubRepo(ctx, owner, repo);
      const head = commitOf(after, after.refs["draft"] as string);
      // THE contract: one commit, one parent, and that parent is the base head.
      expect(head.parents).toEqual([baseHead]);
      expect(after.refs["main"]).toBe(baseHead);

      const files = after.branches["draft"]?.files ?? {};
      expect(JSON.parse(files[".deco/blocks/Hero.json"] as string)).toEqual({
        n: 3,
      });
      // Base-only work survives the sync.
      expect(JSON.parse(files[".deco/blocks/Footer.json"] as string)).toEqual({
        f: 1,
      });
    } finally {
      await ctx.dispose();
    }
  });

  test("a conflict resolves branch-wins — nothing in the body asks for it — keeping the one-commit shape and the branch's whole file", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      const repo = "site";
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo,
      });
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
          draft: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
        },
      });

      await writeBlock(ctx, project, "draft", "Hero", { editor: "wins" });
      await writeBlock(ctx, project, "main", "Hero", { base: "loses" });
      await writeBlock(ctx, project, "main", "Footer", { f: 1 });
      await setStubMergeMode(ctx, owner, repo, "conflict");

      const before = await inspectStubRepo(ctx, owner, repo);
      const baseHead = before.refs["main"] as string;

      const res = await ctx.post(rebaseUrl(project, "draft"), {
        data: { base: "main" },
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status()).toBe(200);

      const after = await inspectStubRepo(ctx, owner, repo);
      const head = commitOf(after, after.refs["draft"] as string);
      expect(head.parents).toEqual([baseHead]);
      expect(head.message).toContain("branch content wins");

      const files = after.branches["draft"]?.files ?? {};
      // Whole-file branch-wins: the editor's block, not the base's.
      expect(JSON.parse(files[".deco/blocks/Hero.json"] as string)).toEqual({
        editor: "wins",
      });
      // A path only the base touched is untouched by the overwrite.
      expect(JSON.parse(files[".deco/blocks/Footer.json"] as string)).toEqual({
        f: 1,
      });
    } finally {
      await ctx.dispose();
    }
  });

  test("syncing an already-current branch is a no-op — no new commit, no force-push", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      const repo = "site";
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo,
      });
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
          draft: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
        },
      });

      // Drift on both sides, so the FIRST call really squashes something.
      await writeBlock(ctx, project, "draft", "Hero", { n: 2 });
      await writeBlock(ctx, project, "draft", "Hero", { n: 3 });
      await writeBlock(ctx, project, "main", "Footer", { f: 1 });

      const before = await inspectStubRepo(ctx, owner, repo);
      const draftHeadBefore = before.refs["draft"] as string;

      const first = await ctx.post(rebaseUrl(project, "draft"), {
        data: { base: "main" },
        headers: { "Content-Type": "application/json" },
      });
      expect(first.status()).toBe(200);

      const settled = await inspectStubRepo(ctx, owner, repo);
      const head = settled.refs["draft"] as string;
      expect(head).not.toBe(draftHeadBefore);
      expect(commitOf(settled, head).parents).toEqual([before.refs["main"]]);

      const second = await ctx.post(rebaseUrl(project, "draft"), {
        data: { base: "main" },
        headers: { "Content-Type": "application/json" },
      });
      expect(second.status()).toBe(200);

      const after = await inspectStubRepo(ctx, owner, repo);
      expect(after.refs["draft"]).toBe(head);
    } finally {
      await ctx.dispose();
    }
  });
});
