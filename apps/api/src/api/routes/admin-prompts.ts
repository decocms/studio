/**
 * Deployment-admin prompt editor: read the hardcoded agent prompts from
 * `decocms/studio` HEAD, edit them, and ship the edit as a pull request.
 *
 * The prompts STAY hardcoded — nothing here makes the running deployment read a
 * prompt from the database. The edit path is the ordinary one (commit + PR +
 * review + deploy); this surface only removes the "open an editor, find the
 * template literal" step for the people who tune these prompts.
 *
 * Credentials are the acting admin's own: the org GitHub connection of their
 * active organization, the same one the task board uses. So the PR is authored
 * by whoever pressed the button, and an admin without GitHub connected gets a
 * 400 rather than a shared service identity writing on their behalf.
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
 * source file (see `admin-prompt-region.ts`). Two entries share
 * `enqueue-reviewer.ts`: QA and Code Review are one builder with a per-reviewer
 * persona, and the persona is the part worth editing.
 *
 * Adding a prompt here = wrapping it in a marker pair + one line below.
 */
const PROMPTS = [
  {
    id: "qa-agent",
    label: "QA Agent",
    path: "apps/api/src/tools/task-board/enqueue-reviewer.ts",
  },
  {
    id: "code-reviewer",
    label: "Code Reviewer",
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

class PromptEditorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** A GitHub client on the acting admin's own connection. */
async function clientForActor(
  ctx: Env["Variables"]["studioContext"],
): Promise<GitDataClient> {
  const orgId = ctx.organization?.id;
  if (!orgId) {
    throw new PromptEditorError(
      "No active organization — open Studio in an organization first",
      400,
    );
  }
  const connection = await resolveGithubConnection(ctx, orgId, null, {
    owner: PROMPT_REPO.owner,
    name: PROMPT_REPO.repo,
  });
  if (!connection) {
    throw new PromptEditorError(
      "Connect GitHub in this organization to edit prompts",
      400,
    );
  }
  const accessToken = await githubConnectionAccessToken(ctx, connection);
  if (!accessToken) {
    throw new PromptEditorError("Reconnect GitHub to edit prompts", 400);
  }
  return createGitDataClient({ ...PROMPT_REPO, accessToken });
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
    const gh = await clientForActor(c.get("studioContext"));
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

    const gh = await clientForActor(c.get("studioContext"));
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
    for (const edit of edits) {
      const prompt = PROMPTS.find((p) => p.id === edit.id)!;
      sources.set(
        prompt.path,
        replacePromptRegion(sources.get(prompt.path)!, prompt.id, edit.content),
      );
    }

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
