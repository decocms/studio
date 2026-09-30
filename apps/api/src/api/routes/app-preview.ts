/**
 * Phone preview sessions (QR) — doc `conteudo-runtime-e-preview.md` §3.3/§3.4.
 *
 *   Editor (signed-in owner only; anyone else gets 404):
 *     POST   /api/:org/app-preview/:vmcp/sessions            { branch }
 *     POST   /api/:org/app-preview/:vmcp/sessions/:id/pairing
 *     GET    /api/:org/app-preview/:vmcp/sessions/:id
 *     PATCH  /api/:org/app-preview/:vmcp/sessions/:id/overlay { set?, delete?, reset? }
 *     DELETE /api/:org/app-preview/:vmcp/sessions/:id
 *
 *   Device (anonymous; `Authorization: DecoPreview <token>` after claim):
 *     POST   /api/:org/app-preview/claim                      { code }
 *     GET    /api/:org/app-preview/device/state
 *     GET    /api/:org/app-preview/device/base
 *     DELETE /api/:org/app-preview/device
 *
 * Gates (org flag `app_content_delivery`, `cms` plan, project in the org with a
 * repository) are the ones of `/app-content`. Every claim failure is the same
 * 404 and every device-auth failure the same 401. Nothing here logs codes,
 * tokens, IPs or emails.
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StudioContext } from "@/core/studio-context";
import { readAppManifest } from "@/app-content/manifest";
import { resolveAppProject, VIRTUAL_MCP_ID_RE } from "@/app-content/project";
import { readDecofileAtSha } from "@/decofile/read-decofile";
import { createSingleFlight } from "@/decofile/single-flight";
import {
  contentClientForProjectRepo,
  repoErrorStatus,
  requireBranchHead,
} from "@/git-providers";
import {
  newDeviceToken,
  newPairingCode,
  OverlayTooLargeError,
  type AppPreviewSession,
  type OverlayPatch,
  type PreviewOwner,
} from "@/storage/app-preview-sessions";
import type { Env } from "../hono-env";
import { clientIp, createWindowLimiter } from "../utils/rate-limit";
import { etagMatches } from "./app-content";
import {
  isValidBranch,
  patchBodyLimit,
  validateDecofilePatch,
} from "./decofile";

const HEAD_TTL_MS = 15_000;
const MAX_HEAD_ENTRIES = 1_000;
const CLAIM_WINDOW_MS = 5 * 60 * 1000;
const SESSION_ID_RE = /^aps_[0-9a-f-]{36}$/;
const PAIRING_CODE_RE = /^[0-9a-f]{32}$/;
const DEVICE_AUTH_RE = /^DecoPreview (dpv_[A-Za-z0-9_-]{43})$/;
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The repository side of a project, behind the app-content gates. */
export interface AppPreviewRepo {
  defaultHead(): Promise<string>;
  /** Null when the branch does not exist (never created here). */
  branchHead(branch: string): Promise<string | null>;
  /** Manifest `previewLink` at `sha`, or null. */
  previewLink(sha: string): Promise<string | null>;
  /** The merged decofile (JSON text) at `sha`. */
  decofileAt(sha: string): Promise<string>;
}

export interface AppPreviewBackend {
  /** Every gate passes (flag, plan, project in org, repository binding). */
  allowed(
    ctx: StudioContext,
    organizationId: string,
    virtualMcpId: string,
  ): Promise<boolean>;
  /** The gated repository, or null when a gate fails. */
  open(
    ctx: StudioContext,
    organizationId: string,
    virtualMcpId: string,
  ): Promise<AppPreviewRepo | null>;
}

/** Hook point for realtime (B2b): called after an overlay patch, a session
 *  revoke and a device revoke. Must not throw into the request. */
export type OnSessionChanged = (sessionId: string) => void;

export interface AppPreviewDeps {
  backend?: AppPreviewBackend;
  notify?: OnSessionChanged;
  now?: () => number;
}

const defaultBackend: AppPreviewBackend = {
  async allowed(ctx, organizationId, virtualMcpId) {
    const project = await resolveAppProject(ctx, organizationId, virtualMcpId);
    return !!project?.repository;
  },
  async open(ctx, organizationId, virtualMcpId) {
    const project = await resolveAppProject(ctx, organizationId, virtualMcpId);
    if (!project?.repository) return null;
    const { packagePath } = project;
    const client = await contentClientForProjectRepo(
      ctx,
      organizationId,
      project.repository,
    );
    return {
      defaultHead: async () =>
        requireBranchHead(client, await client.getDefaultBranch()),
      branchHead: async (branch) =>
        (await client.getBranch(branch))?.sha ?? null,
      previewLink: async (sha) =>
        (await readAppManifest(client, sha, packagePath))?.previewLink ?? null,
      decofileAt: async (sha) =>
        (await readDecofileAtSha(client, sha, packagePath)).decofile,
    };
  },
};

export function previewLinkFor(template: string | null, code: string) {
  return template ? template.replaceAll("{code}", code) : null;
}

/** Body `{set?, delete?, reset?}` → validated overlay patch, with the
 *  decofile PATCH rules for `set`/`delete`. */
export function parseOverlayPatch(
  body: unknown,
): { ok: true; patch: OverlayPatch } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Invalid body" };
  }
  const { reset, ...rest } = body as Record<string, unknown>;
  if (reset !== undefined && reset !== true) {
    return { ok: false, error: "Invalid body" };
  }
  if (rest.set === undefined && rest.delete === undefined) {
    return reset
      ? { ok: true, patch: { reset: true } }
      : { ok: false, error: "Invalid body" };
  }
  const validated = validateDecofilePatch(rest);
  if (!validated.ok) return { ok: false, error: validated.body.error };
  const { set, delete: deleted } = validated.patch;
  if (deleted?.some((key) => set && Object.hasOwn(set, key))) {
    return { ok: false, error: "A block cannot be both set and deleted" };
  }
  return { ok: true, patch: { set, delete: deleted, reset: reset === true } };
}

function notFound(c: Context) {
  return c.json({ error: "Not found" }, 404, NO_STORE);
}

function unauthorized(c: Context) {
  return c.json({ error: "Unauthorized" }, 401, NO_STORE);
}

function upstream(c: Context, where: string, err: unknown) {
  console.error(`[app-preview] ${where} failed`, {
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: "Upstream unavailable" }, 502, NO_STORE);
}

function pairingResponse(
  session: AppPreviewSession,
  code: string,
  link: string | null,
) {
  return {
    id: session.id,
    branch: session.branch,
    pairingCode: code,
    pairingExpiresAt: session.pairingExpiresAt,
    expiresAt: session.expiresAt,
    link,
  };
}

export function createAppPreviewRoutes(deps: AppPreviewDeps = {}) {
  const backend = deps.backend ?? defaultBackend;
  const now = deps.now ?? Date.now;
  const notify: OnSessionChanged = (sessionId) => {
    try {
      deps.notify?.(sessionId);
    } catch (err) {
      console.error("[app-preview] notify failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const ipLimiter = createWindowLimiter({ max: 10, windowMs: CLAIM_WINDOW_MS });
  const orgLimiter = createWindowLimiter({
    max: 200,
    windowMs: CLAIM_WINDOW_MS,
  });

  // (org, vmcp, branch) → base sha. On a hit the gates are not re-checked
  // for up to HEAD_TTL_MS.
  const heads = new Map<string, { sha: string; at: number }>();
  const headFlight = createSingleFlight<string | null>();
  const baseSha = async (
    ctx: StudioContext,
    session: AppPreviewSession,
  ): Promise<string | null> => {
    const key = `${session.organizationId}/${session.virtualMcpId}/${session.branch}`;
    const hit = heads.get(key);
    if (hit && now() - hit.at < HEAD_TTL_MS) return hit.sha;
    return headFlight.run(key, async () => {
      const repo = await backend.open(
        ctx,
        session.organizationId,
        session.virtualMcpId,
      );
      if (!repo) {
        heads.delete(key);
        return null;
      }
      const sha =
        (await repo.branchHead(session.branch)) ?? (await repo.defaultHead());
      heads.delete(key);
      heads.set(key, { sha, at: now() });
      if (heads.size > MAX_HEAD_ENTRIES) {
        const oldest = heads.keys().next();
        if (!oldest.done) heads.delete(oldest.value);
      }
      return sha;
    });
  };

  const app = new Hono<Env>();

  // ---- Device (anonymous) ------------------------------------------------

  app.post(
    "/claim",
    bodyLimit({ maxSize: 1024, onError: (c) => notFound(c) }),
    async (c) => {
      const ctx = c.var.studioContext;
      const organization = ctx.organization;
      if (!organization) return notFound(c);
      const t = now();
      if (
        !ipLimiter.hit(clientIp(c), t) ||
        !orgLimiter.hit(organization.id, t)
      ) {
        return c.json({ error: "Too many requests" }, 429, {
          ...NO_STORE,
          "Retry-After": "300",
        });
      }
      const body = (await c.req.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      const code = body?.code;
      if (typeof code !== "string" || !PAIRING_CODE_RE.test(code)) {
        return notFound(c);
      }
      const token = newDeviceToken();
      const session = await ctx.storage.appPreviewSessions.claim(
        code,
        organization.id,
        token,
        new Date(t),
      );
      if (!session) return notFound(c);
      return c.json(
        {
          token,
          expiresAt: session.expiresAt,
          virtualMcpId: session.virtualMcpId,
          branch: session.branch,
        },
        200,
        NO_STORE,
      );
    },
  );

  const authDevice = async (c: Context<Env>) => {
    const ctx = c.var.studioContext;
    const token = DEVICE_AUTH_RE.exec(c.req.header("authorization") ?? "")?.[1];
    if (!ctx.organization || !token) return null;
    return ctx.storage.appPreviewSessions.authenticateDevice(
      token,
      ctx.organization.id,
      new Date(now()),
    );
  };

  app.get("/device/state", async (c) => {
    const auth = await authDevice(c);
    if (!auth) return unauthorized(c);
    const { session } = auth;
    let sha: string | null;
    try {
      sha = await baseSha(c.var.studioContext, session);
    } catch (err) {
      if (repoErrorStatus(err) === 404) return unauthorized(c);
      return upstream(c, "state", err);
    }
    // Gates closed since pairing: the app leaves preview mode.
    if (!sha) return unauthorized(c);
    const etag = `"${sha}.${session.rev}"`;
    const headers = { ...NO_STORE, ETag: etag };
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, headers);
    }
    return c.json(
      {
        virtualMcpId: session.virtualMcpId,
        branch: session.branch,
        rev: session.rev,
        baseSha: sha,
        overlay: { set: session.overlay.set, delete: session.overlay.delete },
        expiresAt: session.expiresAt,
      },
      200,
      headers,
    );
  });

  app.get("/device/base", async (c) => {
    const auth = await authDevice(c);
    if (!auth) return unauthorized(c);
    const ctx = c.var.studioContext;
    const { session } = auth;
    try {
      const sha = await baseSha(ctx, session);
      if (!sha) return unauthorized(c);
      const etag = `"${sha}"`;
      const headers = { ...NO_STORE, ETag: etag };
      if (etagMatches(c.req.header("if-none-match"), etag)) {
        return c.body(null, 304, headers);
      }
      const repo = await backend.open(
        ctx,
        session.organizationId,
        session.virtualMcpId,
      );
      if (!repo) return unauthorized(c);
      return c.body(await repo.decofileAt(sha), 200, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      });
    } catch (err) {
      if (repoErrorStatus(err) === 404) return unauthorized(c);
      return upstream(c, "base", err);
    }
  });

  app.delete("/device", async (c) => {
    const auth = await authDevice(c);
    if (!auth) return unauthorized(c);
    await c.var.studioContext.storage.appPreviewSessions.revokeDevice(
      auth.deviceId,
      new Date(now()),
    );
    notify(auth.session.id);
    return c.body(null, 204, NO_STORE);
  });

  // ---- Editor (session owner) --------------------------------------------

  /** Owner scope for `:virtualMcpId`, or null (→ 401/404) when the caller is
   *  anonymous or the project fails a gate. */
  const editor = async (
    c: Context<Env>,
  ): Promise<{ owner: PreviewOwner } | "unauthorized" | null> => {
    const ctx = c.var.studioContext;
    const userId = ctx.auth?.user?.id;
    if (!userId) return "unauthorized";
    const organization = ctx.organization;
    const virtualMcpId = c.req.param("virtualMcpId") ?? "";
    const id = c.req.param("id");
    if (!organization || !VIRTUAL_MCP_ID_RE.test(virtualMcpId)) return null;
    if (id !== undefined && !SESSION_ID_RE.test(id)) return null;
    if (!(await backend.allowed(ctx, organization.id, virtualMcpId)))
      return null;
    return { owner: { organizationId: organization.id, virtualMcpId, userId } };
  };

  /** Default-branch `previewLink` with `code`, or null. */
  const linkFor = async (
    c: Context<Env>,
    owner: PreviewOwner,
    code: string,
  ) => {
    const repo = await backend.open(
      c.var.studioContext,
      owner.organizationId,
      owner.virtualMcpId,
    );
    if (!repo) return undefined;
    return previewLinkFor(
      await repo.previewLink(await repo.defaultHead()),
      code,
    );
  };

  app.post("/:virtualMcpId/sessions", async (c) => {
    const scope = await editor(c);
    if (scope === "unauthorized") return unauthorized(c);
    if (!scope) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as {
      branch?: unknown;
    } | null;
    const branch = body?.branch;
    if (typeof branch !== "string" || !isValidBranch(branch)) {
      return c.json({ error: "Invalid branch" }, 400, NO_STORE);
    }
    const code = newPairingCode();
    let link: string | null | undefined;
    try {
      link = await linkFor(c, scope.owner, code);
    } catch (err) {
      if (repoErrorStatus(err) === 404) return notFound(c);
      return upstream(c, "create", err);
    }
    if (link === undefined) return notFound(c);
    const session = await c.var.studioContext.storage.appPreviewSessions.create(
      { ...scope.owner, branch, pairingCode: code },
      new Date(now()),
    );
    return c.json(pairingResponse(session, code, link), 201, NO_STORE);
  });

  app.post("/:virtualMcpId/sessions/:id/pairing", async (c) => {
    const scope = await editor(c);
    if (scope === "unauthorized") return unauthorized(c);
    if (!scope) return notFound(c);
    const code = newPairingCode();
    let link: string | null | undefined;
    try {
      link = await linkFor(c, scope.owner, code);
    } catch (err) {
      if (repoErrorStatus(err) === 404) return notFound(c);
      return upstream(c, "pairing", err);
    }
    if (link === undefined) return notFound(c);
    const session =
      await c.var.studioContext.storage.appPreviewSessions.rotatePairing(
        c.req.param("id"),
        scope.owner,
        code,
        new Date(now()),
      );
    if (!session) return notFound(c);
    return c.json(pairingResponse(session, code, link), 201, NO_STORE);
  });

  app.get("/:virtualMcpId/sessions/:id", async (c) => {
    const scope = await editor(c);
    if (scope === "unauthorized") return unauthorized(c);
    if (!scope) return notFound(c);
    const found =
      await c.var.studioContext.storage.appPreviewSessions.getForOwner(
        c.req.param("id"),
        scope.owner,
      );
    if (!found) return notFound(c);
    const { session, devices } = found;
    return c.json(
      {
        id: session.id,
        branch: session.branch,
        rev: session.rev,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        devices,
      },
      200,
      NO_STORE,
    );
  });

  app.patch(
    "/:virtualMcpId/sessions/:id/overlay",
    patchBodyLimit,
    async (c) => {
      const scope = await editor(c);
      if (scope === "unauthorized") return unauthorized(c);
      if (!scope) return notFound(c);
      const parsed = parseOverlayPatch(await c.req.json().catch(() => null));
      if (!parsed.ok) return c.json({ error: parsed.error }, 400, NO_STORE);
      const id = c.req.param("id");
      let result: { rev: number } | null;
      try {
        result =
          await c.var.studioContext.storage.appPreviewSessions.patchOverlay(
            id,
            scope.owner,
            parsed.patch,
            new Date(now()),
          );
      } catch (err) {
        if (err instanceof OverlayTooLargeError) {
          return c.json({ error: "Payload too large" }, 413, NO_STORE);
        }
        throw err;
      }
      if (!result) return notFound(c);
      notify(id);
      return c.json({ rev: result.rev }, 200, NO_STORE);
    },
  );

  app.delete("/:virtualMcpId/sessions/:id", async (c) => {
    const scope = await editor(c);
    if (scope === "unauthorized") return unauthorized(c);
    if (!scope) return notFound(c);
    const id = c.req.param("id");
    const revoked = await c.var.studioContext.storage.appPreviewSessions.revoke(
      id,
      scope.owner,
      new Date(now()),
    );
    if (!revoked) return notFound(c);
    notify(id);
    return c.body(null, 204, NO_STORE);
  });

  return app;
}
