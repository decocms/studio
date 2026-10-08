/**
 * Sandbox-less decofile API — the CMS write/read/publish surface for Fast
 * Preview projects. The branch head on GitHub IS the draft: reads merge
 * `.deco/blocks/*.json` at head, writes land as (coalesced) commits, publish
 * merges the branch into the default branch. No sandbox is involved.
 *
 *   GET    /api/:org/decofile/:virtualMcpId/:branch           read (session OR ?token=)
 *   PATCH  /api/:org/decofile/:virtualMcpId/:branch           write blocks (session)
 *   POST   /api/:org/decofile/:virtualMcpId/:branch/publish   merge into default (session)
 *   GET    /api/:org/decofile/:virtualMcpId/:branch/status    drift vs default (session)
 *   POST   /api/:org/decofile/:virtualMcpId/:branch/rpc       content protocol (session, flag)
 *
 * The surface is inert unless the virtual MCP has both a preview server URL
 * (`previewServerUrl`, legacy `productionUrl`) and a GitHub repo — what a CMS
 * session needs to render and to commit. The project's `fastPreview` switch
 * does NOT gate it; that switch only picks the runtime a NEW thread is stamped
 * with, and gating this on it would strand an already-stamped session.
 *
 * The content-protocol routes serve Blocks v8 sites on the hosted Deco CMS
 * (see `hosted/`) and exist only behind the `site_editor_content_protocol`
 * org flag. The editor's draft is an object on the delivery CDN
 * (`hosted/draft-content-storage.ts`), never a git branch: `rpc` reads main
 * with the draft layered on and saves into the draft; the session GET answers
 * a v8 project's `?__draft=` pointer (`{ draft, version }`) instead of the
 * decofile; publish commits the draft to main and releases it. `rpc` doesn't
 * need a preview server: the protocol never renders.
 *
 * Anonymous access: `resolveOrgFromPath` lets unauthenticated requests through
 * (membership is only enforced for signed-in principals), so the GET handler
 * self-enforces the signed draft token, mirroring automation-webhooks.ts.
 */

import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import {
  assertSafeDecoBlockKey,
  isReservedResolverBlockKey,
  PlaintextSecretError,
  sanitizeSecretsForPersistence,
} from "@decocms/shared/decofile";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { coAuthorFromStudioContext } from "@/lib/co-author-identity";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import {
  RepoWriteConflict,
  contentClientForProjectRepo,
  repoErrorStatus,
  type RepoContentClient,
} from "@/git-providers";
import {
  enqueueDecofilePatch,
  type DecofilePatch,
} from "@/decofile/commit-coalescer";
import { signDraftToken, verifyDraftToken } from "@/decofile/draft-token";
import { repoGitRebase } from "@/decofile/git-compat";
import { readDecofileSnapshot } from "@/decofile/read-decofile";
import {
  bareEtag,
  deliveryStore,
  draftPointerTarget,
} from "@/hosted/delivery-store";
import { deliveryPurge } from "@/hosted/delivery-purge";
import { createDraftContentStorage } from "@/hosted/draft-content-storage";
import type { DraftStore, HostedDraftRef } from "@/hosted/draft-store";
import { MainMovedError, publishDraft } from "@/hosted/publish";
import { hostedDrafts, mainIsV8, ownedProjectSite } from "@/hosted/scope";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { projectPlanningPostsForPreview } from "@/decofile/blog-draft-projection";
import { orgHasFeature } from "@/core/plan-feature-gate";
import type { Env } from "../hono-env";

interface DecofileScope {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
  packagePath: string | null;
  repository: RepositoryBinding;
  /** Present only for session-authenticated (member) requests. */
  userId: string | null;
  previewServerUrl: string | null;
  /** The public site id (`metadata.siteSlug`), the hosted CMS's key. */
  site: string | null;
}

type DecofileEnv = Env & {
  Variables: Env["Variables"] & { decofileScope: DecofileScope };
};

const BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/;

function isValidBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    !branch.includes("..") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock") &&
    BRANCH_RE.test(branch)
  );
}

// Bounds the tree write GitHub does for one commit.
const MAX_PATCH_KEYS = 500;

// Bounds one block's own size — fits real multivariate page blocks that inline a section tree per variant.
const MAX_BLOCK_BYTES = 1024 * 1024;

// Bounds one block key's length — a key becomes a GitHub tree path.
const MAX_BLOCK_KEY_LENGTH = 1024;

// Bounds the raw request body, before it's parsed into memory.
const MAX_PATCH_BODY_BYTES = 8 * 1024 * 1024;

export const patchBodyLimit = bodyLimit({
  maxSize: MAX_PATCH_BODY_BYTES,
  onError: (c) => c.json({ error: "Payload too large" }, 413),
});

export const patchBodySchema = z
  .object({
    set: z.record(z.string(), z.unknown()).optional(),
    delete: z.array(z.string()).optional(),
  })
  .refine(
    (b) => Object.keys(b.set ?? {}).length > 0 || (b.delete?.length ?? 0) > 0,
    { message: "Patch must set or delete at least one block" },
  )
  .refine(
    (b) =>
      Object.keys(b.set ?? {}).length + (b.delete?.length ?? 0) <=
      MAX_PATCH_KEYS,
    { message: `Patch cannot touch more than ${MAX_PATCH_KEYS} blocks` },
  )
  .refine(
    (b) =>
      Object.values(b.set ?? {}).every(
        (value) => JSON.stringify(value).length <= MAX_BLOCK_BYTES,
      ),
    { message: `Each block must be at most ${MAX_BLOCK_BYTES} bytes` },
  )
  .refine(
    (b) =>
      [...Object.keys(b.set ?? {}), ...(b.delete ?? [])].every(
        (key) => key.length <= MAX_BLOCK_KEY_LENGTH,
      ),
    {
      message: `Each block key must be at most ${MAX_BLOCK_KEY_LENGTH} characters`,
    },
  );

/**
 * Resolves the virtual MCP, enforces the Fast Preview gate and (for
 * anonymous callers) the draft token, and stashes the scope for handlers.
 */
const resolveDecofileScope = createMiddleware<DecofileEnv>(async (c, next) => {
  const ctx = c.var.studioContext;
  const organization = ctx.organization;
  if (!organization) {
    return c.json({ error: "Organization scope required" }, 500);
  }

  const virtualMcpId = c.req.param("virtualMcpId");
  const branch = c.req.param("branch");
  if (!virtualMcpId || !branch) {
    return c.json({ error: "virtualMcpId and branch are required" }, 400);
  }
  if (!isValidBranch(branch)) {
    return c.json({ error: `Invalid branch name: ${branch}` }, 400);
  }

  const userId = ctx.auth?.user?.id ?? null;
  if (!userId) {
    // Anonymous: only the plain GET is reachable, and only with a valid token.
    const token = c.req.query("token");
    const isPlainGet =
      c.req.method === "GET" && !c.req.path.match(/\/(publish|status)$/);
    if (!isPlainGet) return c.json({ error: "Unauthorized" }, 401);
    if (
      !token ||
      !verifyDraftToken(token, {
        organizationId: organization.id,
        virtualMcpId,
        branch,
      })
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  // The `cms` plan gate. These routes are the sandbox-less CMS data plane and
  // are not builtin tools, so `requiresFeature` cannot reach them. Fails OPEN
  // when the gateway has no answer; for an anonymous draft-token reader it can
  // only be answered from cache (no user to mint a JWT for), which is the
  // right bias — a shared preview link must not break on a cold instance.
  if (!(await orgHasFeature(ctx, organization.id, "cms"))) {
    return c.json(
      {
        error: "This organization's plan does not include the CMS",
        code: "feature_not_in_plan",
      },
      403,
    );
  }

  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }
  const metadata = (virtualMcp.metadata as Record<string, unknown>) ?? null;

  /** Gated on what the CMS runtime NEEDS — a preview server and (below) a repo.
   *  Never on `metadata.fastPreview`: that is the default runtime for new
   *  threads, and gating the data plane on it would strand a session already
   *  stamped `cms` the moment someone flips the switch off. */
  const previewServerUrl = resolvePreviewServerUrl(metadata);
  if (!previewServerUrl && !isContentProtocolPath(c.req.path)) {
    return c.json({ error: "Project has no preview server configured" }, 404);
  }

  const connectionIds =
    virtualMcp.connections?.map((conn) => conn.connection_id) ?? [];
  const repository = parseRepositoryBinding(metadata, connectionIds);
  if (!repository) {
    return c.json({ error: "Project has no repository" }, 404);
  }

  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  c.set("decofileScope", {
    organizationId: organization.id,
    virtualMcpId,
    branch,
    packagePath: runtime?.path?.replace(/^\/+|\/+$/g, "") || null,
    repository,
    userId,
    previewServerUrl,
    site: await ownedProjectSite(
      ctx.storage.orgSites,
      metadata,
      organization.id,
    ),
  });
  return next();
});

/** Content-protocol routes that work without a preview server. */
function isContentProtocolPath(path: string): boolean {
  return path.endsWith("/rpc");
}

/**
 * The `site_editor_content_protocol` org flag, read before a content-protocol
 * route does anything (and so before any commit). A failed read is "off":
 * the route answers 404 and the editor stays on the v7 path.
 */
async function contentProtocolEnabled(
  c: Context<DecofileEnv>,
): Promise<boolean> {
  const ctx = c.var.studioContext;
  const organizationId = c.get("decofileScope").organizationId;
  try {
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    return orgFlagEnabled(settings?.flags, "site_editor_content_protocol");
  } catch (error) {
    console.error("decofile: org settings read failed; protocol off", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The draft store and this session's draft, for a member on a flag-on org
 * with a delivery bucket configured. Null otherwise; whether the project is
 * a v8 one is the caller's question.
 */
async function hostedScope(
  c: Context<DecofileEnv>,
): Promise<{ drafts: DraftStore; ref: HostedDraftRef } | null> {
  const scope = c.get("decofileScope");
  if (!scope.userId || !scope.site) return null;
  if (!(await contentProtocolEnabled(c))) return null;
  const drafts = hostedDrafts(c.var.studioContext.storage.kv);
  if (!drafts) return null;
  return {
    drafts,
    ref: {
      organizationId: scope.organizationId,
      virtualMcpId: scope.virtualMcpId,
      branch: scope.branch,
      site: scope.site,
    },
  };
}

function signScopeDraftToken(scope: DecofileScope): string {
  return signDraftToken({
    organizationId: scope.organizationId,
    virtualMcpId: scope.virtualMcpId,
    branch: scope.branch,
  });
}

/**
 * The authority (host[:port]) the editor should bake into the `?__draft=`
 * pointer. `window.location.host` is wrong in the native app — the webview's
 * origin is the tauri-local server, which requires the app session and is
 * unreachable from a deployed preview server. This request reached the API
 * itself, so its Host (or the proxy's X-Forwarded-Host) is an authority the
 * preview server can pull the draft from anonymously.
 */
function requestApiHost(c: Context<DecofileEnv>): string {
  return c.req.header("x-forwarded-host") ?? new URL(c.req.url).host;
}

async function contentClientForScope(
  c: Context<DecofileEnv>,
): Promise<RepoContentClient> {
  const scope = c.get("decofileScope");
  return contentClientForProjectRepo(
    c.var.studioContext,
    scope.organizationId,
    scope.repository,
  );
}

function errorResponse(c: Context<DecofileEnv>, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RepoWriteConflict) return c.json({ error: message }, 409);
  const providerStatus = repoErrorStatus(err);
  if (providerStatus !== null) {
    /** 401/403 from the provider means OUR credential, not the caller's — map
     *  it to 502 so the client doesn't treat it as a Studio auth failure. */
    const status =
      providerStatus === 404
        ? 404
        : providerStatus === 409 || providerStatus === 422
          ? 409
          : 502;
    return c.json({ error: message }, status);
  }
  return c.json({ error: message }, 500);
}

export function createDecofileRoutes() {
  const app = new Hono<DecofileEnv>();

  app.use("/:virtualMcpId/:branch", resolveDecofileScope);
  app.use("/:virtualMcpId/:branch/*", resolveDecofileScope);

  app.get("/:virtualMcpId/:branch", async (c) => {
    const scope = c.get("decofileScope");
    try {
      const client = await contentClientForScope(c);
      // OPEN: O-S3 — a v8 project's editor reads its `?__draft=` pointer
      // here, in place of v7's decofile, token and API host.
      const hosted = await hostedScope(c);
      if (hosted) {
        const draft = await hosted.drafts.load(hosted.ref);
        if (
          draft ||
          (await mainIsV8(
            client,
            scope.packagePath,
            await client.getDefaultBranch(),
          ))
        ) {
          const version = bareEtag(draft?.etag);
          return c.json(
            {
              draft:
                draft && version
                  ? draftPointerTarget(hosted.ref.site, draft.slug)
                  : null,
              version,
            },
            200,
            { "Cache-Control": "no-store" },
          );
        }
      }
      const snapshot = await readDecofileSnapshot(
        client,
        scope.branch,
        scope.packagePath,
        // Thread-scoped branches are minted client-side and only materialize
        // on GitHub at first CMS touch (the sandbox flow forks locally at
        // clone time; this is the sandbox-less equivalent). Editor sessions
        // only — an anonymous draft pull of a missing branch keeps 404ing.
        { createBranchIfMissing: !!scope.userId },
      );

      const headers: Record<string, string> = {
        ETag: `"${snapshot.sha}"`,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      };
      if (c.req.header("if-none-match") === `"${snapshot.sha}"`) {
        return c.body(null, 304, headers);
      }

      // Two consumers, two shapes, distinguished by how they authenticate:
      // the production runtime (anonymous + ?token=) expects the BARE decofile
      // map — it JSON-parses the body and snapshots it over the base blocks,
      // so wrapper keys would become bogus "blocks" and blank the whole draft.
      // The editor (session) gets the wrapper with the version and a fresh
      // draft token, so the preview pointer it builds never carries a stale
      // grant.
      if (!scope.userId) {
        // Preview-only: render unscheduled planning posts (see blog-draft-projection).
        return c.body(projectPlanningPostsForPreview(snapshot.decofile), 200, {
          ...headers,
          "content-type": "application/json",
        });
      }
      const token = signScopeDraftToken(scope);
      return c.body(
        `{"version":${JSON.stringify(snapshot.sha)},"token":${JSON.stringify(token)},"apiHost":${JSON.stringify(requestApiHost(c))},"decofile":${snapshot.decofile}}`,
        200,
        { ...headers, "content-type": "application/json" },
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:virtualMcpId/:branch/meta", async (c) => {
    const scope = c.get("decofileScope");
    const metaPath = scope.packagePath
      ? `${scope.packagePath}/.deco/meta.gen.json`
      : ".deco/meta.gen.json";
    try {
      const client = await contentClientForScope(c);
      /** The thread branch may not be materialized on GitHub yet (it forks
       *  from default at first CMS touch), so fall back to the default branch —
       *  meta.gen.json is a code artifact the CMS never edits, so the default's
       *  copy is the schema the forked branch would carry anyway. */
      let text = await client.readFileAtRef(scope.branch, metaPath);
      if (text === null) {
        const defaultBranch = await client.getDefaultBranch();
        if (defaultBranch !== scope.branch) {
          text = await client.readFileAtRef(defaultBranch, metaPath);
        }
      }
      if (text === null) {
        return c.json({ error: "meta.gen.json not committed" }, 404);
      }
      return c.body(text, 200, {
        "content-type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.patch("/:virtualMcpId/:branch", patchBodyLimit, async (c) => {
    const scope = c.get("decofileScope");
    const ctx = c.var.studioContext;

    const parsed = patchBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400,
      );
    }
    let patch: DecofilePatch;
    try {
      patch = sanitizeSecretsForPersistence(parsed.data);
    } catch (err) {
      if (err instanceof PlaintextSecretError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    for (const key of [
      ...Object.keys(patch.set ?? {}),
      ...(patch.delete ?? []),
    ]) {
      try {
        assertSafeDecoBlockKey(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 400);
      }
    }
    for (const [key, value] of Object.entries(patch.set ?? {})) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return c.json({ error: `Block "${key}" must be a JSON object` }, 400);
      }
      // Deletes of resolver-shaped keys stay allowed above so a shadow is repairable.
      if (isReservedResolverBlockKey(key)) {
        return c.json(
          {
            error: `Block key "${key}" collides with a framework resolver module and cannot be written`,
          },
          400,
        );
      }
    }

    try {
      const client = await contentClientForScope(c);
      const sha = await enqueueDecofilePatch(
        `${scope.organizationId}/${scope.virtualMcpId}/${scope.branch}`,
        {
          client,
          branch: scope.branch,
          packagePath: scope.packagePath,
          coAuthor: coAuthorFromStudioContext(ctx),
        },
        patch,
      );
      const token = signScopeDraftToken(scope);
      return c.json({ version: sha, token, apiHost: requestApiHost(c) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/:virtualMcpId/:branch/publish", async (c) => {
    const scope = c.get("decofileScope");
    try {
      const client = await contentClientForScope(c);
      const baseBranch = await client.getDefaultBranch();
      const hosted = await hostedScope(c);
      if (
        hosted &&
        ((await hosted.drafts.load(hosted.ref)) ||
          (await mainIsV8(client, scope.packagePath, baseBranch)))
      ) {
        const store = deliveryStore();
        if (!store) {
          return c.json({ error: "hosted delivery not configured" }, 503);
        }
        const body = (await c.req.json().catch(() => ({}))) as {
          note?: unknown;
        };
        try {
          const result = await publishDraft(
            {
              client,
              packagePath: scope.packagePath,
              mainBranch: baseBranch,
              store,
              purge: deliveryPurge(),
              site: hosted.ref.site,
            },
            hosted.drafts,
            hosted.ref,
            {
              message: typeof body.note === "string" ? body.note : "",
              coAuthor: coAuthorFromStudioContext(c.var.studioContext),
            },
          );
          return c.json(result);
        } catch (err) {
          if (err instanceof MainMovedError) {
            return c.json({ error: "main-moved" }, 409);
          }
          throw err;
        }
      }
      if (baseBranch === scope.branch) {
        return c.json({ error: "Branch is already the default branch" }, 400);
      }
      const message = `chore(decofile): publish ${scope.branch}`;
      try {
        let sha: string | null;
        try {
          sha = await client.mergeBranches(baseBranch, scope.branch, message);
        } catch (err) {
          if (repoErrorStatus(err) !== 409) throw err;
          // Sync branch-wins first; the branch then sits on base and this FFs.
          await repoGitRebase(client, scope.branch, baseBranch);
          sha = await client.mergeBranches(baseBranch, scope.branch, message);
        }
        return sha
          ? c.json({ result: "merged", sha })
          : c.json({ result: "up-to-date" });
      } catch (err) {
        if (repoErrorStatus(err) === 409) {
          return c.json({ error: "merge-conflict" }, 409);
        }
        // 405 = merge blocked (protected base branch) → fall back to a PR.
        if (repoErrorStatus(err) === 405) {
          const existing = await client.findOpenChangeRequest(
            baseBranch,
            scope.branch,
          );
          const pr =
            existing ??
            (await client.createChangeRequest({
              base: baseBranch,
              head: scope.branch,
              title: `Publish ${scope.branch}`,
            }));
          return c.json({
            result: "pull-request",
            number: pr.number,
            url: pr.url,
          });
        }
        throw err;
      }
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:virtualMcpId/:branch/status", async (c) => {
    const scope = c.get("decofileScope");
    try {
      const client = await contentClientForScope(c);
      const baseBranch = await client.getDefaultBranch();
      if (baseBranch === scope.branch) {
        return c.json({ baseBranch, aheadBy: 0, behindBy: 0 });
      }
      try {
        const { aheadBy, behindBy } = await client.compare(
          baseBranch,
          scope.branch,
        );
        return c.json({ baseBranch, aheadBy, behindBy });
      } catch (err) {
        // A thread-minted branch not materialized yet has no drift.
        if (repoErrorStatus(err) === 404) {
          return c.json({ baseBranch, aheadBy: 0, behindBy: 0 });
        }
        throw err;
      }
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/:virtualMcpId/:branch/rpc", async (c) => {
    if (!(await contentProtocolEnabled(c))) {
      return c.json({ error: "Not found" }, 404);
    }
    const scope = c.get("decofileScope");
    const hosted = await hostedScope(c);
    if (!hosted) {
      return c.json({ error: "hosted delivery not configured" }, 503);
    }
    const client = await contentClientForScope(c);
    // Per request: the storage carries this caller's repository credential.
    // The body cache is off for the same reason, and the blob cache under
    // the storage already makes repeated reads cheap.
    const handler = createContentHandler(
      createDraftContentStorage({
        client,
        packagePath: scope.packagePath,
        mainBranch: await client.getDefaultBranch(),
        drafts: hosted.drafts,
        ref: hosted.ref,
      }),
      {
        server: { name: "studio-github", version: "1" },
        preview: scope.previewServerUrl
          ? { url: new URL(scope.previewServerUrl).origin }
          : null,
        bodyCacheBytes: 0,
        onError: (error) =>
          console.error("content protocol: internal error", {
            organizationId: scope.organizationId,
            virtualMcpId: scope.virtualMcpId,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
    return handler(c.req.raw);
  });

  return app;
}
