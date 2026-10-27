/**
 * Sandbox-less decofile API — the CMS write/read/publish surface for Fast
 * Preview projects. The branch head on GitHub IS the draft: reads merge
 * `.deco/blocks/*.json` at head, writes land as (coalesced) commits, publish
 * merges the branch into the default branch. No sandbox is involved.
 *
 *   GET    /api/:org/decofile/:virtualMcpId/:branch           read (session OR ?token=)
 *   PATCH  /api/:org/decofile/:virtualMcpId/:branch           write blocks (session; 409 block-conflict on a stale `expect`)
 *   POST   /api/:org/decofile/:virtualMcpId/:branch/publish   merge into default (session)
 *   GET    /api/:org/decofile/:virtualMcpId/:branch/status    drift vs default (session)
 *   POST   /api/:org/decofile/:virtualMcpId/:branch/rpc       content protocol (session; main's schema for any site)
 *
 * The surface is inert unless the virtual MCP has both a preview server URL
 * (`previewServerUrl`, legacy `productionUrl`) and a GitHub repo — what a CMS
 * session needs to render and to commit. The project's `fastPreview` switch
 * does NOT gate it; that switch only picks the runtime a NEW thread is stamped
 * with, and gating this on it would strand an already-stamped session.
 *
 * The content-protocol routes serve Blocks v8 sites on the hosted Deco CMS
 * (see `hosted/`): projects whose main schema passes `isV8Schema`
 * (`@decocms/shared/blocks-major`), in any org. A v7 project keeps every
 * answer it has on main; its `rpc` only answers main's schema (`schema.get`
 * → `schema: null`, read only), which is how the editor learns, for any
 * site, whether main is v8 (no route of its own). The editor's draft is an object on the delivery CDN
 * (`hosted/draft-content-storage.ts`), never a git branch: `rpc` reads main
 * with the draft layered on and saves into the draft; the session GET answers
 * a v8 project's `?__draft=` pointer (`{ draft, version, changedBy }`) instead of the
 * decofile; publish commits the draft to main and releases it. `rpc` doesn't
 * need a preview server: the protocol never renders.
 *
 * The editor says which main answer it acts on (`MAIN_SCHEMA_HEADER`); when
 * main changed during its session the GET, publish and `rpc` answer 409
 * `main_schema_changed` instead of the other generation's shape, and the
 * editor reads main's answer again.
 *
 * Anonymous access: `resolveOrgFromPath` lets unauthenticated requests through
 * (membership is only enforced for signed-in principals), so the GET handler
 * self-enforces the signed draft token, mirroring automation-webhooks.ts.
 */

import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import {
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
import { decofilePatchRefusal } from "@/decofile/block-write-guards";
import {
  BlockConflictError,
  decofileQueueKey,
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
import {
  createDraftContentStorage,
  createV7MainStorage,
} from "@/hosted/draft-content-storage";
import type { DraftEditors } from "@/hosted/draft-editors";
import type { DraftStore, HostedDraftRef } from "@/hosted/draft-store";
import type { KVStorage } from "@/storage/kv";
import {
  type SiteDomainsReader,
  sitePreviewHosts,
} from "@/hosted/preview-hosts";
import { MainMovedError, publishDraft } from "@/hosted/publish";
import { projectMainIsV8, projectPackagePath } from "@/hosted/blocks-major";
import { hostedDrafts, ownedProjectSite, SITE_NOT_OWNED } from "@/hosted/scope";
import {
  isBlocksV8Project,
  HOSTED_DELIVERY_UNCONFIGURED,
  MAIN_SCHEMA_CHANGED,
  MAIN_SCHEMA_HEADER,
} from "@decocms/shared/blocks-major";
import { createContentHandler } from "@decocms/blocks/protocol/server";
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
  /** The project's metadata, for the Blocks v8 marker write-through. */
  metadata: Record<string, unknown> | null;
}

/** Opens the project repository's content client (tests pass a fake). */
export type RepoClientFor = typeof contentClientForProjectRepo;

type DecofileEnv = Env & {
  Variables: Env["Variables"] & {
    decofileScope: DecofileScope;
    repoClientFor: RepoClientFor;
    siteDomains: SiteDomainsReader | undefined;
    hostedDrafts: (kv: KVStorage) => DraftStore | null;
  };
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
    expect: z
      .record(
        z.string(),
        z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      )
      .optional(),
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
  )
  .refine(
    (b) =>
      Object.keys(b.expect ?? {}).every(
        (key) => key in (b.set ?? {}) || (b.delete ?? []).includes(key),
      ),
    { message: "Each expected block must be one the patch sets or deletes" },
  )
  .refine(
    (b) =>
      Object.keys(b.set ?? {}).every((key) => !(b.delete ?? []).includes(key)),
    { message: "A block cannot be both set and deleted in the same patch" },
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
    return c.json(
      { error: "Project has no repository", code: "no_repository" },
      404,
    );
  }

  c.set("decofileScope", {
    organizationId: organization.id,
    virtualMcpId,
    branch,
    packagePath: projectPackagePath(metadata),
    repository,
    userId,
    previewServerUrl,
    site: await ownedProjectSite(
      ctx.storage.orgSites,
      virtualMcpId,
      organization.id,
    ),
    metadata,
  });
  return next();
});

/** A draft's editors as the session read answers them: ISO times. */
function draftChangedBy(
  editors: DraftEditors,
): Record<string, { userId: string; at: string }> {
  // fromEntries: a name like "__proto__" stays an entry.
  return Object.fromEntries(
    Object.entries(editors).map(([name, { userId, at }]) => [
      name,
      { userId, at: new Date(at * 1000).toISOString() },
    ]),
  );
}

/** Content-protocol routes that work without a preview server. */
function isContentProtocolPath(path: string): boolean {
  return path.endsWith("/rpc");
}

/**
 * The draft store and this session's draft, for a member of a project that
 * owns its site id, with a delivery bucket configured. Null otherwise;
 * whether the project is a v8 one is the caller's question (`scopeIsV8`).
 */
function hostedScope(
  c: Context<DecofileEnv>,
): { drafts: DraftStore; ref: HostedDraftRef } | null {
  const scope = c.get("decofileScope");
  if (!scope.userId || !scope.site) return null;
  const drafts = c.var.hostedDrafts(c.var.studioContext.storage.kv);
  if (!drafts) return null;
  return {
    drafts,
    ref: {
      organizationId: scope.organizationId,
      virtualMcpId: scope.virtualMcpId,
      branch: scope.branch,
      site: scope.site,
      editor: scope.userId,
    },
  };
}

/**
 * Whether this project is a Blocks v8 site right now: `isV8Schema` on main's
 * schema (`projectMainIsV8`: at most one head read per minute per repository,
 * so a v7 site's decofile reads stay as cheap as on main). Never the marker
 * alone: a missing marker (repo seeded after create) or a stale one (main
 * went back to v7) still gets main's answer, written through to the marker.
 */
function scopeIsV8(
  c: Context<DecofileEnv>,
  client: RepoContentClient,
  mainBranch: string,
  options: { fresh?: boolean } = {},
): Promise<boolean> {
  const scope = c.get("decofileScope");
  return projectMainIsV8({
    projects: c.var.studioContext.storage.virtualMcps,
    project: {
      id: scope.virtualMcpId,
      organizationId: scope.organizationId,
      metadata: scope.metadata,
    },
    by: scope.userId,
    client,
    mainBranch,
    fresh: options.fresh,
  });
}

/**
 * A Blocks v8 project that doesn't own its site id: its content lives on the
 * hosted CMS, which only the owning project can reach, so these routes answer
 * {@link SITE_NOT_OWNED} instead of serving the v7 decofile. Free for an
 * owner and for an anonymous (draft token) read.
 */
async function unownedV8(
  c: Context<DecofileEnv>,
  client: RepoContentClient,
  mainBranch: () => Promise<string>,
): Promise<boolean> {
  const scope = c.get("decofileScope");
  if (!scope.userId || scope.site) return false;
  try {
    return await scopeIsV8(c, client, await mainBranch());
  } catch (error) {
    // Advisory: /rpc and the hosted routes are the real gates and still
    // fail closed. A main that can't be read here must not fail a v7 read
    // or publish that never needed main.
    console.warn("decofile: main's schema unreadable, not an unowned v8", {
      organizationId: scope.organizationId,
      virtualMcpId: scope.virtualMcpId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The 409 body for a request made on a main answer that is out of date. */
const MAIN_CHANGED_BODY = {
  code: MAIN_SCHEMA_CHANGED,
  error: "main's schema changed: read it again",
} as const;

/**
 * The main answer the editor says it acts on (`MAIN_SCHEMA_HEADER`), or
 * null when it doesn't say (the site's own draft pull, older clients).
 */
function expectedMain(c: Context<DecofileEnv>): "v8" | "v7" | null {
  const value = c.req.header(MAIN_SCHEMA_HEADER);
  return value === "v8" || value === "v7" ? value : null;
}

/**
 * Main's answer for a GET or publish, read only when it matters: a signed-in
 * owner of its site id (a v8 site's hosted draft could be served), or an
 * editor that said it acts on a v8 main. `null` when not read (any other v7
 * request: as cheap as on main). A failed read is v7 (as on main, which
 * never read main here) unless a v8 answer could be at stake: an editor
 * that said it acts on v8, or a request that didn't say on a project the
 * server last found v8 (its `blocksMajor` marker). Those fail instead of
 * serving or merging the v7 shape on a v8 site.
 */
async function mainAnswerFor(
  c: Context<DecofileEnv>,
  client: RepoContentClient,
  mainBranch: () => Promise<string>,
): Promise<boolean | null> {
  const expected = expectedMain(c);
  const scope = c.get("decofileScope");
  const ownsSite = !!scope.userId && !!scope.site;
  if (!ownsSite && expected !== "v8") return null;
  try {
    return await scopeIsV8(c, client, await mainBranch());
  } catch (error) {
    if (expected === "v8") throw error;
    if (expected === null && isBlocksV8Project(scope.metadata)) throw error;
    console.warn("decofile: main's schema unreadable, serving v7", {
      organizationId: scope.organizationId,
      virtualMcpId: scope.virtualMcpId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Whether the editor's main answer (`expectedMain`) differs from the
 * server's (`mainV8`, when read): main changed during its session.
 */
function mainChanged(c: Context<DecofileEnv>, mainV8: boolean | null): boolean {
  const expected = expectedMain(c);
  return expected !== null && mainV8 !== null && (expected === "v8") !== mainV8;
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
 * pointer. This request reached the API itself, so its Host (or the proxy's X-Forwarded-Host) is an authority the
 * preview server can pull the draft from anonymously.
 */
function requestApiHost(c: Context<DecofileEnv>): string {
  return c.req.header("x-forwarded-host") ?? new URL(c.req.url).host;
}

async function contentClientForScope(
  c: Context<DecofileEnv>,
): Promise<RepoContentClient> {
  const scope = c.get("decofileScope");
  return c.var.repoClientFor(
    c.var.studioContext,
    scope.organizationId,
    scope.repository,
  );
}

function errorResponse(c: Context<DecofileEnv>, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BlockConflictError) {
    return c.json(
      { error: message, code: "block-conflict", blocks: err.blocks },
      409,
    );
  }
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

export function createDecofileRoutes(
  options: {
    repoClientFor?: RepoClientFor;
    /** The site's deco.cx domains, for its preview hosts (tests pass a fake). */
    siteDomains?: SiteDomainsReader;
    /** The draft store over the delivery bucket (tests pass one in memory). */
    hostedDrafts?: (kv: KVStorage) => DraftStore | null;
  } = {},
) {
  const app = new Hono<DecofileEnv>();
  const repoClientFor = options.repoClientFor ?? contentClientForProjectRepo;
  app.use("*", async (c, next) => {
    c.set("repoClientFor", repoClientFor);
    c.set("siteDomains", options.siteDomains);
    c.set("hostedDrafts", options.hostedDrafts ?? hostedDrafts);
    await next();
  });

  app.use("/:virtualMcpId/:branch", resolveDecofileScope);
  app.use("/:virtualMcpId/:branch/*", resolveDecofileScope);

  app.get("/:virtualMcpId/:branch", async (c) => {
    const scope = c.get("decofileScope");
    try {
      const client = await contentClientForScope(c);
      // OPEN: O-S3 — a v8 project's editor reads its `?__draft=` pointer
      // here, in place of v7's decofile, token and API host.
      if (await unownedV8(c, client, () => client.getDefaultBranch())) {
        return c.json(SITE_NOT_OWNED, 409);
      }
      const hosted = hostedScope(c);
      const mainV8 = await mainAnswerFor(c, client, () =>
        client.getDefaultBranch(),
      );
      // The editor acts on another main answer: never the other shape.
      if (mainChanged(c, mainV8)) return c.json(MAIN_CHANGED_BODY, 409);
      if (hosted && mainV8) {
        // An editor session always has a draft (created empty on open), so
        // the preview always sends its pointer, never the bare site: the
        // same address before and after a Publish, which empties it.
        const draft = await hosted.drafts.ensure(hosted.ref);
        const version = bareEtag(draft.etag);
        return c.json(
          {
            draft: version
              ? draftPointerTarget(hosted.ref.site, draft.slug)
              : null,
            version,
            // Who last changed each block the draft holds, from the draft
            // object's metadata (no extra request): Studio user ids; the
            // editor resolves the people from the org's members.
            changedBy: draftChangedBy(draft.editors),
          },
          200,
          { "Cache-Control": "no-store" },
        );
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

    const refusal = decofilePatchRefusal(patch);
    if (refusal) return c.json({ error: refusal }, 400);

    try {
      const client = await contentClientForScope(c);
      const sha = await enqueueDecofilePatch(
        decofileQueueKey(
          scope.organizationId,
          scope.virtualMcpId,
          scope.branch,
        ),
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
      if (await unownedV8(c, client, async () => baseBranch)) {
        return c.json(SITE_NOT_OWNED, 409);
      }
      const hosted = hostedScope(c);
      const mainV8 = await mainAnswerFor(c, client, async () => baseBranch);
      // A v8 editor's Publish on a main that went back to v7 (or the
      // reverse) is refused, never merged or published as the other kind.
      if (mainChanged(c, mainV8)) return c.json(MAIN_CHANGED_BODY, 409);
      if (hosted && mainV8) {
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
              previewHosts: await sitePreviewHosts({
                site: hosted.ref.site,
                metadata: scope.metadata,
                domains: c.var.siteDomains,
              }),
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
    const scope = c.get("decofileScope");
    let client: RepoContentClient;
    let mainBranch: string;
    let mainV8: boolean;
    try {
      client = await contentClientForScope(c);
      mainBranch = await client.getDefaultBranch();
      // Without the main-answer header this is the editor reading main's
      // schema as a project opens: read main's head fresh (a 304 when it is
      // unchanged), so a push to main and the marker are picked up at once.
      mainV8 = await scopeIsV8(c, client, mainBranch, {
        fresh: expectedMain(c) === null,
      });
    } catch (err) {
      return errorResponse(c, err);
    }
    if (!mainV8) {
      // An editor that acts on a v8 main: main changed since, and it
      // re-reads main's answer instead of failing as unavailable.
      if (expectedMain(c) === "v8") return c.json(MAIN_CHANGED_BODY, 409);
      // Anyone else is reading main's answer (the editor's first read, any
      // site, v7 included): a read-only "no v8 schema" (`schema.get` →
      // `schema: null`), from the cached answer above alone.
      return createContentHandler(
        createV7MainStorage({ packagePath: scope.packagePath, mainBranch }),
        { server: { name: "studio-github", version: "1" }, bodyCacheBytes: 0 },
      )(c.req.raw);
    }
    // Main is v8 past this point: the editor reads these answers as "v8".
    if (scope.userId && !scope.site) return c.json(SITE_NOT_OWNED, 409);
    const hosted = hostedScope(c);
    if (!hosted) {
      return c.json(
        {
          error: "hosted delivery not configured",
          code: HOSTED_DELIVERY_UNCONFIGURED,
        },
        503,
      );
    }
    // Per request: the storage carries this caller's repository credential.
    // The body cache is off for the same reason, and the blob cache under
    // the storage already makes repeated reads cheap.
    const handler = createContentHandler(
      createDraftContentStorage({
        client,
        packagePath: scope.packagePath,
        mainBranch,
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
