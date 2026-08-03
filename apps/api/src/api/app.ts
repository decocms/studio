/**
 * Studio API Server
 *
 * Main Hono application with:
 * - Better Auth integration
 * - Context injection middleware
 * - Error handling
 * - CORS support
 */

import { readFileSync } from "node:fs";
import { sleep } from "@decocms/shared/std";
import { jetstreamManager } from "@nats-io/jetstream";
import { getSettings } from "../settings";
import {
  kickPublicSetsBootSync,
  registerPublicSetsSyncWorkflow,
  setPublicSetsSyncRuntime,
} from "../file-storage/dbos-public-sets-sync";
import { registerBenefitsSyncWorkflows } from "../billing/sync-org-benefits";
import { getPublicUrl } from "@/core/server-constants";
import { usesLocalObjectStorage } from "../tools/connection/dev-assets";
import { DECO_STORE_URL, isDecoHostedMcp } from "@/core/deco-constants";
import { createDecopilotThreadStatusEvent } from "@decocms/shared/sdk";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { endTime, startTime, timing } from "hono/timing";
import { auth } from "../auth";
import { createMemberRoleCache } from "../auth/member-role-cache";
import {
  ContextFactory,
  createStudioContextFactory,
} from "../core/context-factory";
import type { StudioContext } from "../core/studio-context";
import { startSSEHub } from "../event-bus";
import {
  closeDatabase,
  getDb,
  type StudioDatabase,
  withSslmode,
} from "../database";
import {
  flushMonitoringData,
  meter,
  prometheusExporter,
  tracer,
  tracingMiddleware,
} from "../observability";
import { posthog } from "../posthog";
import authRoutes from "./routes/auth";
import desktopSessionBridgeRoutes from "./routes/desktop-session-bridge";
import {
  ADMIN_API_PREFIX,
  createAdminRoutes,
  fenceRawAdminSurface,
} from "./routes/admin";
import { createSsoRoutes } from "./routes/org-sso";
import { createDecopilotRoutes } from "./routes/decopilot";
import { createDownstreamTokenRoutes } from "./routes/downstream-token";
import {
  DownstreamTokenStorage,
  type DownstreamTokenData,
} from "../storage/downstream-token";
import { resolveOriginTokenEndpoint } from "../oauth/resolve-token-endpoint";
import {
  createLogDeprecatedRoute,
  logDeprecatedRoute,
} from "./middleware/log-deprecated-route";
import { handleApiError } from "./error-handler";
import { resolveOrgFromPath } from "./middleware/resolve-org-from-path";
import { createOrgScopedApi } from "./routes/org-scoped";
import {
  createDecoSitesOrgRoutes,
  createDecoSitesUserRoutes,
} from "./routes/deco-sites";
import { createDecoAppsRoutes } from "./routes/deco-apps";
import { createVirtualMcpRoutes } from "./routes/virtual-mcp";
import {
  createLegacyWellKnownProtectedResourceRoutes,
  createWellKnownAuthServerRoutes,
  fetchAuthorizationServerMetadata,
  fetchProtectedResourceMetadata,
  protectedResourceMetadataHandler,
} from "./routes/oauth-proxy";
import openaiCompatRoutes from "./routes/openai-compat";
import { createProxyRoutes } from "./routes/proxy";
import { createTriggerCallbackRoutes } from "./routes/trigger-callback";
import publicConfigRoutes from "./routes/public-config";
import { createReportPagesRoutes } from "./routes/report-pages";
import reportsRoutes from "./routes/reports";
import { stripeWebhookRoutes } from "./routes/stripe-webhook";
import filesRoutes from "./routes/files";
import { createThreadOutputsRoutes } from "./routes/thread-outputs";
import { createSelfRoutes } from "./routes/self";
import {
  isHealthPath,
  shouldSkipStudioContext,
  SYSTEM_PATHS,
} from "./utils/paths";
import { CredentialVault } from "../encryption/credential-vault";
import type { CancelBroadcast } from "./routes/decopilot/cancel-broadcast";
import {
  createNatsConnectionProvider,
  type NatsConnectionProvider,
} from "../nats/connection";
import {
  JetStreamKVMcpListCache,
  setMcpListCache,
  type McpListCache,
} from "../mcp-clients/mcp-list-cache";
import { isMcpCacheEnabled } from "../mcp-clients/mcp-read-cache";
import {
  startMcpCacheInvalidation,
  teardownMcpCacheInvalidation,
} from "../mcp-clients/mcp-cache-invalidation";
import {
  type ConnectionCircuitStore,
  JetStreamKVConnectionCircuitStore,
  NoopConnectionCircuitStore,
  setConnectionCircuitStore,
} from "../mcp-clients/connection-circuit-store";
import {
  InMemoryModelListCache,
  type ModelListCache,
} from "../ai-providers/model-list-cache";
import {
  createProviderKeyCache,
  type ProviderKeyCache,
} from "../storage/provider-key-cache";
import { NatsCancelBroadcast } from "./routes/decopilot/nats-cancel-broadcast";
import {
  initFlipBroadcast,
  stopFlipBroadcast,
} from "./routes/decopilot/flip-broadcast";
import type { StreamBuffer } from "./routes/decopilot/stream-buffer";
import { NatsStreamBuffer } from "./routes/decopilot/nats-stream-buffer";
import { RunRegistry } from "./routes/decopilot/run-registry";
import type { RunReactorDeps } from "./routes/decopilot/run-reactor";
import { emitTerminalThreadStatus } from "./routes/decopilot/thread-status-events";
import { SqlThreadStorage } from "../storage/threads";
import { TaskBoardStorage } from "../storage/task-board";
import { advanceTasksToReviewOnThreadFinish } from "../tools/task-board/run-reactions";
import { enqueueReviewersOnThreadFinish } from "../tools/task-board/enqueue-reviewer";
import { SqlAsyncResearchJobStorage } from "../storage/async-research-jobs";
import { AsyncResearchJobSweeper } from "../storage/async-research-jobs-sweeper";
import { registerMonitoringRetentionWorkflow } from "../monitoring/dbos-retention-workflow";
import "../auth/install-studio-pack-workflow";
import { cleanupOldMonitoringFiles } from "../monitoring/ndjson-retention";
import { getLogsDir, getTracesDir, getMetricsDir } from "../monitoring/schema";
import {
  AUTOMATIONS_PARTITION_CONCURRENCY,
  AUTOMATIONS_POLL_INTERVAL_MS,
  AUTOMATIONS_QUEUE,
  AutomationEventDispatcher,
  cleanupOrphanedOrgQueues,
  enqueueAutomationFire,
  fireAutomationNow,
  reconcileAutomationSchedules,
  setAutomationRuntime,
} from "../automations";
import {
  HOSTED_HARNESS_PARTITION_CONCURRENCY,
  HOSTED_HARNESS_QUEUE,
  setHostedHarnessRuntime,
  setThreadGateRuntime,
  THREAD_GATE_PARTITION_CONCURRENCY,
  THREAD_GATE_QUEUE,
} from "../dispatch-queue";
import { hostedRunStats } from "../dispatch-queue/hosted-run-concurrency";
import { setProjectorWorkflowRuntime } from "./routes/decopilot/projector-workflow";
import { synthesizedErrorMessageId } from "./routes/decopilot/message-ids";
import { backfillStudioPackForAllOrgs } from "../auth/install-studio-pack-workflow";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { dispatchRunAndWait } from "./routes/decopilot/dispatch-run";
import { createAutomationsStorage } from "../storage/automations";
import { KyselyKVStorage } from "../storage/kv";
import { KyselyTriggerCallbackTokenStorage } from "../storage/trigger-callback-tokens";
import { createAutomationContextFactory } from "./routes/decopilot/automation-context";
import type { Pool, PoolClient } from "pg";

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Acquire a client from the pool, run SELECT 1, and release it.
 * Destroys the connection (instead of returning it to the pool) on any
 * failure or timeout so stale connections don't accumulate.
 */
async function checkPostgres(pool: Pool): Promise<boolean> {
  const connectPromise = pool.connect();
  let client: PoolClient;
  try {
    client = await Promise.race([
      connectPromise,
      rejectAfter(HEALTH_CHECK_TIMEOUT_MS),
    ]);
  } catch {
    // Clean up a client that arrives after the timeout.
    void connectPromise.then((c) => c.release(true)).catch(() => {});
    return false;
  }
  try {
    await Promise.race([
      client.query("SELECT 1"),
      rejectAfter(HEALTH_CHECK_TIMEOUT_MS),
    ]);
    client.release();
    return true;
  } catch {
    client.release(true);
    return false;
  }
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("pg health-check timeout")), ms),
  );
}

// Track decopilot strategy cleanup (abort active runs, stop strategies) during HMR
let currentDecopilotCleanup: (() => void | Promise<void>) | null = null;

// ============================================================================
// Deco Store OAuth Helpers
// ============================================================================

/**
 * Get project_locator from the Deco Store registry connection.
 * Returns the locator string or null if not found/configured.
 *
 * @param ctx - The studio context
 * @param organizationId - The organization ID to search for the registry connection
 */
async function getDecoStoreProjectLocator(
  ctx: StudioContext,
  organizationId: string,
): Promise<string | null> {
  // Find registry connection by URL within the organization
  const { items: connections } = await ctx.storage.connections.list(
    organizationId,
    {
      where: {
        field: ["connection_url"],
        operator: "like",
        value: `${DECO_STORE_URL}%`,
      },
      limit: 1,
    },
  );
  const registryConn = connections[0];

  if (!registryConn?.configuration_state) {
    return null;
  }

  return (registryConn.configuration_state as Record<string, unknown>)
    .project_locator as string | null;
}

/**
 * Build OAuth query params for deco-hosted MCPs.
 * Uses project_locator from Deco Store registry or falls back to auto_personal.
 */
function buildDecoOAuthParams(projectLocator: string | null): URLSearchParams {
  const params = new URLSearchParams();

  if (projectLocator) {
    const [org, project] = projectLocator.split("/");
    if (org) params.set("workspace_hint", org);
    if (project) params.set("project_hint", project);
  } else {
    params.set("auto_personal", "true");
  }

  params.set("force_new", "true");

  return params;
}

// ============================================================================
// Inline route handlers (extracted to named functions so they can be
// dual-mounted at both the legacy paths and the new `/api/:org/...` paths.)
// ============================================================================

/**
 * Paths exempt from the server-side SSO enforcement middleware: SSO/auth
 * routes, the OAuth proxy (legacy `/oauth-proxy/...` and canonical
 * `/api/:org/oauth-proxy/...` — both must stay reachable so a browser
 * session mid-connect to a downstream MCP isn't 403'd before it can
 * establish an SSO session), and the instance-level admin surface.
 */
export function isSsoExemptPath(path: string): boolean {
  return (
    path.startsWith("/api/org-sso/") ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/tools/management") ||
    path.startsWith("/oauth-proxy/") ||
    /^\/api\/[^/]+\/oauth-proxy\//.test(path) ||
    // Instance-level operator surface — not governed by any single org's SSO
    // policy. Without this, an admin whose active org enforces SSO gets 403'd
    // off the whole dashboard, and the UI reads that as "not an admin".
    path.startsWith(`${ADMIN_API_PREFIX}/`)
  );
}

/**
 * Decide the `Access-Control-Allow-Origin` value for a request's `Origin`
 * header. The CORS middleware below sets `credentials: true`, so reflecting
 * every origin (the previous behavior) let any external site issue a
 * cookie-authenticated cross-site request against this API and read the
 * response — a permissive-CORS-with-credentials hole. Only reflect
 * localhost/127.0.0.1 (the Vite dev server, on a different port than the
 * API) and the deployment's own origin, falling back to the request's own
 * origin when `baseUrl` isn't configured (same fallback already used for
 * redirect_uri validation above).
 */
export function resolveCorsOrigin(
  origin: string,
  {
    baseUrl,
    requestOrigin,
  }: { baseUrl: string | undefined; requestOrigin: string },
): string | null {
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (originHost === "localhost" || originHost === "127.0.0.1") {
    return origin;
  }

  const allowedOrigin = baseUrl ?? requestOrigin;
  try {
    if (new URL(allowedOrigin).origin === origin) {
      return origin;
    }
  } catch {
    // malformed baseUrl config — fall through to reject
  }
  return null;
}

/**
 * Handle OAuth-proxy requests for an MCP connection.
 *
 * On the org-scoped mount (`/api/:org/oauth-proxy/...`) `resolveOrgFromPath`
 * has populated `ctx.organization`; we scope the connection lookup to it so
 * slug-spoofing (asking under org A for a connection that belongs to org B)
 * returns null. The legacy `/oauth-proxy/...` mount has no org in the URL and
 * does an unscoped lookup — using the session's `activeOrganizationId` there
 * would silently 404 multi-org users whose active session org differs from
 * the connection's owner.
 */
const oauthProxyHandler: MiddlewareHandler<Env> = async (c) => {
  const connectionId = c.req.param("connectionId");
  if (!connectionId) {
    return c.json({ error: "Missing connectionId" }, 400);
  }
  // Extract endpoint from path: /oauth-proxy/conn_xxx/register -> register
  // Filter empty parts to handle trailing slashes
  const pathParts = c.req.path.split("/").filter(Boolean);
  const endpoint = pathParts[pathParts.length - 1];

  // Get or create context
  let ctx = c.get("studioContext");
  if (!ctx) {
    ctx = await ContextFactory.create(c.req.raw);
    c.set("studioContext", ctx);
  }

  const orgScope = c.req.param("org") ? ctx.organization?.id : undefined;
  const connection = await ctx.storage.connections.findById(
    connectionId,
    orgScope,
  );
  if (!connection?.connection_url) {
    return c.json({ error: "Connection not found" }, 404);
  }

  // Get origin auth server - tries Protected Resource Metadata first, then falls back to origin root
  const resourceRes = await fetchProtectedResourceMetadata(
    connection.connection_url,
  );

  let originAuthServer: string | undefined;
  const connUrl = new URL(connection.connection_url);

  // RFC 8707 resource indicator forwarded to the downstream authorization
  // server on the authorize/token legs. Defaults to the connection's MCP
  // endpoint URL — what most servers validate against (e.g. Supabase requires
  // the exact endpoint). Some servers only accept the *origin* and reject a
  // path-bearing resource (e.g. Pipedream returns "Invalid or unauthorized
  // resource parameter" for ".../v2"). Allow a per-connection override via
  // `metadata.oauthResource` for those, falling back to the connection URL.
  const resourceOverride =
    typeof connection.metadata?.oauthResource === "string" &&
    connection.metadata.oauthResource.length > 0
      ? connection.metadata.oauthResource
      : undefined;
  const resourceIndicator = resourceOverride ?? connection.connection_url;

  if (resourceRes.ok) {
    // Origin has Protected Resource Metadata - use authorization_servers from it
    const resourceData = (await resourceRes.json()) as {
      authorization_servers?: string[];
    };
    originAuthServer = resourceData.authorization_servers?.[0];
  }

  // Fall back to origin root if:
  // - Origin doesn't have Protected Resource Metadata (like Apify)
  // - Or metadata exists but has empty/missing authorization_servers
  // Many servers expose /.well-known/oauth-authorization-server at the root even without RFC 9728
  if (!originAuthServer) {
    originAuthServer = connUrl.origin;
  }

  // Get OAuth endpoints from auth server metadata - uses shared function that tries all formats
  const authServerRes =
    await fetchAuthorizationServerMetadata(originAuthServer);
  if (!authServerRes.ok) {
    return c.json({ error: "Failed to get auth server metadata" }, 502);
  }
  const endpoints = (await authServerRes.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
  };

  // Map endpoint name to URL
  let originEndpointUrl: string | undefined;
  if (endpoint === "authorize") {
    originEndpointUrl = endpoints.authorization_endpoint;
  } else if (endpoint === "token") {
    originEndpointUrl = endpoints.token_endpoint;
  } else if (endpoint === "register") {
    originEndpointUrl = endpoints.registration_endpoint;
  }

  if (!originEndpointUrl) {
    return c.json({ error: `Unknown OAuth endpoint: ${endpoint}` }, 404);
  }

  // Build URL with query string
  const targetUrl = new URL(originEndpointUrl);
  const reqUrl = new URL(c.req.url);
  targetUrl.search = reqUrl.search;

  // For authorize endpoint, REDIRECT instead of proxying
  // The browser needs to navigate directly to the auth server so that:
  // 1. CSS/JS loads correctly from the origin
  // 2. Cookies are set on the correct domain
  // 3. The user can interact with the consent screen
  if (endpoint === "authorize") {
    // Validate redirect_uri to prevent OAuth hijacking — only allow our own origin.
    // Use .get() to grab the first value, then .set() to canonicalize to exactly
    // one redirect_uri param, preventing parser-differential bypasses via duplicates.
    const redirectUri = targetUrl.searchParams.get("redirect_uri");
    if (redirectUri) {
      const allowedOrigin = getSettings().baseUrl ?? reqUrl.origin;
      try {
        const redirectUrl = new URL(redirectUri);
        const allowedOriginObj = new URL(allowedOrigin);

        // Check if redirect_uri origin matches the allowed origin
        const isAllowed =
          redirectUrl.origin === allowedOriginObj.origin ||
          // Allow localhost for development
          redirectUrl.hostname === "localhost";

        if (!isAllowed) {
          return c.json(
            {
              error: "invalid_request",
              error_description: "redirect_uri is not allowed",
            },
            400,
          );
        }
      } catch {
        return c.json(
          {
            error: "invalid_request",
            error_description: "redirect_uri is malformed",
          },
          400,
        );
      }
      // Collapse any duplicate redirect_uri params to the single validated value
      targetUrl.searchParams.set("redirect_uri", redirectUri);
    }

    // IMPORTANT: Rewrite the 'resource' parameter to point to the origin MCP endpoint
    // Some auth servers (like Supabase) validate that the resource is their actual endpoint,
    // not our proxy. We keep the proxy URL for redirect_uri since that's where we handle the callback.
    if (targetUrl.searchParams.has("resource")) {
      targetUrl.searchParams.set("resource", resourceIndicator);
    }

    // Add smart OAuth params for deco-hosted MCPs to skip org/project selection
    // Wrapped in try-catch to ensure OAuth redirect proceeds even if smart params fail
    if (isDecoHostedMcp(connection.connection_url)) {
      try {
        const projectLocator = await getDecoStoreProjectLocator(
          ctx,
          connection.organization_id,
        );
        const smartParams = buildDecoOAuthParams(projectLocator);
        for (const [key, value] of smartParams) {
          targetUrl.searchParams.set(key, value);
        }
      } catch (error) {
        console.warn(
          "[oauth-proxy] Failed to get smart OAuth params, proceeding without:",
          error,
        );
      }
    }

    return c.redirect(targetUrl.toString(), 302);
  }

  // Forward headers for token/register endpoints
  const headers: Record<string, string> = {
    Accept: c.req.header("Accept") || "application/json",
  };
  const contentType = c.req.header("Content-Type");
  if (contentType) headers["Content-Type"] = contentType;
  const authorization = c.req.header("Authorization");
  if (authorization) headers["Authorization"] = authorization;

  // For token endpoint, we may need to rewrite the 'resource' parameter in the body
  // (same reason as authorize: auth servers validate it's their actual endpoint)
  let requestBody: BodyInit | undefined;
  // Capture client_id/client_secret from the token request so we can persist
  // them server-side alongside the resulting access/refresh tokens. The DCR
  // registration that minted these credentials happened in a prior request,
  // so the body of /token is the only place we can read them on the proxy.
  let capturedClientId: string | null = null;
  let capturedClientSecret: string | null = null;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (
      endpoint === "token" &&
      contentType?.includes("application/x-www-form-urlencoded")
    ) {
      // Per RFC 6749 §2.3.1, confidential clients may send credentials via
      // HTTP Basic auth instead of the form body. Capture from the header
      // first so the body parse below can still override when a client sends
      // both — without this fallback, Basic-auth clients persist with a
      // null clientId and become non-refreshable.
      if (authorization?.toLowerCase().startsWith("basic ")) {
        try {
          const decoded = atob(authorization.slice(6).trim());
          const colonIdx = decoded.indexOf(":");
          if (colonIdx !== -1) {
            // RFC 6749 §2.3.1: the credentials are form-urlencoded before
            // being base64'd as the Basic value.
            const id = decodeURIComponent(decoded.slice(0, colonIdx));
            const secret = decodeURIComponent(decoded.slice(colonIdx + 1));
            capturedClientId = id || null;
            capturedClientSecret = secret || null;
          }
        } catch {
          // Malformed Basic header — let origin reject the request.
        }
      }
      // Parse form body and rewrite resource if present
      const formData = await c.req.formData();
      if (formData.has("resource")) {
        formData.set("resource", resourceIndicator);
      }
      const cidRaw = formData.get("client_id");
      const csRaw = formData.get("client_secret");
      if (typeof cidRaw === "string" && cidRaw) capturedClientId = cidRaw;
      if (typeof csRaw === "string" && csRaw) capturedClientSecret = csRaw;
      // Convert back to URLSearchParams for form-urlencoded
      const params = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        params.append(key, value.toString());
      }
      requestBody = params.toString();
    } else if (
      endpoint === "register" &&
      // Media types are case-insensitive (RFC 7231 §3.1.1.1) — normalize so
      // `Application/JSON` etc. don't bypass the injection.
      contentType
        ?.toLowerCase()
        .includes("application/json")
    ) {
      // Inject the connection's owning org into the DCR `metadata` field so the
      // downstream MCP App can scope the registered OAuth client to a tenant
      // without depending on user session state. RFC 7591 §2 reserves
      // `metadata` for arbitrary client metadata extensions; downstream servers
      // that don't recognize the field MUST ignore it.
      // Gated on JSON content type so non-JSON DCR bodies (spec-violating but
      // possible) get byte-perfect passthrough via the raw-body branch below
      // instead of a lossy UTF-8 decode/re-encode round trip.
      const org = await ctx.db
        .selectFrom("organization")
        .select(["id", "slug", "name"])
        .where("id", "=", connection.organization_id)
        .executeTakeFirst();
      const rawText = await c.req.text();
      let parsed: unknown = {};
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        // Body isn't JSON — pass through unchanged so origin returns its own
        // 400, rather than us masking the client error.
        requestBody = rawText;
      }
      // Only mutate plain objects. Arrays, null, and primitives are non-spec
      // for DCR and would either throw on property assignment (null/primitive)
      // or be silently dropped by `JSON.stringify` (array). Pass them through
      // and let origin return the appropriate 4xx.
      const isPlainObject =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      if (requestBody === undefined && !isPlainObject) {
        requestBody = rawText;
      }
      if (requestBody === undefined) {
        const obj = parsed as Record<string, unknown>;
        const existingMetadata =
          obj.metadata && typeof obj.metadata === "object"
            ? (obj.metadata as Record<string, unknown>)
            : {};
        obj.metadata = {
          ...existingMetadata,
          organization_id: connection.organization_id,
          ...(org?.slug ? { organization_slug: org.slug } : {}),
          ...(org?.name ? { organization_name: org.name } : {}),
        };
        requestBody = JSON.stringify(obj);
        headers["Content-Type"] = "application/json";
      }
    } else {
      // For other content types, pass through as-is
      requestBody = c.req.raw.body ?? undefined;
    }
  }

  // Proxy the request (token and register endpoints only)
  const response = await fetch(targetUrl.toString(), {
    method: c.req.method,
    headers,
    body: requestBody,
    // @ts-expect-error - duplex needed for streaming
    duplex: "half",
    redirect: "manual",
  });

  // Copy response headers, excluding hop-by-hop and encoding headers
  // Note: Node.js fetch auto-decompresses, so content-encoding/content-length would be wrong
  const responseHeaders = new Headers();
  const excludedHeaders = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-encoding",
    "content-length",
  ];
  for (const [key, value] of response.headers.entries()) {
    if (!excludedHeaders.includes(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  // For successful token exchanges (initial code-for-token and refresh_token
  // grants), persist the token server-side immediately. This decouples the
  // OAuth flow from the browser's session cookie state — the client used to
  // POST the token back to /api/:org/connections/:id/oauth-token with
  // cookie auth, which 401s when the popup's redirect chain leaves the
  // parent's session in an inconsistent state.
  if (endpoint === "token" && response.ok) {
    const bodyText = await response.text();
    try {
      const parsed = JSON.parse(bodyText) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
      };
      if (typeof parsed.access_token === "string" && parsed.access_token) {
        const expiresAt =
          typeof parsed.expires_in === "number"
            ? new Date(Date.now() + parsed.expires_in * 1000)
            : null;
        // Prefer the origin's real token endpoint so future refreshes don't
        // self-loop through the proxy.
        let tokenEndpoint: string | null = null;
        try {
          tokenEndpoint =
            (await resolveOriginTokenEndpoint(connection.connection_url)) ??
            originEndpointUrl;
        } catch {
          tokenEndpoint = originEndpointUrl;
        }
        const tokenData: DownstreamTokenData = {
          connectionId,
          accessToken: parsed.access_token,
          refreshToken:
            typeof parsed.refresh_token === "string"
              ? parsed.refresh_token
              : null,
          scope: typeof parsed.scope === "string" ? parsed.scope : null,
          expiresAt,
          clientId: capturedClientId,
          clientSecret: capturedClientSecret,
          tokenEndpoint,
        };
        const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
        await tokenStorage.upsert(tokenData);
      }
    } catch (err) {
      console.error("[oauth-proxy] failed to persist downstream token:", err);
    }
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

/**
 * SSE events endpoint — streams events for an organization in real time.
 * Resolves the org from `ctx.organization.id` (set by `resolveOrgFromPath`
 * on the `/api/:org/watch` mount). Auth is required.
 *
 * On connect, emits in order:
 *   1. `event: connected` — listener metadata
 *   2. Live events from the SSE hub.
 *
 * Clients use `COLLECTION_THREADS_LIST` for their initial state.
 */
export const watchHandler: MiddlewareHandler<Env> = async (c) => {
  const studioContext = c.var.studioContext;

  // Require authentication (user session or API key)
  const userId =
    studioContext.auth.user?.id ?? studioContext.auth.apiKey?.userId;
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const orgId = studioContext.organization?.id;
  if (!orgId) {
    return c.json({ error: "organization id missing" }, 400);
  }

  // Optional type filter: ?types=workflow.*,public.* (comma-separated patterns)
  const typesParam = c.req.query("types");
  const typePatterns = typesParam
    ? typesParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : null;

  const listenerId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    // Send initial connection event
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        listenerId,
        organizationId: orgId,
        typePatterns,
        connectedAt: new Date().toISOString(),
      }),
    });

    // Register listener with the SSE hub
    const registered = sseHub.add({
      id: listenerId,
      organizationId: orgId,
      typePatterns: typePatterns?.length ? typePatterns : null,
      push: (event: SSEEvent) => {
        // Write to the SSE stream — fire-and-forget
        stream
          .writeSSE({
            id: event.id,
            event: event.type,
            data: JSON.stringify(event),
          })
          .catch(() => {
            // Stream broken — remove immediately so no further events are
            // attempted. onAbort handles interval cleanup.
            sseHub.remove(orgId, listenerId);
          });
      },
    });

    if (!registered) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          error: "Too many connections",
          message: "SSE connection limit reached. Try again later.",
        }),
      });
      return;
    }

    // Send periodic keepalive comments to detect dead connections
    const keepaliveInterval = setInterval(() => {
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        clearInterval(keepaliveInterval);
      });
    }, 30_000);

    // Cleanup when the client disconnects and keep the stream open
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(keepaliveInterval);
        sseHub.remove(orgId, listenerId);
        resolve();
      });
    });
  });
};

// Create serializer for Prometheus text format (shared across instances)
const prometheusSerializer = new PrometheusSerializer();

// Mount OAuth discovery metadata endpoints (shared across instances)
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import { MiddlewareHandler } from "hono/types";
import {
  getToolsByCategory,
  MANAGEMENT_TOOLS,
} from "@decocms/shared/tools/registry-metadata";
import { Env } from "./hono-env";
import { devLogger } from "./utils/dev-logger";
import { streamSSE } from "hono/streaming";
import { type SSEEvent, sseHub } from "../event-bus";
import {
  BACKGROUND_TOOLS_PARTITION_CONCURRENCY,
  BACKGROUND_TOOLS_QUEUE,
  setBackgroundToolRuntime,
} from "@/harnesses/decopilot/background-tool-workflow";
import { abortBackgroundJobs } from "@/harnesses/decopilot/background-abort-registry";
const DBOS_QUEUE_NAMES = new Set([
  AUTOMATIONS_QUEUE,
  THREAD_GATE_QUEUE,
  HOSTED_HARNESS_QUEUE,
  BACKGROUND_TOOLS_QUEUE,
]);
const getHandleOAuthProtectedResourceMetadata = () =>
  oAuthProtectedResourceMetadata(auth);
const getHandleOAuthDiscoveryMetadata = () => oAuthDiscoveryMetadata(auth);

/**
 * Resource server metadata type
 */
interface ResourceServerMetadata {
  resource: string;
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_signing_alg_values_supported: string[];
}

/**
 * App configuration options
 */
export interface CreateAppOptions {
  /** Custom database instance (for testing) */
  database?: StudioDatabase;
  /** Skip NATS wiring and use local-only no-op stubs (for testing) */
  disableNats?: boolean;
  /** Built client directory used to serve report pages with dynamic metadata. */
  clientDir?: string;
}

/**
 * Create a configured Hono app instance
 * Allows injecting a custom database for testing
 */
export async function createApp(options: CreateAppOptions = {}) {
  const database = options.database ?? getDb();
  let isShuttingDown = false;

  // Stop any existing SSE hub broadcast (cleanup during HMR). No-op if not started.
  sseHub.stop().catch((error) => {
    console.error(
      "[SSEHub] Error stopping previous broadcast (HMR cleanup):",
      error,
    );
  });

  let mcpListCache: McpListCache | null;
  let connectionCircuitStore: ConnectionCircuitStore;
  // Model lists are public, low-stakes metadata cached per-replica with a TTL —
  // no NATS needed, so this is shared across the test and production branches.
  const modelListCache: ModelListCache = new InMemoryModelListCache();
  // Provider-key resolve cache. The NATS connection is wired in the production
  // branch below; without it the cache runs local-only (TTL still applies),
  // which is what the test/no-NATS branch wants.
  let providerKeyCache: ProviderKeyCache;
  let cancelBroadcast: CancelBroadcast;
  let streamBuffer: StreamBuffer;
  let natsProvider: NatsConnectionProvider | null = null;

  if (options.disableNats) {
    // Test mode: no-op stubs (no NATS required)
    // Local-only (no NATS): cross-replica broadcast is a no-op, TTL still applies.
    providerKeyCache = createProviderKeyCache();
    mcpListCache = {
      get: async () => null,
      set: async () => {},
      invalidate: async () => {},
      teardown: () => {},
    };
    connectionCircuitStore = new NoopConnectionCircuitStore();
    cancelBroadcast = {
      start: async () => {},
      broadcast: () => {},
      publishControlFrame: () => {},
      stop: async () => {},
    };
    streamBuffer = {
      init: async () => {},
      // Test/no-NATS stub: drain the stream so `createUIMessageStream`'s
      // `execute` actually runs to completion. Nothing is buffered;
      // `createTailStream` returns null so `dispatchRunAndWait` never takes
      // the tail-wait branch that calls `pump()` — this stub only exists to
      // satisfy the `StreamBuffer` interface (`disableNats` mode has no
      // durable subject to race, so there's nothing to propagate here).
      pump: (stream: ReadableStream) => {
        return (async () => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch {
            // swallow; the run's own onError handles state transitions
          } finally {
            reader.releaseLock();
          }
        })();
      },
      // No-NATS stub: there is no durable subject to commit to, so signal
      // "unavailable" (false) — the publish-then-consume ingest must not
      // advance its ack cursor when the chunk wasn't actually persisted.
      publishRawChunk: async () => false,
      // No-NATS stub: no durable done marker to publish, so signal
      // "unavailable" (false) — the caller must not treat the run as handed
      // off to the projector.
      publishDone: async () => false,
      createTailStream: async () => null,
      purge: () => {},
      teardown: () => {},
    };
  } else {
    // Production/dev mode: connect to NATS (required)
    natsProvider = createNatsConnectionProvider();
    // Optional cluster creds: local dev runs NATS in operator mode (anonymous
    // connect is impossible there), so ensure-services persists a cluster creds
    // file and points NATS_CREDS at it. Absent (production) → anonymous connect.
    const credsPath = getSettings().natsCredsPath;
    let creds: string | undefined;
    if (credsPath) {
      try {
        creds = readFileSync(credsPath, "utf8");
      } catch (err) {
        console.error(
          `[app] failed to read NATS_CREDS at ${credsPath}; connecting anonymously`,
          err,
        );
      }
    }
    natsProvider.init(getSettings().natsUrls, creds ? { creds } : undefined);

    // Cross-pod MCP list cache is gated by the same flag as the read cache.
    // When disabled, leave mcpListCache null so getMcpListCache() callers fetch live.
    const tlc = isMcpCacheEnabled()
      ? new JetStreamKVMcpListCache({
          getJetStream: () => natsProvider!.getJetStream(),
        })
      : null;
    tlc?.init().catch(() => {});
    mcpListCache = tlc;

    const ccs = new JetStreamKVConnectionCircuitStore({
      getJetStream: () => natsProvider!.getJetStream(),
    });
    ccs.init().catch(() => {});
    connectionCircuitStore = ccs;

    providerKeyCache = createProviderKeyCache({
      getConnection: () => natsProvider!.getConnection(),
    });

    cancelBroadcast = new NatsCancelBroadcast({
      getConnection: () => natsProvider!.getConnection(),
    });

    streamBuffer = new NatsStreamBuffer({
      getConnection: () => natsProvider!.getConnection(),
      getJetStream: () => natsProvider!.getJetStream(),
    });

    startSSEHub(natsProvider);

    // When NATS connects, (re-)initialize all deferred consumers
    natsProvider.onReady(() => {
      tlc?.init().catch((err: unknown) => {
        console.error("[McpListCache] Deferred init failed:", err);
      });
      ccs.init().catch((err: unknown) => {
        console.error("[ConnectionCircuitStore] Deferred init failed:", err);
      });
      // Subscribe to cross-replica key invalidations (idempotent).
      providerKeyCache.start();
      // Subscribe to cross-replica MCP read/result cache invalidations.
      startMcpCacheInvalidation(() => natsProvider!.getConnection());
      // `streamBuffer.init()` CREATES the DECOPILOT_STREAMS JetStream stream.
      streamBuffer.init().catch((err: unknown) => {
        console.warn(
          "[Decopilot] StreamBuffer init failed (late-join disabled):",
          err,
        );
      });
    });
  }

  // Decopilot strategy cleanup on HMR / shutdown
  if (currentDecopilotCleanup) await currentDecopilotCleanup();

  // Set tool list cache after cleanup to avoid previous cleanup nulling the new cache
  setMcpListCache(mcpListCache);
  setConnectionCircuitStore(connectionCircuitStore);

  const threadStorage = new SqlThreadStorage(database.db);

  const cancelReactorDeps: RunReactorDeps = {
    storage: threadStorage,
    sseHub,
  };

  const runRegistry = new RunRegistry(cancelReactorDeps);

  // Shared async-research-job storage — used both by the background
  // sweeper and by the automation context factory below, which rebinds it
  // with the right org for dispatched runs (without that rebind, the
  // web_search tool throws on its first call).
  const asyncResearchJobStorage = new SqlAsyncResearchJobStorage(database.db);

  // Background sweeper for the async_research_jobs table. Marks rows that
  // have been stuck in pending/polling longer than the staleness window as
  // 'abandoned' so they show up in audit queries instead of silently rotting.
  const asyncResearchJobSweeper = new AsyncResearchJobSweeper(
    asyncResearchJobStorage,
  );
  asyncResearchJobSweeper.start();

  cancelBroadcast
    .start((taskId) => {
      // Abort any in-flight background-tool work (e.g. generate_image) on this
      // pod before cancelling the live turn — the work runs on whichever pod
      // dequeued the DBOS job, which this NATS fan-out reaches.
      abortBackgroundJobs(taskId);
      runRegistry.execute({ type: "CANCEL", taskId }).catch((err) => {
        console.error("[Decopilot] CancelBroadcast execute failed:", err);
      });
    })
    .catch((err) => {
      console.error("[Decopilot] CancelBroadcast start failed:", err);
    });

  // Re-start cancel broadcast subscription when NATS connects
  natsProvider?.onReady(() => {
    cancelBroadcast.start().catch((err) => {
      console.error("[CancelBroadcast] Deferred start failed:", err);
    });
  });

  // Cross-pod "flip subtask to background" fan-out. Local-only without NATS
  // (single-pod dev); re-subscribes on reconnect.
  const flipConnection = () => natsProvider?.getConnection() ?? null;
  initFlipBroadcast(flipConnection);
  natsProvider?.onReady(() => initFlipBroadcast(flipConnection));
  streamBuffer.init().catch((err) => {
    console.warn(
      "[Decopilot] StreamBuffer init failed, attach/late-join disabled:",
      err,
    );
  });

  currentDecopilotCleanup = async () => {
    await runRegistry.stopAll();
    runRegistry.dispose();
    asyncResearchJobSweeper.dispose();
    cancelBroadcast.stop().catch(() => {});
    stopFlipBroadcast();
    streamBuffer.teardown();
    mcpListCache?.teardown();
    modelListCache.teardown();
    providerKeyCache.teardown();
    teardownMcpCacheInvalidation();
    connectionCircuitStore.teardown();
    setMcpListCache(null);
    setConnectionCircuitStore(null);
  };

  const app = new Hono<Env>();

  // ============================================================================
  // Middleware
  // ============================================================================

  // Server-Timing middleware — opt in per-request via `cookie debug=1`
  app.use(
    "*",
    timing({
      enabled: (c) => getCookie(c, "debug") === "1",
    }),
  );

  // OpenTelemetry tracing middleware
  app.use("*", tracingMiddleware);

  // CORS middleware
  app.use(
    "/*",
    cors({
      origin: (origin, c) =>
        resolveCorsOrigin(origin, {
          baseUrl: getSettings().baseUrl,
          requestOrigin: new URL(c.req.url).origin,
        }),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "mcp-protocol-version"],
      // Expose WWW-Authenticate so OAuth discovery works from cross-origin clients
      exposeHeaders: ["WWW-Authenticate"],
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    // Org-scoped /files/* and org-fs /fs/:volume/read serve user content
    // (HTML pages written by the web-developer agent, uploaded images,
    // thread outputs, etc.) that we deliberately iframe back into the app
    // (pages preview, FileTab). Same-origin only — auth middleware still
    // gates access — and consumers are expected to sandbox the iframe.
    if (c.req.path.includes("/files/")) return;
    if (c.req.path.includes("/fs/") && c.req.path.endsWith("/read")) return;
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  });

  if (!getSettings().noTui) {
    app.use("*", devLogger());
  }

  // Log response body for 5xx errors
  app.use("*", async (c, next) => {
    await next();
    if (isHealthPath(c.req.path)) return;
    if (c.res.status >= 500) {
      const clonedRes = c.res.clone();
      const body = await clonedRes.text();
      console.error(
        `[5xx Response] ${c.req.method} ${c.req.path} - ${c.res.status}:`,
        body,
      );
    }
  });

  // ============================================================================
  // Health Check & Metrics
  // ============================================================================

  // AWS NLB target-group health check (path "/health"). Cheap — no DB/NATS
  // probe — but flips to 503 during shutdown so the load balancer stops routing
  // to a draining pod. Without an explicit route this falls through to the SPA
  // handler and returns 200 forever, hiding shutdown from the NLB.
  app.get(SYSTEM_PATHS.HEALTH, (c) => {
    if (isShuttingDown) {
      return c.json({ status: "shutting_down" }, 503);
    }
    return c.json({ status: "ok" });
  });

  // Liveness probe — the process is alive and the event loop is not stuck
  app.get(SYSTEM_PATHS.HEALTH_LIVE, (c) => {
    return c.json({ status: "ok" });
  });

  // Readiness probe — returns 503 during shutdown so K8s drains traffic before liveness fails,
  // and checks that DB and NATS are reachable
  app.get(SYSTEM_PATHS.HEALTH_READY, async (c) => {
    if (isShuttingDown) {
      return c.json({ status: "shutting_down" }, 503);
    }

    const services: Record<string, { status: "up" | "down" }> = {};

    // Check PostgreSQL (hard dependency — determines readiness)
    services.postgres = {
      status: (await checkPostgres(database.pool)) ? "up" : "down",
    };

    // Check NATS (soft dependency — reported but does not block readiness)
    if (natsProvider) {
      services.nats = natsProvider.isConnected()
        ? { status: "up" }
        : { status: "down" };
    } else {
      services.nats = { status: "down" };
    }

    const ready = services.postgres.status === "up";
    const httpStatus = ready ? 200 : 503;

    return c.json(
      { status: ready ? "ready" : "not_ready", services },
      httpStatus,
    );
  });

  // Prometheus metrics endpoint
  app.get(SYSTEM_PATHS.METRICS, async (c) => {
    try {
      // Force collection of metrics (optional, metrics are usually auto-collected)
      const result = await prometheusExporter.collect();

      // Serialize to Prometheus text format
      const text = prometheusSerializer.serialize(result.resourceMetrics);

      return c.text(text, 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    } catch (error) {
      console.error("Failed to collect metrics:", error);
      return c.text("# Error collecting metrics", 500);
    }
  });

  // Backlog size (ENQUEUED count) for one DBOS queue, e.g. for a KEDA
  // metrics-api trigger: `{ "queue_length": <n> }`. Restricted to the
  // queues we actually register — DBOS.listQueuedWorkflows would happily
  // query a made-up name and just return an empty list.
  app.get(`${SYSTEM_PATHS.DBOS_QUEUE_DEPTH_PREFIX}:queueName`, async (c) => {
    const queueName = c.req.param("queueName");
    if (!DBOS_QUEUE_NAMES.has(queueName)) {
      return c.json({ error: `Unknown queue: ${queueName}` }, 404);
    }
    const queued = await DBOS.listQueuedWorkflows({
      queueName,
      status: "ENQUEUED",
    });
    return c.json({ queue_length: queued.length });
  });

  // Hosted-run gate backlog on THIS pod, for a KEDA metrics-api trigger:
  // `{ "pending": <n> }`. Distinct from /dbos-queue-depth (ENQUEUED count) —
  // gate-parked runs are already DEQUEUED (PENDING) and pinned to this pod, so
  // queue depth can't see them (see hosted-run-concurrency.ts). Per-pod, so the
  // trigger must aggregate across worker pods.
  app.get(SYSTEM_PATHS.HOSTED_RUN_PENDING, (c) => {
    const { active, pending, max } = hostedRunStats();
    return c.json({ pending, active, max });
  });

  // ============================================================================
  // Public Configuration (no auth required)
  // ============================================================================
  app.route("/api/config", publicConfigRoutes);

  // Report shell stays public so authentication can happen inline, while all
  // report data and scan operations behind this proxy require a user session.
  app.route("/api/_reports", reportsRoutes);

  // Stripe webhook (per-seat billing): signature-authed, no session — the
  // caller is Stripe. Instance-level namespace, before the /api/:org catch-all.
  app.route("/api/_stripe", stripeWebhookRoutes);

  // Auth-gated report page + domain-derived metadata. API-only/test apps safely
  // return 404 for the HTML shell when no built client directory is supplied.
  // Mounted twice: the nginx front door only proxies /api-prefixed paths to
  // this server (everything else falls through to the static SPA), so the
  // share-card image URL (og:image → /api/report/:domain/og.png) rides the
  // /api mount to stay reachable in production without touching nginx.
  const reportPages = createReportPagesRoutes(options.clientDir);
  app.route("/report", reportPages);
  app.route("/api/report", reportPages);

  // ============================================================================
  // Better Auth Routes
  // ============================================================================

  // Auth routes (API key management via web UI)
  app.route("/api/auth/custom", authRoutes);
  // POST /api/auth/desktop/session-from-oauth — mints a real Better Auth
  // session from a valid MCP OAuth bearer, for the desktop app's
  // system-browser (Google/GitHub/SAML) login path. Mounted BEFORE the
  // `/api/auth/*` catchall (`auth.handler`) so it never reaches it. See
  // `./routes/desktop-session-bridge.ts`'s module doc for why this exists.
  app.route("/api/auth/desktop", desktopSessionBridgeRoutes);

  // Fence off the raw Better Auth admin plugin (/api/auth/admin/*) from
  // external callers — see fenceRawAdminSurface's doc in routes/admin.ts for
  // why this must exist whenever deploymentAdminUserIds does.
  app.all("/api/auth/admin/*", fenceRawAdminSurface);

  // All Better Auth routes (OAuth, session management, etc.)
  app.all("/api/auth/*", async (c) => {
    return await auth.handler(c.req.raw);
  });

  // ============================================================================
  // OAuth Proxy Routes (for proxying OAuth to origin MCP servers)
  // MUST be defined BEFORE the wildcard OAuth routes below
  // ============================================================================

  // OAuth Protected-Resource discovery metadata — proxied from the origin MCP
  // server. The legacy server-URL shape (`/mcp/:id`) gets a deprecation log;
  // the resource-relative shape for the new `/api/:org/mcp/:id` family is
  // mounted via `createOrgScopedApi` below.
  const legacyWellKnownProtectedResource =
    createLegacyWellKnownProtectedResourceRoutes();
  // Scope the deprecation log to the two specific legacy paths this sub-app
  // owns, NOT `use("*", ...)`. Because this sub-app is mounted at `/`, a
  // wildcard middleware fires for every request to the root app — and the
  // suppression logic in `log-deprecated-route.ts` can't reliably tell
  // root-app handlers (e.g. `/api/links/heartbeat`) apart from this
  // sub-app's handlers via basePath alone. Pinning the middleware to the
  // actual deprecated patterns avoids the false-positive entirely.
  legacyWellKnownProtectedResource.use(
    "/.well-known/oauth-protected-resource/mcp/:connectionId",
    logDeprecatedRoute,
  );
  legacyWellKnownProtectedResource.use(
    "/mcp/:connectionId/.well-known/oauth-protected-resource",
    logDeprecatedRoute,
  );
  app.route("/", legacyWellKnownProtectedResource);

  // Well-known *prefix* discovery for the new org-scoped server URL shape.
  // RFC 9728 Format 2 anchors `/.well-known/oauth-protected-resource` at the
  // origin and appends the resource path, so the SDK probes
  // `/.well-known/oauth-protected-resource/api/:org/mcp/:connectionId` — that
  // path lives at the URL root, NOT under the `/api/:org` sub-app, and must
  // not be tagged as a deprecated route. The handler reads the org slug from
  // the path via `detectOrgSlugFromPath`.
  app.get(
    "/.well-known/oauth-protected-resource/api/:org/mcp/:connectionId",
    protectedResourceMetadataHandler,
  );

  // Auth-server metadata stays at the legacy global path indefinitely —
  // third-party OAuth providers may have this URL registered as a
  // redirect_uri base, so we don't migrate or log deprecation here.
  app.route("/", createWellKnownAuthServerRoutes());

  // OAuth endpoint proxy — legacy mount with deprecation log. The new
  // canonical mount lives under `/api/:org/oauth-proxy/...` (registered via
  // `createOrgScopedApi` below) and gets cross-org enforcement for free.
  app.use("/oauth-proxy/:connectionId/*", logDeprecatedRoute);
  app.all("/oauth-proxy/:connectionId/*", oauthProxyHandler);

  // Better-Auth-served Protected Resource Metadata for the gateway-style MCP
  // URL family. The handler is the same regardless of which path it's mounted
  // at (Better Auth derives the resource from `baseURL`), so the legacy and
  // new mounts share the same closure. Legacy mount gets the deprecation log.
  const betterAuthProtectedResourceHandler: MiddlewareHandler<Env> = async (
    c,
  ) => {
    const handleOAuthProtectedResourceMetadata =
      getHandleOAuthProtectedResourceMetadata();
    const res = await handleOAuthProtectedResourceMetadata(c.req.raw);
    const data = (await res.json()) as ResourceServerMetadata;
    return Response.json(data, res);
  };
  app.use(
    "/mcp/:gateway?/:connectionId/.well-known/oauth-protected-resource/*",
    logDeprecatedRoute,
  );
  app.get(
    "/mcp/:gateway?/:connectionId/.well-known/oauth-protected-resource/*",
    betterAuthProtectedResourceHandler,
  );

  const authorizationServerHandler: MiddlewareHandler<Env> = async (c) => {
    const handleOAuthDiscoveryMetadata = getHandleOAuthDiscoveryMetadata();
    const res = await handleOAuthDiscoveryMetadata(c.req.raw);
    const data = await res.json();
    return Response.json(data, res);
  };

  // RFC 8414 mandates this exact path location, so it stays global per the
  // org-scoped-API plan (no `/api/:org/...` mount, no deprecation log).
  app.get(
    "/.well-known/oauth-authorization-server/*/:gateway?/:connectionId?",
    authorizationServerHandler,
  );

  // ============================================================================
  // StudioContext Injection Middleware
  // ============================================================================

  // Create context factory with the provided database and event bus
  // Context factory only needs the Kysely instance, not the full StudioDatabase
  const memberRoleCache = createMemberRoleCache({ ttlMs: 2 * 60 * 1000 });
  const factory = await createStudioContextFactory({
    db: database.db,
    auth,
    encryption: {
      key: getSettings().encryptionKey,
    },
    observability: {
      tracer,
      meter,
    },
    modelListCache,
    providerKeyCache,
    memberRoleCache,
  });
  ContextFactory.set(factory);

  // Credential vault — shared by the Private Registry public routes (mounted
  // below).
  const vault = new CredentialVault(getSettings().encryptionKey);

  // Public skill sets: synced by a DBOS scheduled workflow (one pod per tick
  // instead of every pod racing its own loop). This only stashes deps — the
  // workflow no-ops when ORGFS_PUBLIC_SETS is unset.
  setPublicSetsSyncRuntime({ db: database.db, baseUrl: getPublicUrl() });

  // ============================================================================
  // Automation Runtime — wire storage + streaming into the DBOS workflow
  // ============================================================================

  const automationsStorage = createAutomationsStorage(database.db);
  const triggerCallbackTokenStorage = new KyselyTriggerCallbackTokenStorage(
    database.db,
  );

  const automationContextFactory = createAutomationContextFactory({
    db: database.db,
  });

  // Stash deps for the DBOS workflow body. Safe to call before DBOS.launch():
  // it only writes a module-level pointer, no DBOS API calls.
  // The actual dispatch (and its dispatch-run deps) lives on the thread-gate
  // runtime now — automations invoke its shared `runDispatchSteps` body.
  setAutomationRuntime({
    storage: automationsStorage,
    studioContextFactory: automationContextFactory,
  });

  // The per-thread gate now STARTS the run (hosted: fire-and-forget enqueue of
  // the hosted-harness child; desktop: publish the work item) and lets the
  // consume step write terminal status. It no longer runs the agent loop itself,
  // so it no longer needs a `dispatchRunFn` or a status-poll cap. Wiring happens
  // before `DBOS.launch()` for the same reasons as automations.
  setThreadGateRuntime({
    studioContextFactory: automationContextFactory,
    deps: {
      runRegistry,
      cancelBroadcast,
      streamBuffer,
      sseHub,
    },
  });

  // Hosted (in-process) agent-loop runtime — the thread gate's
  // `dispatchRunAndWaitStep` now enqueues `hostedHarnessWorkflow` fire-and-forget
  // onto HOSTED_HARNESS_QUEUE instead of running inline. Wired here before
  // `DBOS.launch()` (it only sets a module-level pointer, no DBOS API calls),
  // mirroring the thread-gate runtime. The gate immediately proceeds to its
  // consume step, which writes terminal status for both hosted and desktop runs.
  setHostedHarnessRuntime({
    dispatchRunFn: dispatchRunAndWait,
    studioContextFactory: automationContextFactory,
    deps: {
      runRegistry,
      cancelBroadcast,
      streamBuffer,
      sseHub,
    },
  });

  // Durable projector workflow runtime — the SOLE v2 DB writer (parts + title +
  // terminal status). Consumed by the consume-run-projection step which
  // reconstructs the run from file-backed JetStream and writes durably to the
  // database. Wired before `DBOS.launch()` for the same reason as
  // automations/thread-gate: it only sets a module-level pointer.
  const projectorThreadStorage = new SqlThreadStorage(database.db);
  const projectorTaskBoard = new TaskBoardStorage(database.db);
  setProjectorWorkflowRuntime({
    getJetStream: () => natsProvider?.getJetStream() ?? null,
    getJetStreamManager: async () => {
      const nc = natsProvider?.getConnection();
      return nc ? await jetstreamManager(nc) : null;
    },
    messageParts: projectorThreadStorage.messageParts(),
    resolveRun: async (runId: string) => {
      const row = await database.db
        .selectFrom("threads")
        .select([
          "organization_id",
          "created_by",
          "message_storage_version",
          "status",
          "run_fence_token",
          "title",
        ])
        .where("id", "=", runId)
        .executeTakeFirst();
      return row
        ? {
            orgId: row.organization_id,
            createdBy: row.created_by,
            version: row.message_storage_version ?? 1,
            status: row.status,
            runFenceToken: row.run_fence_token,
            title: row.title ?? null,
          }
        : null;
    },
    completeRunIfNotCompleted: async (runId, orgId) => {
      const flipped = await projectorThreadStorage.completeRunIfNotCompleted(
        runId,
        orgId,
      );
      // Push the terminal status to the org SSE so the sidebar chip updates
      // live. user-desktop runs finalize here (not via the run-reactor), so
      // without this the chip stays "running" until a refetch. `flipped` is
      // null on a no-op (already terminal) → no double-publish.
      emitTerminalThreadStatus(sseHub, orgId, runId, flipped);
      if (flipped) {
        await advanceTasksToReviewOnThreadFinish(
          projectorTaskBoard,
          runId,
          orgId,
        );
        // Headless reviewer trigger: a Super Agent run just finished — enqueue
        // the enabled reviewers if it left a PR In Review, no UI required.
        void enqueueReviewersOnThreadFinish({
          contextFactory: automationContextFactory,
          taskBoard: projectorTaskBoard,
          threadId: runId,
          orgId,
        });
      }
      return flipped;
    },
    markRunRequiresAction: async (runId, orgId) => {
      const flipped = await projectorThreadStorage.requiresActionIfInProgress(
        runId,
        orgId,
      );
      emitTerminalThreadStatus(sseHub, orgId, runId, flipped);
      return flipped;
    },
    markRunFailed: async (runId, orgId, reason, kind) => {
      const flipped = await projectorThreadStorage.markRunFailed(
        runId,
        orgId,
        reason,
        kind,
      );
      emitTerminalThreadStatus(sseHub, orgId, runId, flipped);
      if (flipped) {
        await advanceTasksToReviewOnThreadFinish(
          projectorTaskBoard,
          runId,
          orgId,
        );
        // Headless reviewer trigger — see completeRunIfNotCompleted above. A
        // failed run rarely leaves a task In Review (the guard inside no-ops).
        void enqueueReviewersOnThreadFinish({
          contextFactory: automationContextFactory,
          taskBoard: projectorTaskBoard,
          threadId: runId,
          orgId,
        });
      }
      return flipped;
    },
    clearSynthesizedError: async (runId, fenceToken) => {
      // Replace-with-empty = delete the synthesized error message a prior
      // interrupted attempt persisted for this fence (deterministic id).
      await projectorThreadStorage
        .messageParts()
        .replaceMessageParts(
          runId,
          synthesizedErrorMessageId(runId, fenceToken),
          [],
        );
    },
    persistTitle: (runId, orgId, title) =>
      projectorThreadStorage.update(runId, orgId, { title }),
    onTitleUpdated: async ({ runId, orgId, title }) => {
      const row = await projectorThreadStorage
        .get(runId, orgId)
        .catch(() => null);
      sseHub.emit(
        orgId,
        createDecopilotThreadStatusEvent(runId, row?.status ?? "in_progress", {
          title,
          virtualMcpId: row?.virtual_mcp_id ?? undefined,
          createdBy: row?.created_by,
          triggerId: row?.trigger_id,
          branch: row?.branch ?? null,
          createdAt: row?.created_at,
          updatedAt: row?.updated_at,
        }),
      );
    },
    bumpProgress: async ({ runId, orgId }) => {
      await projectorThreadStorage.bumpProgress(runId, orgId);
    },
    recordCompleted: async ({ runId, orgId, distinctId, usage }) => {
      posthog.capture({
        distinctId,
        event: "chat_message_completed",
        groups: { organization: orgId },
        properties: {
          organization_id: orgId,
          thread_id: runId,
          transport: "projector",
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
      });
    },
    recordFailed: async ({ runId, orgId, distinctId, reason, kind }) => {
      posthog.capture({
        distinctId,
        event: "chat_message_failed",
        groups: { organization: orgId },
        properties: {
          organization_id: orgId,
          thread_id: runId,
          transport: "projector",
          error_category: kind,
          error_message: reason,
        },
      });
    },
    // Cleanup is owned by the workflow's success path now (after the run is
    // projected + completed). The fence token is part of the runtime contract
    // but unused here — the stream subject is keyed by runId only.
    purgeRun: async (runId) => {
      streamBuffer.purge(runId);
    },
  });

  // Background-tool jobs reuse the same studio-context factory to rebuild the
  // org context + re-resolve models on whatever pod runs the job. Wired before
  // DBOS.launch() like the others (module-level pointer, no DBOS API calls).
  setBackgroundToolRuntime({
    studioContextFactory: automationContextFactory,
    systemDatabaseUrl: withSslmode(
      getSettings().databaseUrl,
      getSettings().databasePgSsl,
    ),
    // A backgrounded subtask publishes its live run to `decopilot.stream.<jobId>`
    // through this buffer (off the thread's own stream).
    streamBuffer,
  });

  // Must run before DBOS.launch() (which fires in index.ts after createApp).
  registerMonitoringRetentionWorkflow();
  registerPublicSetsSyncWorkflow();
  registerBenefitsSyncWorkflows();

  const automationRunner: StudioContext["automationRunner"] = async (
    automationId,
    orgId,
    _userId,
  ) => {
    const automation = await automationsStorage.findById(automationId, orgId);
    if (!automation) throw new Error("Automation not found");
    return fireAutomationNow({
      automationId: automation.id,
      organizationId: automation.organization_id,
      triggerId: null,
    });
  };

  // ============================================================================
  // Automation Event Dispatcher — fires automations from trigger callbacks
  // ============================================================================

  const automationEventDispatcher = new AutomationEventDispatcher(
    automationsStorage,
    ({ automation, trigger, contextMessages, idempotencyKey }) =>
      enqueueAutomationFire(
        {
          automationId: automation.id,
          organizationId: automation.organization_id,
          triggerId: trigger.id,
          contextMessages,
        },
        { idempotencyKey },
      ),
  );

  // Orphan/crash recovery is owned by the external DBOS Conductor now: it
  // recovers a dead executor's PENDING workflows (incl. the thread-gate
  // workflows backing decopilot runs) onto a live executor. Studio no longer
  // runs its own boot sweep or pod-death recovery. The reaper (RunRegistry)
  // still force-fails runs with no progress as a zombie backstop.

  // NDJSON monitoring retention cleanup runs as a DBOS scheduled workflow
  // (see `initDbos` below). Kick off a single eager sweep at boot so a fresh
  // replica trims local files without waiting for the next schedule tick.
  const SIGNAL_DIRS = [getLogsDir(), getTracesDir(), getMetricsDir()];

  for (const dir of SIGNAL_DIRS) {
    cleanupOldMonitoringFiles(dir)
      .then(() => {})
      .catch((err) =>
        console.error("[monitoring] Retention cleanup failed:", err),
      );
  }

  // Expired API key cleanup (e.g. short-lived claude-code-session keys)
  const cleanupExpiredApiKeys = () =>
    database.db
      .deleteFrom("apikey" as any)
      .where("expiresAt" as any, "<", new Date())
      .execute()
      .then(() => {})
      .catch((err: unknown) =>
        console.error("[auth] Expired API key cleanup failed:", err),
      );

  cleanupExpiredApiKeys();
  setInterval(cleanupExpiredApiKeys, 24 * 60 * 60 * 1000).unref();

  // Inject StudioContext into requests
  // Skip auth routes, static files, health check, and metrics - they don't need StudioContext
  app.use("*", async (c, next) => {
    if (shouldSkipStudioContext(c.req.path)) {
      return next();
    }

    const timings = {
      measure: async <T>(name: string, cb: () => Promise<T>) => {
        startTime(c, name);
        try {
          return await cb();
        } finally {
          endTime(c, name);
        }
      },
    };

    const studioCtx = await ContextFactory.create(c.req.raw, { timings });
    studioCtx.automationRunner = automationRunner;
    c.set("studioContext", studioCtx);

    try {
      await next();
    } finally {
      // Fire-and-forget: await pending SWR revalidations with a timeout.
      // Keeps ctx (and its client pool) alive via closure while revalidations complete.
      // No pool disposal — pool was never disposed and SSE/streaming connections depend on it.
      const revalidations = studioCtx.pendingRevalidations;
      if (revalidations.length > 0) {
        const REVALIDATION_TIMEOUT_MS = 30_000;
        void Promise.race([
          Promise.allSettled(revalidations),
          sleep(REVALIDATION_TIMEOUT_MS),
        ]).catch((err) =>
          console.error("[studio] revalidation cleanup error:", err),
        );
      }
    }
  });

  // Apply path-based org resolution to the pre-existing org-scoped routes
  // that aren't under createOrgScopedApi: decopilot, OpenAI compat, files.
  // These use ensureOrganization() to read ctx.organization, which would
  // otherwise be undefined now that the frontend no longer sends x-org-id
  // headers. We can't apply this globally to /api/:org/* because legacy
  // unscoped routes like /api/connections/:id/... also match that pattern
  // (where :org matches "connections" etc).
  app.use("/api/:org/decopilot/*", resolveOrgFromPath);
  app.use("/api/:org/v1/*", resolveOrgFromPath);
  app.use("/api/:org/files/*", resolveOrgFromPath);

  // ============================================================================
  // Server-side SSO Enforcement Middleware
  // ============================================================================
  // When an org has SSO enforcement enabled, block API requests from users
  // who haven't completed the SSO flow. Exempt paths: SSO routes themselves,
  // auth routes, and non-org-scoped endpoints.
  app.use("*", async (c, next) => {
    if (isSsoExemptPath(c.req.path)) {
      return next();
    }

    const ctx = c.get("studioContext") as StudioContext | undefined;
    if (!ctx?.organization?.id || !ctx?.auth?.user?.id) {
      return next();
    }

    const ssoConfig = await ctx.storage.orgSsoConfig.getByOrgId(
      ctx.organization.id,
    );
    if (!ssoConfig?.enforced) {
      return next();
    }

    const hasValidSession = await ctx.storage.orgSsoSessions.isValid(
      ctx.auth.user.id,
      ctx.organization.id,
    );
    if (!hasValidSession) {
      return c.json(
        { error: "SSO authentication required for this organization" },
        403,
      );
    }

    return next();
  });

  // Organization-level SSO routes (must be after context middleware).
  // Legacy mount at /api/org-sso with deprecation log; the new
  // /api/:org/org-sso mount is wired in a later task.
  const legacyOrgSso = new Hono<{
    Variables: { studioContext: StudioContext };
  }>();
  legacyOrgSso.use(
    "*",
    createLogDeprecatedRoute({ mountPath: "/api/org-sso" }),
  );
  legacyOrgSso.route("/", createSsoRoutes());
  app.route("/api/org-sso", legacyOrgSso);

  // Get all management tools (for OAuth consent UI)
  app.get("/api/tools/management", (c) => {
    return c.json({
      tools: MANAGEMENT_TOOLS,
      grouped: getToolsByCategory(),
    });
  });

  // ============================================================================
  // API Routes
  // ============================================================================

  // Measure MCP route group latency (wrap entire MCP request handling)
  app.use("/mcp/*", async (c, next) => {
    startTime(c, "mcp");
    try {
      return await next();
    } finally {
      endTime(c, "mcp");
    }
  });

  const mcpAuth: MiddlewareHandler<Env> = async (c, next) => {
    const studioContext = c.var.studioContext;
    // Require either user or API key authentication
    if (!studioContext.auth.user?.id && !studioContext.auth.apiKey?.id) {
      const url = new URL(c.req.url);
      // Behind a TLS-terminating reverse proxy (e.g. Caddy/nginx) the request
      // reaches us over http, so `url.origin` would advertise an http://
      // resource_metadata URL and OAuth-capable clients that require https
      // (e.g. Claude) reject it. Honor X-Forwarded-Proto so the advertised
      // URL matches the public scheme.
      const fwdProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
      const origin = fwdProto ? `${fwdProto}://${url.host}` : url.origin;
      return (c.res = new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer realm="mcp",resource_metadata="${origin}${url.pathname}/.well-known/oauth-protected-resource"`,
        },
      }));
    }
    return await next();
  };
  app.use("/mcp/:connectionId?", mcpAuth);
  app.use("/mcp/gateway/:virtualMcpId?", mcpAuth);
  app.use("/mcp/virtual-mcp/:virtualMcpId?", mcpAuth);
  app.use("/mcp/self", mcpAuth);

  // Local file storage MCP routes — mounted whenever DevObjectStorage is the
  // active object-storage backend (i.e. no S3 configured). Required so the
  // dev-assets pseudo-connection can satisfy the OBJECT_STORAGE binding.
  if (usesLocalObjectStorage()) {
    // Using require() for synchronous loading to ensure routes are registered
    // before any requests come in. Static imports in dev-only.ts allow knip tracking.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mountDevRoutes } = require("./routes/dev-only");
    mountDevRoutes(app, mcpAuth);
  }

  // Virtual MCP / Agent routes (must be before proxy to match /mcp/gateway and /mcp/virtual-mcp before /mcp/:connectionId)
  // /mcp/gateway/:virtualMcpId (backward compat) or /mcp/virtual-mcp/:virtualMcpId
  const legacyVirtualMcp = new Hono<Env>();
  legacyVirtualMcp.use("*", createLogDeprecatedRoute({ mountPath: "/mcp" }));
  legacyVirtualMcp.route("/", createVirtualMcpRoutes());
  app.route("/mcp", legacyVirtualMcp);

  // Self MCP routes (at /mcp/self) - exposes all management tools
  const legacySelf = new Hono<Env>();
  legacySelf.use("*", createLogDeprecatedRoute({ mountPath: "/mcp/self" }));
  legacySelf.route("/", createSelfRoutes());
  app.route("/mcp/self", legacySelf);

  // MCP Proxy routes (connection-specific)
  // Note: SELF MCP ({org}_self) is handled by proxy.ts with special case detection
  const legacyProxy = new Hono<Env>();
  legacyProxy.use("*", createLogDeprecatedRoute({ mountPath: "/mcp" }));
  legacyProxy.route("/", createProxyRoutes());
  app.route("/mcp", legacyProxy);

  // Measure LLM models route latency
  app.use("/api/:org/models/*", async (c, next) => {
    startTime(c, "llm_models");
    try {
      return await next();
    } finally {
      endTime(c, "llm_models");
    }
  });

  const decopilotRoutes = createDecopilotRoutes({
    cancelBroadcast,
    streamBuffer,
    runRegistry,
  });
  app.route("/api", decopilotRoutes);

  // Stable file redirect endpoint (resolves studio-storage: URIs to presigned URLs).
  // Resolve the org from the URL before serving so the stable URL cannot drift
  // to the session-active org when the path targets a different org.
  app.use("/api/:org/files/*", resolveOrgFromPath);
  app.route("/api", filesRoutes);

  // Thread outputs (model-shared files surfaced as download chips in the chat)
  // Legacy mount at /api/* with deprecation log; the new /api/:org/* mount
  // is wired in a later task.
  const legacyThreadOutputsRoutes = new Hono<{
    Variables: { studioContext: StudioContext };
  }>();
  legacyThreadOutputsRoutes.use(
    "*",
    createLogDeprecatedRoute({ mountPath: "/api" }),
  );
  legacyThreadOutputsRoutes.route("/", createThreadOutputsRoutes());
  app.route("/api", legacyThreadOutputsRoutes);

  // OpenAI-compatible LLM API routes
  app.route("/api", openaiCompatRoutes);

  // Trigger callback endpoint (external MCPs → Studio automations).
  // Legacy mount at /api/trigger-callback with deprecation log; the new
  // /api/:org/trigger-callback mount is wired in a later task.
  const legacyTriggerCallback = new Hono<{
    Variables: { studioContext: StudioContext };
  }>();
  legacyTriggerCallback.use(
    "*",
    createLogDeprecatedRoute({ mountPath: "/api" }),
  );
  legacyTriggerCallback.route(
    "/",
    createTriggerCallbackRoutes({
      tokenStorage: triggerCallbackTokenStorage,
      automationEventDispatcher,
    }),
  );
  app.route("/api", legacyTriggerCallback);

  // KV store — org-scoped only. The legacy unscoped mount at /api/kv/:key was
  // removed because it lacked resolveOrgFromPath middleware, allowing multi-org
  // users to read/write KV data from an unintended org (non-deterministic org
  // resolution via .executeTakeFirst() without ORDER BY). All callers must use
  // the org-scoped route: /api/:org/kv/:key.
  const kvStorage = new KyselyKVStorage(database.db);

  // Downstream token management routes
  // Legacy mount at /api/* with deprecation log; the new /api/:org/* mount
  // is wired in a later task.
  const legacyDownstreamTokenRoutes = new Hono<{
    Variables: { studioContext: StudioContext };
  }>();
  legacyDownstreamTokenRoutes.use(
    "*",
    createLogDeprecatedRoute({ mountPath: "/api" }),
  );
  legacyDownstreamTokenRoutes.route("/", createDownstreamTokenRoutes());
  app.route("/api", legacyDownstreamTokenRoutes);

  // Deco.cx sites list (requires studioContext / auth)
  // /profile is user-scoped (no org), stays mounted permanently — no
  // deprecation log.
  app.route("/api/deco-sites", createDecoSitesUserRoutes());
  app.route("/api/deco-apps", createDecoAppsRoutes());

  // Org-scoped deco-sites routes (GET /, POST /connection). Currently mounted
  // at /api/deco-sites with a deprecation log; the new /api/:org/deco-sites
  // mount is wired in a later task.
  const legacyDecoSitesOrg = new Hono<{
    Variables: { studioContext: StudioContext };
  }>();
  legacyDecoSitesOrg.use(
    "*",
    createLogDeprecatedRoute({ mountPath: "/api/deco-sites" }),
  );
  legacyDecoSitesOrg.route("/", createDecoSitesOrgRoutes());
  app.route("/api/deco-sites", legacyDecoSitesOrg);

  // ============================================================================
  // Private Registry public routes (first-class feature)
  // Registered BEFORE the org-scoped sub-app so the more specific
  // `/api/:org/registry/*` mounts win over the catch-all org sub-app.
  // These are PUBLIC endpoints — they do their own org lookup and must NOT
  // go through `resolveOrgFromPath` (which would enforce membership).
  // ============================================================================

  const { createPublishRequestHandler, createPublicMCPHandler } = await import(
    "@/api/routes/registry"
  );
  const registryRouteCtx = {
    db: database.db as any,
    vault: {
      encrypt: (value: string) => vault.encrypt(value),
      decrypt: (value: string) => vault.decrypt(value),
    },
  };
  const publishRequestHandler = createPublishRequestHandler(registryRouteCtx);
  const publicMCPHandler = createPublicMCPHandler(registryRouteCtx);

  // Legacy mounts (with deprecation log)
  app.use("/org/:orgRef/registry/publish-request", logDeprecatedRoute);
  app.post("/org/:orgRef/registry/publish-request", publishRequestHandler);
  app.use("/org/:orgSlug/registry/*", logDeprecatedRoute);
  app.all("/org/:orgSlug/registry/*", publicMCPHandler);

  // New canonical mounts (no deprecation log; mounted at the top level so they
  // resolve their own org and bypass `resolveOrgFromPath`).
  app.post("/api/:org/registry/publish-request", publishRequestHandler);
  app.all("/api/:org/registry/*", publicMCPHandler);

  // Deployment admin dashboard. Static segment — must register before the
  // `:org` catch-all below, same trick as the registry mounts above. That
  // registration order is the real no-collision guarantee: ORGANIZATION_CREATE
  // rejects slugs outside `^[a-z0-9-]+$`, but the raw better-auth
  // organization/create endpoint enforces no charset, so an `_admin`-slugged
  // org CAN exist — mounting first means such an org gets shadowed, never the
  // admin surface. The `_` prefix just keeps well-behaved slugs from ever
  // wanting the name (a bare `admin` is a legal, live slug).
  app.route(ADMIN_API_PREFIX, createAdminRoutes());

  // New canonical org-scoped API surface — all routes that depend on org context
  // live here. Old routes still work (with deprecation logs) until the cleanup
  // PR removes them after the deprecation window.
  const orgScopedApi = createOrgScopedApi({
    kvStorage,
    runRegistry,
    streamBuffer,
    sseHub,
    cancelBroadcast,
    tokenStorage: triggerCallbackTokenStorage,
    automationEventDispatcher,
    mountDevAssets: usesLocalObjectStorage(),
    mcpAuth,
    oauthProxyHandler,
    watchHandler,
    betterAuthProtectedResourceHandler,
    getNatsConnection: () => natsProvider?.getConnection() ?? null,
  });
  app.route("/api/:org", orgScopedApi);

  // ============================================================================
  // 404 Handler
  // ============================================================================

  app.notFound((c) => {
    return c.json({ error: "Not Found", path: c.req.path }, 404);
  });

  // ============================================================================
  // Error Handler
  // ============================================================================

  app.onError(handleApiError);

  const markShuttingDown = () => {
    isShuttingDown = true;
  };

  const shutdown = async () => {
    console.log("[shutdown] Stopping workers...");

    // Phase 1: Stop all workers/consumers in parallel (independent of each other)
    await Promise.allSettled([
      sseHub.stop(),
      currentDecopilotCleanup
        ? Promise.resolve(currentDecopilotCleanup()).finally(() => {
            currentDecopilotCleanup = null;
          })
        : Promise.resolve(),
    ]);

    // Phase 3: Drain NATS (after all consumers stopped)
    if (natsProvider) {
      await natsProvider
        .drain()
        .catch((err: unknown) =>
          console.error("[shutdown] NATS drain error:", err),
        );
    }

    // Phase 4: Flush telemetry
    console.log("[shutdown] Flushing telemetry...");
    await flushMonitoringData().catch((err: unknown) =>
      console.error("[shutdown] Telemetry flush error:", err),
    );

    // Phase 5: Close database (last — other steps may need DB)
    console.log("[shutdown] Closing database...");
    await closeDatabase(database).catch((err: unknown) =>
      console.error("[shutdown] Database close error:", err),
    );

    console.log("[shutdown] Cleanup complete.");
  };

  /**
   * Post-launch DBOS setup. Must run AFTER `DBOS.launch()` because
   * `registerQueue` and `listSchedules` both `ensureDBOSIsLaunched()`.
   * Idempotent: re-registering the queues on a redeploy is a no-op when the
   * persisted row already matches; the reconciler only creates/deletes diffs.
   *
   * The two static schedules (`monitoring-ndjson-retention`, `automations-gc`)
   * are registered statically at module load via `DBOS.registerScheduled`
   * — they don't need any setup here.
   */
  const initDbos = async () => {
    // Automation fires run on ONE partitioned queue, partitioned by orgId.
    // Per-partition concurrency gives each org its own fairness cap (a
    // saturated org blocks only its own partition), while a single queue
    // means one dequeue-polling loop per replica instead of one per org —
    // and DBOS only polls partitions with ENQUEUED work, so idle poll cost
    // is flat regardless of org count.
    await DBOS.registerQueue(AUTOMATIONS_QUEUE, {
      partitionQueue: true,
      concurrency: AUTOMATIONS_PARTITION_CONCURRENCY,
      minPollingIntervalMs: AUTOMATIONS_POLL_INTERVAL_MS,
    });
    // Per-thread agent-run gate. Partition key = threadId, concurrency=1,
    // so messages on the same thread serialize behind the active run while
    // different threads progress in parallel. Used by user-message POSTs
    // (Phase 3) and automation fires (Phase 5).
    await DBOS.registerQueue(THREAD_GATE_QUEUE, {
      partitionQueue: true,
      concurrency: THREAD_GATE_PARTITION_CONCURRENCY,
    });
    // Hosted-harness child workflow queue. Partition key = threadId, concurrency 1
    // (mirrors THREAD_GATE_QUEUE: one active run per thread, different threads
    // progress in parallel). Worker pods dequeue this alongside the parent gate.
    await DBOS.registerQueue(HOSTED_HARNESS_QUEUE, {
      partitionQueue: true,
      concurrency: HOSTED_HARNESS_PARTITION_CONCURRENCY,
    });
    // Slow backgroundable built-ins (generate_image) run here, partitioned by
    // orgId for per-org fairness. The reaction turn hops to the thread-gate.
    await DBOS.registerQueue(BACKGROUND_TOOLS_QUEUE, {
      partitionQueue: true,
      concurrency: BACKGROUND_TOOLS_PARTITION_CONCURRENCY,
    });
    await reconcileAutomationSchedules(automationsStorage);

    // One-time cleanup of the retired per-automation/global gate queues.
    // Fires now run on the partitioned queue, so these rows are orphaned;
    // deleteQueue is a no-op once they're gone. Stale gate workflows still
    // ENQUEUED from a previous version are cancelled by the reconciler.
    await Promise.allSettled(
      ["automations-gate", "automations-global"].map((q) =>
        DBOS.deleteQueue(q),
      ),
    );
    // MIGRATION: drop the retired per-org `automations-org-<orgId>` queue rows
    // (empty ones only) so DBOS stops launching a dequeue loop for each. Runs
    // every boot; idempotent. Remove once prod shows zero such rows.
    await cleanupOrphanedOrgQueues(database.pool);

    // Fire-and-forget backfill of studio pack agents for every org. Safe
    // to skip awaiting — the workflow IDs are deterministic per-org, so
    // replicas/workers all enqueueing in parallel collapse via OAOO.
    backfillStudioPackForAllOrgs().catch((err) => {
      console.error("[studio-pack-backfill] failed:", err);
    });

    // Fire-and-forget immediate public-sets sync (hour-bucketed workflow ID,
    // so parallel-booting replicas collapse via OAOO).
    kickPublicSetsBootSync().catch((err) => {
      console.error("[org-fs] public-sets boot sync kick failed:", err);
    });
  };

  return Object.assign(app, { markShuttingDown, shutdown, initDbos });
}
