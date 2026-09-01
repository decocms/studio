/**
 * Deployment-admin prompt editor: read the hardcoded agent prompts from
 * `decocms/studio` HEAD, edit them, and ship the edit as a pull request.
 *
 * The prompts STAY hardcoded — nothing here makes the running deployment read a
 * prompt from the database. The edit path is the ordinary one (commit + PR +
 * review + deploy); this surface only removes the "open an editor, find the
 * template literal" step for the people who tune these prompts.
 *
 * Credentials are the acting admin's own: a GitHub connection from one of their
 * own organizations (see `resolveActorOrg`), resolved the same way the task
 * board resolves one. So the PR is authored by whoever pressed the button, and
 * an admin with no GitHub connected anywhere gets a 400 rather than a shared
 * service identity writing on their behalf.
 *
 * Mounted by `admin.ts`, therefore already behind `requireDeploymentAdmin`.
 */
import { Hono } from "hono";
import type { Env } from "@/api/hono-env";
import {
  createGitDataClient,
  type GitDataClient,
} from "@/decofile/github-git-data";
import { githubConnectionAccessToken } from "@/oauth/github-mint";
import { resolveGithubConnection } from "@/tools/task-board/prs-get";
import {
  extractPromptRegion,
  replacePromptRegion,
} from "./admin-prompt-region";

/** The repo the prompts live in — this one. */
const PROMPT_REPO = { owner: "decocms", repo: "studio" } as const;

/**
 * The editable prompts, each addressed by the marker pair that fences it in its
 * source file (see `admin-prompt-region.ts`) — the persona, which is the part
 * worth editing, not the scaffolding the builder wraps around it.
 *
 * Adding a prompt here = wrapping it in a marker pair + one line below.
 */
const PROMPTS = [
  {
    id: "reviewer",
    label: "Reviewer",
    path: "apps/api/src/tools/task-board/enqueue-reviewer.ts",
  },
  {
    id: "super-agent-sandbox",
    label: "Super Agent (sandbox)",
    path: "apps/api/src/tools/task-board/claude-code-task-run.ts",
  },
  {
    id: "super-agent",
    label: "Super Agent (hosted)",
    path: "apps/api/src/tools/task-board/enqueue-super-agent.ts",
  },
] as const;

type PromptId = (typeof PROMPTS)[number]["id"];

export class PromptEditorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

type Ctx = Env["Variables"]["studioContext"];

/**
 * The acting admin's organization to borrow a GitHub connection from.
 *
 * `ctx.organization` is NOT usable here: this surface is instance-level, so
 * there is no org slug in the path for `resolveOrgFromPath` to read, and a
 * browser session's `activeOrganizationId` is frequently null (it is on every
 * local-mode session). So resolve it from the admin's own memberships instead,
 * picking the oldest org that actually has an active GitHub connection.
 *
 * Deterministic rather than chosen: an admin in several connected orgs gets the
 * same one every time, and the response names it so the page can show whose
 * GitHub is about to author the PR. A picker can come when someone needs one.
 */
async function resolveActorOrg(
  ctx: Ctx,
): Promise<{ id: string; slug: string; name: string }> {
  const userId = ctx.auth.user?.id;
  if (!userId) {
    throw new PromptEditorError("Unauthorized", 400);
  }
  const row = await ctx.db
    .selectFrom("member")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .innerJoin("connections", "connections.organization_id", "organization.id")
    .select([
      "organization.id as id",
      "organization.slug as slug",
      "organization.name as name",
    ])
    .where("member.userId", "=", userId)
    .where("connections.slug", "=", "mcp-github")
    .where("connections.status", "=", "active")
    .orderBy("organization.createdAt", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new PromptEditorError(
      "None of your organizations has GitHub connected — connect it, then reload",
      400,
    );
  }
  return row;
}

/** A GitHub client on the acting admin's own connection. */
async function clientForActor(
  ctx: Ctx,
): Promise<{ gh: GitDataClient; org: { slug: string; name: string } }> {
  const org = await resolveActorOrg(ctx);
  // The mint path for a repo-scoped child connection reads `ctx.organization`,
  // which is exactly what this route doesn't have — bind the resolved org so
  // both the lookup and the token agree on one scope.
  const orgCtx: Ctx = { ...ctx, organization: org };
  const connection = await resolveGithubConnection(orgCtx, org.id, null, {
    owner: PROMPT_REPO.owner,
    name: PROMPT_REPO.repo,
  });
  if (!connection) {
    throw new PromptEditorError(
      "Connect GitHub in this organization to edit prompts",
      400,
    );
  }
  const accessToken = await githubConnectionAccessToken(orgCtx, connection);
  if (!accessToken) {
    throw new PromptEditorError("Reconnect GitHub to edit prompts", 400);
  }
  return {
    gh: createGitDataClient({ ...PROMPT_REPO, accessToken }),
    org: { slug: org.slug, name: org.name },
  };
}

/**
 * Splice every edit into `sources` (mutated in place). A region can vanish
 * between the GET that populated the editor and this POST — the file itself
 * was reverted, or the registry and the source drifted — and `baseSha`
 * doesn't catch every such case (a caller can post an edit without ever
 * having loaded the current HEAD). `replacePromptRegion` throws a plain
 * `Error` for that; surface it the same way `readSources` already does for
 * a moved file, instead of letting it fall through to a generic 500.
 */
export function applyPromptEdits(
  sources: Map<string, string>,
  edits: { id: PromptId; content: string }[],
): void {
  for (const edit of edits) {
    const prompt = PROMPTS.find((p) => p.id === edit.id)!;
    try {
      sources.set(
        prompt.path,
        replacePromptRegion(sources.get(prompt.path)!, prompt.id, edit.content),
      );
    } catch {
      throw new PromptEditorError(
        `Prompt "${edit.id}" no longer has a marked region in ${prompt.path} — reload and re-apply your edit`,
        409,
      );
    }
  }
}

/** Every distinct source file the registry touches, read once at `ref`. */
async function readSources(
  gh: GitDataClient,
  ref: string,
): Promise<Map<string, string>> {
  const paths = [...new Set(PROMPTS.map((p) => p.path))];
  const texts = await Promise.all(
    paths.map((path) => gh.getFileTextAtRef(ref, path)),
  );
  const sources = new Map<string, string>();
  paths.forEach((path, i) => {
    const text = texts[i];
    if (text == null) {
      throw new PromptEditorError(`${path} no longer exists at ${ref}`, 409);
    }
    sources.set(path, text);
  });
  return sources;
}

export function createAdminPromptRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/prompts", async (c) => {
    const { gh, org } = await clientForActor(c.get("studioContext"));
    const branch = await gh.getDefaultBranch();
    // Pin the read to the commit, not the branch: the sha goes back to the
    // client and is what a save is written against, so a push landing between
    // the two can be reported as a conflict instead of silently reverted.
    const baseSha = await gh.getHeadSha(branch);
    const sources = await readSources(gh, baseSha);

    return c.json({
      repo: `${PROMPT_REPO.owner}/${PROMPT_REPO.repo}`,
      branch,
      baseSha,
      // Whose GitHub connection will author the PR — the page shows it, since
      // the org was resolved here rather than chosen by the operator.
      org: org.slug || org.name,
      prompts: PROMPTS.map((prompt) => ({
        ...prompt,
        content: extractPromptRegion(sources.get(prompt.path) ?? "", prompt.id),
      })),
    });
  });

  app.post("/prompts/pull-request", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown;
      baseSha?: unknown;
      edits?: unknown;
    };
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : "chore(prompts): edit agent prompts";
    const known = new Set<string>(PROMPTS.map((p) => p.id));
    const edits = (Array.isArray(body.edits) ? body.edits : [])
      .filter(
        (e): e is { id: PromptId; content: string } =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { id?: unknown }).id === "string" &&
          known.has((e as { id: string }).id) &&
          typeof (e as { content?: unknown }).content === "string" &&
          (e as { content: string }).content.trim().length > 0,
      )
      .map((e) => ({ id: e.id, content: e.content }));
    if (edits.length === 0) {
      return c.json({ error: "No prompt edits to commit" }, 400);
    }

    const { gh } = await clientForActor(c.get("studioContext"));
    const base = await gh.getDefaultBranch();
    const baseSha = await gh.getHeadSha(base);
    if (typeof body.baseSha === "string" && body.baseSha !== baseSha) {
      // The editor loaded an older HEAD; committing its text would revert
      // whatever landed since. The client reloads and the operator re-applies.
      return c.json(
        {
          error:
            "The prompts changed on GitHub since this page loaded — reload and re-apply your edit",
        },
        409,
      );
    }

    // Splice against the exact parent commit's content so an unedited prompt in
    // the same file is carried over verbatim rather than reverted.
    const sources = await readSources(gh, baseSha);
    applyPromptEdits(sources, edits);

    const changedPaths = [
      ...new Set(edits.map((e) => PROMPTS.find((p) => p.id === e.id)!.path)),
    ];
    const entries = await Promise.all(
      changedPaths.map(async (path) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: await gh.createBlob(sources.get(path)!),
      })),
    );

    const treeSha = await gh.createTree(
      await gh.getCommitTreeSha(baseSha),
      entries,
    );
    const commitSha = await gh.createCommit({
      message: title,
      treeSha,
      parentShas: [baseSha],
    });
    const branch = `admin/prompts-${Date.now().toString(36)}`;
    await gh.createRef(branch, commitSha);
    const pr = await gh.createPullRequest({ base, head: branch, title });

    return c.json({ number: pr.number, url: pr.html_url, branch });
  });

  app.onError((error, c) => {
    if (error instanceof PromptEditorError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  });

  return app;
}
