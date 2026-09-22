import { type Context, Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import {
  accountIsServable,
  cappedLimit,
  type ChangeRequestHistoryItem,
  clientForAccount,
  DEFAULT_FILE_BYTES,
  DEFAULT_TREE_ENTRIES,
  GitProviderError,
  insightsClientForRepository,
  MAX_CHANGE_REQUEST_PAGE,
  MAX_COMMIT_PAGE,
  MAX_FILE_BYTES,
  MAX_SEARCH_HITS,
  MAX_TREE_ENTRIES,
  providerCapabilities,
  type RepoInsightsClient,
} from "@/git-providers";
import { type RepositoryRecord, repoRefOf } from "@/storage/repositories";
import { bearerToken, isVaultServiceToken } from "./credential-vault";

/**
 * Internal repository reads — a trusted machine service (reports's
 * diagnostic worker) reads a repository's history and shape THROUGH Studio,
 * instead of leasing a git token and talking to the provider itself.
 *
 *   POST /api/:org/internal/repositories/resolve
 *   POST /api/:org/internal/repositories/:id/{tree,file,search,change-requests,commits}
 *
 * The point of the lane is that **no git token ever leaves Studio**. The
 * predecessor leased the org's `mcp-github` OAuth token over the vault's batch
 * route and called api.github.com from the worker, which meant a live
 * credential crossing a service boundary on every audit — and it meant the
 * audit only ever worked for GitHub. Here Studio mints, spends and forgets the
 * token inside one request, and the worker sees neutral shapes that read the
 * same whether the repository is on GitHub, GitLab or Bitbucket.
 *
 * Auth mirrors the credential vault's service lease and the task-board import:
 * the shared VAULT_SERVICE_TOKEN bearer alone authenticates (constant-time
 * compare), and the org resolved from the path is the only bound. The caller
 * holds the org *id*, so `resolve-org-from-path` matches these routes in its
 * resolve-by-id allowlist. Every repository read is org-scoped through
 * `repositories.get(id, organizationId)` — never the unscoped getter — so an id
 * from another tenant is a 404 rather than a read.
 *
 * Statuses the caller branches on:
 * - `401` the token is absent or wrong;
 * - `404` no repository with that id (or that identity) in THIS org;
 * - `422` the body does not parse;
 * - `429` + `Retry-After` the provider rate-limited us — the wait is the
 *   provider's own hint, and retrying sooner IS the burst being limited;
 * - `502` the provider failed. `provider_auth_failed` specifically means the
 *   stored credential no longer works, which is a "reconnect" for a human
 *   rather than something a retry fixes.
 *
 * Responses are `Cache-Control: no-store`: they carry a tenant's source code.
 */

type Variables = {
  studioContext: StudioContext;
};

type RouteContext = Context<{ Variables: Variables }>;

/** The neutral repository identity both sides agree on, snake_case on the wire. */
interface RepositoryRefWire {
  repository_id: string;
  provider: string;
  host: string;
  path: string;
  default_branch: string | null;
  web_url: string | null;
}

function repositoryWire(repository: RepositoryRecord): RepositoryRefWire {
  return {
    repository_id: repository.id,
    provider: repository.provider,
    host: repository.host,
    path: repository.path,
    default_branch: repository.defaultBranch,
    web_url: repository.webUrl,
  };
}

/**
 * One change request on the wire. The consumer is another service, so the
 * naming convention flips here (`isBot` → `is_bot`) and the shape is asserted
 * on its own rather than through a provider: a field quietly dropped in this
 * translation is a contract break the provider tests cannot see.
 */
export function changeRequestWire(
  item: ChangeRequestHistoryItem,
): Record<string, unknown> {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    author: { login: item.author.login, is_bot: item.author.isBot },
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    merged_at: item.mergedAt,
    closed_at: item.closedAt,
    base: item.base,
    head: item.head,
    additions: item.additions,
    deletions: item.deletions,
    commits: item.commits,
  };
}

/**
 * Why a repository cannot be read, in terms of what a human has to do about it.
 *
 * The distinction the consumer needs is DURABLE versus TRANSIENT: only a
 * durable answer may flip a connection card to "disconnected". `auth_failed`
 * is durable (the grant is dead until someone reconnects); a provider 5xx never
 * reaches here at all, because it is raised rather than reported as a reason.
 */
const RESOLVE_REASONS = [
  "ok",
  "no_account",
  "account_revoked",
  "provider_unconfigured",
  "auth_failed",
  "not_found",
] as const;
type ResolveReason = (typeof RESOLVE_REASONS)[number];

const refSchema = z.object({
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  host: z.string().min(1).max(255),
  path: z.string().min(1).max(400),
});

const resolveBodySchema = z
  .object({
    repository_id: z.string().min(1).max(200).optional(),
    ref: refSchema.optional(),
  })
  .refine(
    (body) => body.repository_id !== undefined || body.ref !== undefined,
    {
      message: "one of repository_id or ref is required",
    },
  );

const treeBodySchema = z.object({
  ref: z.string().min(1).max(255).optional(),
  max_entries: z.number().int().positive().max(MAX_TREE_ENTRIES).optional(),
});

const fileBodySchema = z.object({
  path: z.string().min(1).max(1000),
  ref: z.string().min(1).max(255).optional(),
  max_bytes: z.number().int().positive().max(MAX_FILE_BYTES).optional(),
});

const searchBodySchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(MAX_SEARCH_HITS).optional(),
});

const changeRequestsBodySchema = z.object({
  state: z.enum(["merged", "open", "all"]),
  updated_after: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().positive().max(MAX_CHANGE_REQUEST_PAGE).optional(),
  include_commits: z.boolean().optional(),
  include_stats: z.boolean().optional(),
});

const commitsBodySchema = z.object({
  ref: z.string().min(1).max(255).optional(),
  since: z.string().min(1).max(64),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().positive().max(MAX_COMMIT_PAGE).optional(),
});

export interface InternalRepositoryDeps {
  /**
   * The provider seam, injectable so the route's own contract (auth, tenant
   * scoping, body validation, error mapping) can be tested without a provider.
   * Nothing below this line is stubbed in tests — a fake `fetch` would assert
   * the transport rather than this route.
   */
  insightsClientFor?: (
    ctx: StudioContext,
    repository: RepositoryRecord,
  ) => Promise<RepoInsightsClient>;
}

export const createInternalRepositoryRoutes = (
  deps: InternalRepositoryDeps = {},
) => {
  const insightsClientFor =
    deps.insightsClientFor ?? insightsClientForRepository;
  const app = new Hono<{ Variables: Variables }>();

  /**
   * The service token and the org bound to the path, in that order. Returns
   * the pair, or the response that refuses the call.
   */
  const authorize = (
    c: RouteContext,
  ):
    | { ok: true; ctx: StudioContext; organizationId: string }
    | { ok: false; response: Response } => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isVaultServiceToken(token)) {
      return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
    }
    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return {
        ok: false,
        response: c.json({ error: "Organization context required" }, 403),
      };
    }
    return { ok: true, ctx, organizationId };
  };

  /**
   * One structured line per call. Deliberately no file path, no query text and
   * no content length — this lane carries a tenant's source, and a log is the
   * one place it must not end up.
   */
  const logCall = (params: {
    route: string;
    org: string;
    repositoryId: string | null;
    provider: string | null;
    status: number;
    startedAt: number;
  }) => {
    console.log("[internal-repositories]", {
      route: params.route,
      org: params.org,
      repository_id: params.repositoryId,
      provider: params.provider,
      status: params.status,
      ms: Date.now() - params.startedAt,
    });
  };

  /**
   * Run a provider read and answer it, or translate its failure. A refusal the
   * caller can act on differently gets its own status; everything else is a
   * 502, which the worker retries inside its durable step.
   */
  const handle = async <T>(
    c: RouteContext,
    meta: {
      route: string;
      org: string;
      repository: RepositoryRecord;
      startedAt: number;
    },
    run: () => Promise<T>,
  ): Promise<Response> => {
    const answer = (status: 200 | 429 | 502, body: unknown) => {
      logCall({
        route: meta.route,
        org: meta.org,
        repositoryId: meta.repository.id,
        provider: meta.repository.provider,
        status,
        startedAt: meta.startedAt,
      });
      c.header("Cache-Control", "no-store");
      return c.json(body as Record<string, unknown>, status);
    };
    try {
      return answer(200, await run());
    } catch (error) {
      if (error instanceof GitProviderError && error.isRateLimited) {
        const seconds = Math.max(
          1,
          Math.ceil((error.retryAfterMs ?? 60_000) / 1000),
        );
        c.header("Retry-After", String(seconds));
        return answer(429, {
          error: "provider_rate_limited",
          provider_status: error.status,
        });
      }
      if (error instanceof GitProviderError && error.isAuthFailure) {
        return answer(502, {
          error: "provider_auth_failed",
          provider_status: error.status,
        });
      }
      console.error("[internal-repositories] provider read failed", error);
      return answer(502, {
        error: "provider_error",
        provider_status:
          error instanceof GitProviderError ? error.status : null,
      });
    }
  };

  /** The repository this org owns under `id`, or the 404 that refuses it. */
  const repositoryOr404 = async (
    ctx: StudioContext,
    organizationId: string,
    id: string,
  ): Promise<RepositoryRecord | null> =>
    ctx.storage.repositories.get(id, organizationId);

  app.post("/internal/repositories/resolve", async (c) => {
    const startedAt = Date.now();
    const auth = authorize(c);
    if (!auth.ok) return auth.response;
    const { ctx, organizationId } = auth;

    const parsed = resolveBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        422,
      );
    }

    const repository = parsed.data.repository_id
      ? await repositoryOr404(ctx, organizationId, parsed.data.repository_id)
      : await findByRef(ctx, organizationId, parsed.data.ref);
    if (!repository) {
      logCall({
        route: "resolve",
        org: organizationId,
        repositoryId: parsed.data.repository_id ?? null,
        provider: parsed.data.ref?.provider ?? null,
        status: 404,
        startedAt,
      });
      return c.json({ error: "repository_not_found" }, 404);
    }

    return handle(
      c,
      { route: "resolve", org: organizationId, repository, startedAt },
      async () => ({
        repository: repositoryWire(repository),
        ...(await resolveUsability(ctx, repository)),
      }),
    );
  });

  /**
   * The repository-scoped routes share the same preamble, and differ only in
   * the body they parse and the client call they make.
   */
  const repositoryRoute = <Body>(
    route: string,
    schema: z.ZodType<Body>,
    run: (
      client: RepoInsightsClient,
      body: Body,
    ) => Promise<Record<string, unknown>>,
  ) => {
    app.post(`/internal/repositories/:id/${route}`, async (c) => {
      const startedAt = Date.now();
      const auth = await authorize(c);
      if (!auth.ok) return auth.response;
      const { ctx, organizationId } = auth;

      const repository = await repositoryOr404(
        ctx,
        organizationId,
        c.req.param("id"),
      );
      if (!repository) {
        logCall({
          route,
          org: organizationId,
          repositoryId: c.req.param("id"),
          provider: null,
          status: 404,
          startedAt,
        });
        return c.json({ error: "repository_not_found" }, 404);
      }

      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        logCall({
          route,
          org: organizationId,
          repositoryId: repository.id,
          provider: repository.provider,
          status: 422,
          startedAt,
        });
        return c.json(
          { error: "Invalid body", issues: parsed.error.issues },
          422,
        );
      }

      return handle(
        c,
        { route, org: organizationId, repository, startedAt },
        async () => run(await insightsClientFor(ctx, repository), parsed.data),
      );
    });
  };

  repositoryRoute("tree", treeBodySchema, async (client, body) => {
    const listing = await client.listTree({
      ref: body.ref,
      maxEntries: cappedLimit(
        body.max_entries,
        DEFAULT_TREE_ENTRIES,
        MAX_TREE_ENTRIES,
      ),
    });
    return {
      ref: listing.ref,
      entries: listing.entries,
      truncated: listing.truncated,
    };
  });

  repositoryRoute("file", fileBodySchema, async (client, body) => {
    const file = await client.readFile({
      path: body.path,
      ref: body.ref,
      maxBytes: cappedLimit(body.max_bytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES),
    });
    return {
      content: file.content,
      size: file.size,
      truncated: file.truncated,
    };
  });

  repositoryRoute("search", searchBodySchema, async (client, body) => {
    const result = await client.searchCode({
      query: body.query,
      limit: body.limit,
    });
    return {
      supported: result.supported,
      incomplete: result.incomplete,
      hits: result.hits,
    };
  });

  repositoryRoute(
    "change-requests",
    changeRequestsBodySchema,
    async (client, body) => {
      const page = await client.listChangeRequests({
        state: body.state,
        updatedAfter: body.updated_after,
        cursor: body.cursor,
        limit: body.limit,
        includeCommits: body.include_commits,
        includeStats: body.include_stats,
      });
      return {
        items: page.items.map(changeRequestWire),
        next_cursor: page.nextCursor,
      };
    },
  );

  repositoryRoute("commits", commitsBodySchema, async (client, body) => {
    const page = await client.listCommits({
      ref: body.ref,
      since: body.since,
      cursor: body.cursor,
      limit: body.limit,
    });
    return { items: page.items, next_cursor: page.nextCursor };
  });

  return app;
};

/**
 * The org's repository for an identity. `findByRef` matches on host and path
 * alone, so the provider is checked here: two providers can share a host in a
 * self-managed deployment, and answering with the wrong one would credential a
 * read against a repository the caller did not name.
 */
async function findByRef(
  ctx: StudioContext,
  organizationId: string,
  ref: z.infer<typeof refSchema> | undefined,
): Promise<RepositoryRecord | null> {
  if (!ref) return null;
  const repository = await ctx.storage.repositories.findByRef(organizationId, {
    host: ref.host,
    path: ref.path,
  });
  return repository?.provider === ref.provider ? repository : null;
}

/**
 * Whether a credential that can actually read this repository exists right now.
 *
 * The live call is the point: a stored account row says nothing about whether
 * its grant was revoked on the provider's side this morning, and the consumer
 * uses this answer to decide whether to show a reconnect prompt. A transient
 * failure is NOT reported as unusable — it is raised, so the caller leaves its
 * card alone rather than telling a reader to reconnect a working integration.
 */
async function resolveUsability(
  ctx: StudioContext,
  repository: RepositoryRecord,
): Promise<{ usable: boolean; reason: ResolveReason }> {
  if (!repository.accountId) {
    return { usable: false, reason: "no_account" };
  }
  const account = await ctx.storage.gitProviderAccounts.get(
    repository.accountId,
    repository.organizationId,
  );
  if (!account) return { usable: false, reason: "no_account" };
  if (account.status !== "active") {
    return { usable: false, reason: "account_revoked" };
  }
  if (!accountIsServable(account)) {
    return {
      usable: false,
      reason: providerCapabilities()[account.type].configured
        ? "account_revoked"
        : "provider_unconfigured",
    };
  }
  try {
    const summary = await clientForAccount(ctx, account).getRepo(
      repoRefOf(repository),
    );
    return summary
      ? { usable: true, reason: "ok" }
      : { usable: false, reason: "not_found" };
  } catch (error) {
    if (error instanceof GitProviderError && error.isAuthFailure) {
      return { usable: false, reason: "auth_failed" };
    }
    throw error;
  }
}
