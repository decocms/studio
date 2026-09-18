/**
 * PR-resolve route — `GET /api/_pr-resolve?owner=&repo=&pr=`.
 *
 * Powers the `deco.studio/<owner>/<repo>/<pr>` shortlink: the cheapest way to
 * hand a teammate a branch to collaborate on. The `/$repoOwner/$repoName/$prNumber`
 * page calls this endpoint to find where the caller can open that pull request
 * and which branch it proposes.
 *
 * Resolution is relative to the authenticated user, exactly like
 * `editor-resolve.ts`: the same repository can be imported into several orgs,
 * so we scan the orgs the caller is a member of and return every project bound
 * to `<owner>/<repo>`. Access is implicit (orgs the caller isn't in never
 * appear — no leak, no false 403), and the page can offer a picker when the
 * repo lives in more than one of the caller's orgs.
 *
 * For each match we also resolve, through that org's own credential for the
 * repository:
 *   - `branch` — the change request's HEAD branch, which is what "open it on
 *     the right branch" means. A match whose PR cannot be read at all is still
 *     returned with `branch: null`, so the page can send the user to the
 *     project rather than to a dead end.
 *   - `threadId` — the caller's most recently touched chat already pinned to
 *     that branch in that project, so the link resumes a conversation instead
 *     of minting a second one next to it.
 */

import { Hono } from "hono";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import type { GithubRepo } from "@decocms/shared/sdk/types";
import type { Env } from "../hono-env";
import { getUserId, type StudioContext } from "@/core/studio-context";
import {
  changeRequestClientForTarget,
  repoTargetForBinding,
} from "@/git-providers";

/** One place the caller can open the change request: an (org, project) pair. */
interface PrMatch {
  orgId: string;
  orgSlug: string;
  orgName: string;
  project: { id: string; title: string; icon: string | null };
  /** Branch the change request proposes, or null when it could not be read. */
  branch: string | null;
  /** An existing chat of the caller's on that branch, when there is one. */
  threadId: string | null;
}

interface PrResolveResult {
  matches: PrMatch[];
}

/** GitHub's own limits: owner ≤ 39 chars, repo ≤ 100, both restricted charsets. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The project's repository binding, when it names `<owner>/<repo>`.
 *
 * Compared case-insensitively because a shortlink is typed by a human and
 * GitHub itself is case-insensitive on both segments. The metadata bag isn't
 * centrally schematized, so this stays loosely typed — same as
 * `hasClonableSource` in `editor-resolve.ts`.
 */
function repoBinding(
  metadata: unknown,
  owner: string,
  repo: string,
): GithubRepo | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const meta = metadata as { githubRepo?: GithubRepo | null };
  const binding = meta.githubRepo;
  if (!binding || typeof binding.url !== "string" || !binding.url) return null;
  if (typeof binding.owner !== "string" || typeof binding.name !== "string") {
    return null;
  }
  if (binding.owner.toLowerCase() !== owner) return null;
  if (binding.name.toLowerCase() !== repo) return null;
  return binding;
}

/**
 * The change request's head branch, or null when it cannot be read.
 *
 * Null covers a revoked grant, a repository this org's credential cannot see
 * and a deleted change request alike: none of them may sink the lookup, since
 * opening the project is still better than a dead end.
 */
async function headBranch(
  ctx: StudioContext,
  organizationId: string,
  binding: GithubRepo,
  number: number,
): Promise<string | null> {
  try {
    const client = await changeRequestClientForTarget(
      ctx,
      organizationId,
      repoTargetForBinding(binding),
    );
    const changeRequest = await client?.read(number);
    return changeRequest?.head ?? null;
  } catch {
    return null;
  }
}

export function createPrResolveRoutes() {
  const app = new Hono<Env>();

  // Per-user result — never let a shared/heuristic cache hold it.
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Cookie");
  });

  app.get("/", async (c) => {
    const ctx = c.get("studioContext");

    // Instance-level route: guard auth ourselves (the page is auth-gated too).
    const userId = getUserId(ctx);
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const owner = (c.req.query("owner") ?? "").trim().toLowerCase();
    const repo = (c.req.query("repo") ?? "").trim().toLowerCase();
    const number = Number(c.req.query("pr") ?? "");
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
      return c.json({ error: "Invalid repository" }, 400);
    }
    if (!Number.isSafeInteger(number) || number <= 0) {
      return c.json({ error: "Invalid pull request number" }, 400);
    }

    // The caller's orgs (access is implicit — we never look outside them).
    const orgs = await ctx.db
      .selectFrom("member")
      .innerJoin("organization", "organization.id", "member.organizationId")
      .select([
        "organization.id as id",
        "organization.slug as slug",
        "organization.name as name",
        "organization.metadata as metadata",
      ])
      .where("member.userId", "=", userId)
      .execute();

    const matches: PrMatch[] = [];
    for (const org of orgs) {
      if (!org.slug || isOrgArchived(org)) continue;
      const vms = await ctx.storage.virtualMcps.list(org.id);
      for (const vm of vms) {
        const binding = repoBinding(vm.metadata, owner, repo);
        if (!binding) continue;

        const branch = await headBranch(ctx, org.id, binding, number);
        const thread = branch
          ? await ctx.db
              .selectFrom("threads")
              .select("id")
              .where("organization_id", "=", org.id)
              .where("virtual_mcp_id", "=", vm.id)
              .where("branch", "=", branch)
              .where("created_by", "=", userId)
              .orderBy("updated_at", "desc")
              .limit(1)
              .executeTakeFirst()
          : null;

        matches.push({
          orgId: org.id,
          orgSlug: org.slug,
          orgName: org.name ?? org.slug,
          project: { id: vm.id, title: vm.title, icon: vm.icon ?? null },
          branch,
          threadId: thread?.id ?? null,
        });
      }
    }

    const result: PrResolveResult = { matches };
    return c.json(result);
  });

  return app;
}
