/**
 * The CMS-mode gate is per BRANCH, not per project.
 *
 * A CMS project starts sandbox-less: `/api/:org/sandbox/:vmcpId/:branch/git/*`
 * is answered from the GitHub API so the header and publish dialog work with no
 * working tree behind them. Recording a sandbox for one branch moves THAT branch
 * onto the daemon — its siblings stay sandbox-less.
 *
 * Why it matters: gating on the project instead gave a branch two writers, the
 * CMS committing to the branch head while a pod edited an uncommitted working
 * tree it could no longer see. It also made vibecoding unreachable on a CMS
 * project at all, since the proxy claimed every branch with `runner: null`.
 *
 * Contract shapes are INLINED (black-box suite — no app imports):
 *   - GitHub-backed `git/status` → 200 `{ current, base, headSha, aheadOfBase,
 *     behindBase, modified: [], ... }`, i.e. a clean tree it does not have.
 *   - Daemon-backed `git/status` → never that: with no sandbox runner reachable
 *     in this environment the request fails instead.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createCmsProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/cms-project";
import { expect, newApiContext, test } from "../fixtures/test";

interface GitStatusBody {
  current?: string | null;
  base?: string;
  headSha?: string;
  modified?: string[];
  aheadOfBase?: number;
  behindBase?: number;
}

const statusUrl = (org: string, vmcpId: string, branch: string): string =>
  `/api/${org}/sandbox/${encodeURIComponent(vmcpId)}/${encodeURIComponent(branch)}/git/status`;

/**
 * Record a sandbox for one branch the way provisioning does — a
 * `sandboxMap[userId][branch][kind]` cell on the virtual MCP's metadata.
 * Written through the collection tool (whose metadata update shallow-merges),
 * so this stays a wire-level fixture with no app imports.
 */
async function recordSandboxForBranch(
  ctx: Parameters<typeof callSelfMcpTool>[0],
  org: string,
  vmcpId: string,
  userId: string,
  branch: string,
): Promise<void> {
  await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_UPDATE", {
    id: vmcpId,
    data: {
      metadata: {
        sandboxMap: {
          [userId]: {
            [branch]: {
              "agent-sandbox": {
                sandboxHandle: "vm-e2e-1",
                previewUrl: "https://vm-e2e-1.example.com",
                sandboxProviderKind: "agent-sandbox",
              },
            },
          },
        },
      },
    },
  });
}

test.describe("CMS mode is gated per branch", () => {
  test("a sandbox on one branch moves only that branch off the GitHub-backed path", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      await seedStubRepo(ctx, {
        owner,
        repo: "site",
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/hero.json": "{}\n" } },
          "draft-a": { files: { ".deco/blocks/hero.json": "{}\n" } },
          "draft-b": { files: { ".deco/blocks/hero.json": "{}\n" } },
        },
      });
      const project = await createCmsProject(ctx, user.orgSlug, {
        owner,
        repo: "site",
      });

      // Both drafts start sandbox-less: GitHub answers, and reports the clean
      // tree of a project that has none.
      for (const branch of ["draft-a", "draft-b"]) {
        const res = await ctx.get(
          statusUrl(user.orgSlug, project.vmcpId, branch),
        );
        expect(
          res.ok(),
          `${branch} should be GitHub-backed before any sandbox exists`,
        ).toBe(true);
        const body = (await res.json()) as GitStatusBody;
        expect(body.headSha, `${branch} headSha`).toBeTruthy();
        expect(body.base).toBe("main");
        expect(body.modified ?? []).toEqual([]);
      }

      await recordSandboxForBranch(
        ctx,
        user.orgSlug,
        project.vmcpId,
        user.userId,
        "draft-a",
      );

      // draft-a now belongs to the daemon. No runner is reachable here, so the
      // request fails rather than quietly returning GitHub's view of the branch
      // — which is the bug this gate exists to prevent.
      const claimed = await ctx.get(
        statusUrl(user.orgSlug, project.vmcpId, "draft-a"),
      );
      expect(
        claimed.ok(),
        "draft-a must leave the GitHub-backed path once it has a sandbox",
      ).toBe(false);

      // The sibling is untouched: this is the per-branch half of the contract.
      const sibling = await ctx.get(
        statusUrl(user.orgSlug, project.vmcpId, "draft-b"),
      );
      expect(
        sibling.ok(),
        "draft-b has no sandbox and must stay GitHub-backed",
      ).toBe(true);
      const siblingBody = (await sibling.json()) as GitStatusBody;
      expect(siblingBody.base).toBe("main");
      expect(siblingBody.modified ?? []).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });

  test("a project without the CMS gate is never GitHub-backed", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const plain = await callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        user.orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: { title: `plain ${Date.now()}`, metadata: {}, connections: [] },
        },
      );
      const res = await ctx.get(
        statusUrl(user.orgSlug, plain.item.id, "some-branch"),
      );
      expect(res.ok()).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});
