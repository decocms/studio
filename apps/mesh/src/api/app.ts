/**
 * MCP Mesh API Server
 *
 * Main Hono application with:
 * - Better Auth integration
 * - Context injection middleware
 * - Error handling
 * - CORS support
 */

import { getSettings } from "../settings";
import { usesLocalObjectStorage } from "../tools/connection/dev-assets";
import { DECO_STORE_URL, isDecoHostedMcp } from "@/core/deco-constants";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { endTime, startTime, timing } from "hono/timing";
import { auth } from "../auth";
import { createMemberRoleCache } from "../auth/member-role-cache";
import {
  ContextFactory,
  createMeshContextFactory,
} from "../core/context-factory";
import type { MeshContext } from "../core/mesh-context";
import { closeDatabase, getDb, type MeshDatabase } from "../database";
import { asDockerRunner, getSharedRunnerIfInit } from "../sandbox/lifecycle";
import { createEventBus, type EventBus } from "../event-bus";
import {
  flushMonitoringData,
  meter,
  prometheusExporter,
  tracer,
  tracingMiddleware,
} from "../observability";
import authRoutes from "./routes/auth";
import { createSsoRoutes } from "./routes/org-sso";
import { createDecopilotRoutes } from "./routes/decopilot";
import { createDownstreamTokenRoutes } from "./routes/downstream-token";
import { logDeprecatedRoute } from "./middleware/log-deprecated-route";
import { resolveOrgFromPath } from "./middleware/resolve-org-from-path";
import { createOrgScopedApi } from "./routes/org-scoped";
import { createVmEventsRoutes } from "./routes/vm-events";
import {
  createDecoSitesOrgRoutes,
  createDecoSitesUserRoutes,
} from "./routes/deco-sites";
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
import { createKVRoutes } from "./routes/kv";
import { createTriggerCallbackRoutes } from "./routes/trigger-callback";
import publicConfigRoutes from "./routes/public-config";
import filesRoutes from "./routes/files";
import { createThreadOutputsRoutes } from "./routes/thread-outputs";
import { createSelfRoutes } from "./routes/self";
import { shouldSkipMeshContext, SYSTEM_PATHS } from "./utils/paths";
import {
  mountPluginRoutes,
  initializePluginStorage,
  runPluginStartupHooks,
} from "../core/plugin-loader";
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
import {
  JetStreamKVModelListCache,
  type ModelListCache,
} from "../ai-providers/model-list-cache";
import { NatsCancelBroadcast } from "./routes/decopilot/nats-cancel-broadcast";
import type { StreamBuffer } from "./routes/decopilot/stream-buffer";
import { NatsStreamBuffer } from "./routes/decopilot/nats-stream-buffer";
import { RunRegistry } from "./routes/decopilot/run-registry";
import type { RunReactorDeps } from "./routes/decopilot/run-reactor";
import { SqlThreadStorage } from "../storage/threads";
import type { Thread } from "../storage/types";
import { cleanupOldMonitoringFiles } from "../monitoring/ndjson-retention";
import { getLogsDir, getTracesDir, getMetricsDir } from "../monitoring/schema";
import {
  AutomationCronWorker,
  automationJobStream,
  EventTriggerEngine,
  Semaphore,
} from "../automations";
import { fireAutomation } from "../automations/fire";
import { streamCore, consumeStreamCore } from "./routes/decopilot/stream-core";
import {
  PersistedRunConfigSchema,
  toModelsConfig,
} from "./routes/decopilot/run-config";
import { getPodId } from "../core/pod-identity";
import { NatsPodHeartbeat } from "../nats/pod-heartbeat";
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

// Track current event bus instance for cleanup during HMR
let currentEventBus: EventBus | null = null;

// Track automation cron worker for cleanup during HMR
let currentCronWorkerCleanup: (() => void) | null = null;

// Track decopilot strategy cleanup (abort active runs, stop strategies) during HMR
let currentDecopilotCleanup: (() => void | Promise<void>) | null = null;

// Track monitoring retention timer for cleanup during HMR
let currentRetentionTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Deco Store OAuth Helpers
// ============================================================================

/**
 * Get project_locator from the Deco Store registry connection.
 * Returns the locator string or null if not found/configured.
 *
 * @param ctx - The mesh context
 * @param organizationId - The organization ID to search for the registry connection
 */
async function getDecoStoreProjectLocator(
  ctx: MeshContext,
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
  let ctx = c.get("meshContext");
  if (!ctx) {
    ctx = await ContextFactory.create(c.req.raw);
    c.set("meshContext", ctx);
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
      targetUrl.searchParams.set("resource", connection.connection_url);
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
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (
      endpoint === "token" &&
      contentType?.includes("application/x-www-form-urlencoded")
    ) {
      // Parse form body and rewrite resource if present
      const formData = await c.req.formData();
      if (formData.has("resource")) {
        formData.set("resource", connection.connection_url);
      }
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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

/**
 * Publish a public event for an org.
 * Resolves the org from `ctx.organization.id` (set by `resolveOrgFromPath`
 * on the `/api/:org/...` mount) or, when missing, from the legacy
 * `:organizationId` path param.
 */
const eventsHandler: MiddlewareHandler<Env> = async (c) => {
  const ctx = c.var.meshContext;
  const orgId = ctx.organization?.id ?? c.req.param("organizationId");
  if (!orgId) {
    return c.json({ error: "organization id missing" }, 400);
  }
  await ctx.eventBus.publish(orgId, WellKnownOrgMCPId.SELF(orgId), {
    data: await c.req.json(),
    type: `public:${c.req.param("type")}`,
    subject: c.req.query("subject"),
    deliverAt: c.req.query("deliverAt"),
    cron: c.req.query("cron"),
  });
  return c.json({ success: true });
};

/**
 * SSE watch endpoint — streams events for an organization in real time.
 * Resolves the org from `ctx.organization.id` (set by `resolveOrgFromPath`
 * on the `/api/:org/watch` mount) or from the legacy `:organizationId`
 * path param. Auth is required either way.
 */
const watchHandler: MiddlewareHandler<Env> = async (c) => {
  const meshContext = c.var.meshContext;

  // Require authentication (user session or API key)
  const userId = meshContext.auth.user?.id ?? meshContext.auth.apiKey?.userId;
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Prefer org resolved from path (new mount); fall back to legacy param.
  const orgId =
    meshContext.organization?.id ?? c.req.param("organizationId") ?? null;
  if (!orgId) {
    return c.json({ error: "organization id missing" }, 400);
  }

  // On the legacy path the middleware doesn't enforce membership; check that
  // the authenticated user has access to the requested organization. (On the
  // new path `resolveOrgFromPath` already enforced this and `orgId` came from
  // `ctx.organization.id`, so the comparison is trivially true.)
  if (orgId !== meshContext.organization?.id) {
    return c.json({ error: "Forbidden access to organization" }, 403);
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
} from "../tools/registry-metadata";
import { Env } from "./hono-env";
import { devLogger } from "./utils/dev-logger";
import { streamSSE } from "hono/streaming";
import { type SSEEvent, sseHub } from "../event-bus";
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
  database?: MeshDatabase;
  /** Custom event bus instance (for testing) */
  eventBus?: EventBus;
}

/**
 * Create a configured Hono app instance
 * Allows injecting a custom database for testing
 */
export async function createApp(options: CreateAppOptions = {}) {
  const database = options.database ?? getDb();
  let isShuttingDown = false;

  // Clear previous monitoring retention timer (cleanup during HMR)
  if (currentRetentionTimer) {
    clearInterval(currentRetentionTimer);
    currentRetentionTimer = null;
  }

  // Stop any existing event bus worker and SSE hub (cleanup during HMR)
  if (currentEventBus && currentEventBus.isRunning()) {
    // Fire and forget - don't block app creation
    // The stop is mostly synchronous, async part is just UNLISTEN cleanup
    Promise.resolve(currentEventBus.stop()).catch((error) => {
      console.error("[EventBus] Error stopping previous worker:", error);
    });
    sseHub.stop().catch((error) => {
      console.error(
        "[SSEHub] Error stopping previous broadcast (HMR cleanup):",
        error,
      );
    });
  }

  let eventBus: EventBus;
  let mcpListCache: McpListCache;
  let modelListCache: ModelListCache;
  let cancelBroadcast: CancelBroadcast;
  let streamBuffer: StreamBuffer;
  let natsProvider: NatsConnectionProvider | null = null;

  if (options.eventBus) {
    // Test mode: use provided event bus and no-op stubs (no NATS required)
    eventBus = options.eventBus;
    mcpListCache = {
      get: async () => null,
      set: async () => {},
      invalidate: async () => {},
      teardown: () => {},
    };
    modelListCache = {
      get: async () => null,
      set: async () => {},
      invalidate: async () => {},
      teardown: () => {},
    };
    cancelBroadcast = {
      start: async () => {},
      broadcast: () => {},
      stop: async () => {},
    };
    streamBuffer = {
      init: async () => {},
      relay: (stream: ReadableStream) => stream,
      createReplayStream: async () => null,
      purge: () => {},
      teardown: () => {},
    };
  } else {
    // Production/dev mode: connect to NATS (required)
    natsProvider = createNatsConnectionProvider();
    natsProvider.init(getSettings().natsUrls);

    const tlc = new JetStreamKVMcpListCache({
      getJetStream: () => natsProvider!.getJetStream(),
    });
    tlc.init().catch(() => {});
    mcpListCache = tlc;

    const mlc = new JetStreamKVModelListCache({
      getJetStream: () => natsProvider!.getJetStream(),
    });
    mlc.init().catch(() => {});
    modelListCache = mlc;

    cancelBroadcast = new NatsCancelBroadcast({
      getConnection: () => natsProvider!.getConnection(),
    });

    streamBuffer = new NatsStreamBuffer({
      getConnection: () => natsProvider!.getConnection(),
      getJetStream: () => natsProvider!.getJetStream(),
    });

    eventBus = createEventBus(database, natsProvider);

    // When NATS connects, (re-)initialize all deferred consumers
    natsProvider.onReady(() => {
      tlc.init().catch((err: unknown) => {
        console.error("[McpListCache] Deferred init failed:", err);
      });
      mlc.init().catch((err: unknown) => {
        console.error("[ModelListCache] Deferred init failed:", err);
      });
      streamBuffer.init().catch((err: unknown) => {
        console.warn(
          "[StreamBuffer] Deferred init failed, late-join disabled:",
          err,
        );
      });
    });
  }

  // Track for cleanup during HMR
  currentEventBus = eventBus;

  // Decopilot strategy cleanup on HMR / shutdown
  if (currentDecopilotCleanup) await currentDecopilotCleanup();

  // Set tool list cache after cleanup to avoid previous cleanup nulling the new cache
  setMcpListCache(mcpListCache);

  const threadStorage = new SqlThreadStorage(database.db);

  const cancelReactorDeps: RunReactorDeps = {
    storage: threadStorage,
    streamBuffer,
    sseHub,
  };

  const POD_ID = getPodId();
  const runRegistry = new RunRegistry(cancelReactorDeps, POD_ID);

  cancelBroadcast
    .start((taskId) => {
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
  streamBuffer.init().catch((err) => {
    console.warn(
      "[Decopilot] StreamBuffer init failed, attach/late-join disabled:",
      err,
    );
  });

  // Per-pod heartbeat via NATS KV (only when NATS is available)
  let podHeartbeat: NatsPodHeartbeat | null = null;
  if (natsProvider) {
    podHeartbeat = new NatsPodHeartbeat({
      getConnection: () => natsProvider!.getConnection(),
      getJetStream: () => natsProvider!.getJetStream(),
    });

    // Attempt immediate init (may no-op if NATS not ready)
    podHeartbeat
      .init()
      .then(() => {
        podHeartbeat!.start(POD_ID);
      })
      .catch(() => {});

    // Re-init when NATS connects
    natsProvider.onReady(() => {
      podHeartbeat!
        .init()
        .then(() => {
          podHeartbeat!.start(POD_ID);
        })
        .catch((err: unknown) => {
          console.error("[PodHeartbeat] Deferred init failed:", err);
        });
    });
  }

  currentDecopilotCleanup = async () => {
    // Delete KV key first → watcher fires on other pods → immediate handoff
    await podHeartbeat?.stop();
    await runRegistry.stopAll();
    runRegistry.dispose();
    cancelBroadcast.stop().catch(() => {});
    streamBuffer.teardown();
    mcpListCache.teardown();
    modelListCache.teardown();
    setMcpListCache(null);
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
      origin: (origin) => {
        // Allow localhost and configured origins
        if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
          return origin;
        }
        // TODO: Configure allowed origins from environment
        return origin;
      },
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "mcp-protocol-version"],
      // Expose WWW-Authenticate so OAuth discovery works from cross-origin clients
      exposeHeaders: ["WWW-Authenticate"],
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  });

  if (!getSettings().noTui) {
    app.use("*", devLogger());
  }

  // Log response body for 5xx errors
  app.use("*", async (c, next) => {
    await next();
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

  // ============================================================================
  // Public Configuration (no auth required)
  // ============================================================================
  app.route("/api/config", publicConfigRoutes);

  // ============================================================================
  // Better Auth Routes
  // ============================================================================

  // Auth routes (API key management via web UI)
  app.route("/api/auth/custom", authRoutes);

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
  legacyWellKnownProtectedResource.use("*", logDeprecatedRoute);
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
  // MeshContext Injection Middleware
  // ============================================================================

  // Create context factory with the provided database and event bus
  // Context factory only needs the Kysely instance, not the full MeshDatabase
  const memberRoleCache = createMemberRoleCache({ ttlMs: 2 * 60 * 1000 });
  const factory = await createMeshContextFactory({
    db: database.db,
    auth,
    encryption: {
      key: getSettings().encryptionKey,
    },
    observability: {
      tracer,
      meter,
    },
    eventBus,
    modelListCache,
    memberRoleCache,
  });
  ContextFactory.set(factory);

  // Initialize plugin storage BEFORE starting the event bus, because the
  // startup hooks (runPluginStartupHooks) need storage to be ready and they
  // run as soon as eventBus.start() resolves — which can happen during any
  // `await` between here and where initializePluginStorage used to live.
  const vault = new CredentialVault(getSettings().encryptionKey);
  initializePluginStorage(database.db, vault);

  // Start the event bus worker (async - resets stuck deliveries from previous crashes)
  // Then run plugin startup hooks (e.g., recover stuck workflow executions)
  // Random jitter (0-2s) prevents all pods from hitting the DB simultaneously
  // after a deployment causes simultaneous restarts.
  const startupJitterMs = Math.random() * 2000;
  new Promise((r) => setTimeout(r, startupJitterMs))
    .then(() => eventBus.start())
    .then(() => {
      // db is typed as `any` to avoid Kysely version mismatch issues between packages
      return runPluginStartupHooks({
        db: database.db as any,
        publish: async (organizationId, event) => {
          await eventBus.publish(organizationId, "", event);
        },
      });
    })
    .catch((error) => {
      console.error("[EventBus] Error during startup:", error);
    });

  // ============================================================================
  // Automation Cron Worker
  // ============================================================================

  // Cleanup previous cron worker (HMR)
  if (currentCronWorkerCleanup) {
    currentCronWorkerCleanup();
    currentCronWorkerCleanup = null;
  }

  const automationsStorage = createAutomationsStorage(database.db);
  const triggerCallbackTokenStorage = new KyselyTriggerCallbackTokenStorage(
    database.db,
  );
  const automationSemaphore = new Semaphore(10); // max 10 concurrent runs globally

  const automationContextFactory = createAutomationContextFactory({
    db: database.db,
    threadStorage,
  });

  const automationRunner: MeshContext["automationRunner"] = async (
    automationId,
    orgId,
    _userId,
  ) => {
    const automation = await automationsStorage.findById(automationId, orgId);
    if (!automation) throw new Error("Automation not found");
    return fireAutomation({
      automation,
      triggerId: null,
      storage: automationsStorage,
      streamCoreFn: streamCore,
      meshContextFactory: automationContextFactory,
      config: { maxConcurrentPerAutomation: 3, runTimeoutMs: 5 * 60 * 1000 },
      globalSemaphore: automationSemaphore,
      deps: { runRegistry, cancelBroadcast },
    });
  };

  // JetStream job stream for distributing automation fire commands
  let cronTimer: ReturnType<typeof setInterval> | null = null;

  if (natsProvider) {
    const natsOpts = {
      getConnection: () => natsProvider!.getConnection(),
      getJetStream: () => natsProvider!.getJetStream(),
    };

    const cronWorker = new AutomationCronWorker(
      automationsStorage,
      automationJobStream.publish,
    );

    const cronPollIntervalMs = 10_000;

    const startJobStream = async () => {
      const t0 = Date.now();
      await automationJobStream.init(natsOpts);
      console.log(
        `[AutomationJobStream] init completed in ${Date.now() - t0}ms`,
      );
      await automationJobStream.startConsumer(async (payload) => {
        const automation = await automationsStorage.findById(
          payload.automationId,
          payload.organizationId,
        );
        if (!automation) return;
        await fireAutomation({
          automation,
          triggerId: payload.triggerId,
          storage: automationsStorage,
          streamCoreFn: streamCore,
          meshContextFactory: automationContextFactory,
          config: {
            maxConcurrentPerAutomation: 3,
            runTimeoutMs: 5 * 60 * 1000,
          },
          globalSemaphore: automationSemaphore,
          deps: { runRegistry, cancelBroadcast },
        });
      });
      const t1 = Date.now();
      await cronWorker.start();
      console.log(
        `[AutomationJobStream] cronWorker.start() completed in ${Date.now() - t1}ms`,
      );
    };

    const startJobStreamWithRetry = async (maxRetries = 5) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await startJobStream();
          return;
        } catch (err) {
          if (attempt === maxRetries) throw err;
          const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
          console.warn(
            `[AutomationJobStream] Start attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };

    // Attempt immediate start
    startJobStreamWithRetry().catch((err) => {
      console.error("[AutomationJobStream] Immediate start failed:", err);
    });

    // Re-start when NATS connects
    natsProvider.onReady(() => {
      startJobStreamWithRetry().catch((err: unknown) => {
        console.error("[AutomationJobStream] Deferred start failed:", err);
      });
    });
    cronTimer = setInterval(() => {
      cronWorker.processNow().catch((err) => {
        console.error("[AutomationCron] Error processing:", err);
      });
    }, cronPollIntervalMs);

    // Periodic health check: detect dead consumer and reinitialize
    const healthCheckIntervalMs = 60_000;
    let reinitializing = false;
    const healthCheckTimer = setInterval(async () => {
      if (reinitializing) return;
      try {
        const healthy = await automationJobStream.isHealthy(natsOpts);
        if (healthy) return;

        reinitializing = true;
        console.warn(
          "[AutomationJobStream] Health check failed, reinitializing...",
        );
        await startJobStreamWithRetry();
      } catch (err) {
        console.error("[AutomationJobStream] Health re-init failed:", err);
      } finally {
        reinitializing = false;
      }
    }, healthCheckIntervalMs);

    currentCronWorkerCleanup = () => {
      if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
      }
      clearInterval(healthCheckTimer);
      automationJobStream.stop();
      cronWorker.stop().catch(() => {});
    };
  }

  // ============================================================================
  // Event Trigger Engine — wire automations into the event bus
  // ============================================================================

  const eventTriggerEngine = new EventTriggerEngine(
    automationsStorage,
    streamCore,
    automationContextFactory,
    {
      maxConcurrentPerAutomation: 3,
      runTimeoutMs: 5 * 60 * 1000, // 5 minutes
    },
    automationSemaphore,
    { runRegistry, cancelBroadcast },
  );

  // Inject into the event bus worker so processed events trigger automations.
  // The cast is needed because the EventBus interface doesn't expose this
  // integration point — it lives on the concrete implementation only.
  if ("setEventTriggerEngine" in eventBus) {
    (
      eventBus as unknown as {
        setEventTriggerEngine: (engine: EventTriggerEngine) => void;
      }
    ).setEventTriggerEngine(eventTriggerEngine);
  }

  // ============================================================================
  // Crash Recovery — resume orphaned automation runs after rolling deploy
  // ============================================================================

  /** Shared resume function for both startup recovery and pod-death watcher. */
  const resumeOrphanedThread = async (thread: Thread) => {
    const parsed = PersistedRunConfigSchema.safeParse(thread.run_config);
    if (!parsed.success) {
      console.warn(
        `[recovery] Invalid run_config for ${thread.id}, force-failing`,
      );
      await threadStorage.forceFailIfInProgress(
        thread.id,
        thread.organization_id,
      );
      return;
    }
    const config = parsed.data;

    // Build context for the original user
    const resumeCtx = await automationContextFactory(
      thread.organization_id,
      thread.created_by,
    );
    if (!resumeCtx) {
      console.warn(
        `[recovery] Cannot build context for ${thread.id}, force-failing`,
      );
      await threadStorage.forceFailIfInProgress(
        thread.id,
        thread.organization_id,
      );
      return;
    }

    // Audit trail: record that this run was auto-resumed
    const now = new Date().toISOString();
    await threadStorage.saveMessages(
      [
        {
          id: crypto.randomUUID(),
          thread_id: thread.id,
          role: "system",
          parts: [
            {
              type: "text",
              text: "Run resumed automatically after infrastructure restart.",
            },
          ],
          metadata: undefined,
          created_at: now,
          updated_at: now,
        },
      ],
      thread.organization_id,
    );

    const result = await streamCore(
      {
        messages: [],
        models: toModelsConfig(config.models),
        agent: config.agent,
        temperature: config.temperature,
        toolApprovalLevel: config.toolApprovalLevel,
        mode: config.mode,
        organizationId: thread.organization_id,
        userId: thread.created_by,
        taskId: thread.id,
        windowSize: config.windowSize,
        isResume: true,
      },
      resumeCtx,
      { runRegistry, cancelBroadcast },
    );
    await consumeStreamCore(result);
  };

  // Wire pod death watcher → orphan recovery
  if (podHeartbeat) {
    podHeartbeat.onPodDeath((deadPodId) => {
      runRegistry
        .handlePodDeath(deadPodId, resumeOrphanedThread, cancelBroadcast)
        .catch((err) => {
          console.error(
            `[Decopilot] Pod death recovery failed for ${deadPodId}:`,
            err,
          );
        });
    });
  }

  setTimeout(() => {
    runRegistry.recoverOrphanedRuns(resumeOrphanedThread).catch((err) => {
      console.error("[recovery] Orphan recovery failed:", err);
    });
  }, 10_000); // 10s grace for rolling deploys

  // NDJSON monitoring retention cleanup (always — local files are always written)
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

  currentRetentionTimer = setInterval(
    () => {
      for (const dir of SIGNAL_DIRS) {
        cleanupOldMonitoringFiles(dir).catch((err) =>
          console.error("[monitoring] Retention cleanup failed:", err),
        );
      }
      cleanupExpiredApiKeys();
    },
    24 * 60 * 60 * 1000,
  );
  currentRetentionTimer.unref();

  // Inject MeshContext into requests
  // Skip auth routes, static files, health check, and metrics - they don't need MeshContext
  app.use("*", async (c, next) => {
    if (shouldSkipMeshContext(c.req.path)) {
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

    const meshCtx = await ContextFactory.create(c.req.raw, { timings });
    meshCtx.automationRunner = automationRunner;
    c.set("meshContext", meshCtx);

    try {
      await next();
    } finally {
      // Fire-and-forget: await pending SWR revalidations with a timeout.
      // Keeps ctx (and its client pool) alive via closure while revalidations complete.
      // No pool disposal — pool was never disposed and SSE/streaming connections depend on it.
      const revalidations = meshCtx.pendingRevalidations;
      if (revalidations.length > 0) {
        const REVALIDATION_TIMEOUT_MS = 30_000;
        void Promise.race([
          Promise.allSettled(revalidations),
          new Promise((resolve) =>
            setTimeout(resolve, REVALIDATION_TIMEOUT_MS),
          ),
        ]).catch((err) =>
          console.error("[mesh] revalidation cleanup error:", err),
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
    const path = c.req.path;
    // Skip SSO enforcement for SSO routes, auth routes, and public endpoints
    if (
      path.startsWith("/api/org-sso/") ||
      path.startsWith("/api/auth/") ||
      path.startsWith("/api/tools/management") ||
      path.startsWith("/oauth-proxy/")
    ) {
      return next();
    }

    const ctx = c.get("meshContext") as MeshContext | undefined;
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
    Variables: { meshContext: MeshContext };
  }>();
  legacyOrgSso.use("*", logDeprecatedRoute);
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
    const meshContext = c.var.meshContext;
    // Require either user or API key authentication
    if (!meshContext.auth.user?.id && !meshContext.auth.apiKey?.id) {
      const url = new URL(c.req.url);
      return (c.res = new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer realm="mcp",resource_metadata="${url.origin}${url.pathname}/.well-known/oauth-protected-resource"`,
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
  legacyVirtualMcp.use("*", logDeprecatedRoute);
  legacyVirtualMcp.route("/", createVirtualMcpRoutes());
  app.route("/mcp", legacyVirtualMcp);

  // Self MCP routes (at /mcp/self) - exposes all management tools
  const legacySelf = new Hono<Env>();
  legacySelf.use("*", logDeprecatedRoute);
  legacySelf.route("/", createSelfRoutes());
  app.route("/mcp/self", legacySelf);

  // MCP Proxy routes (connection-specific)
  // Note: SELF MCP ({org}_self) is handled by proxy.ts with special case detection
  const legacyProxy = new Hono<Env>();
  legacyProxy.use("*", logDeprecatedRoute);
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
    threadStorage,
  });
  app.route("/api", decopilotRoutes);

  // Stable file redirect endpoint (resolves mesh-storage: URIs to presigned URLs)
  app.route("/api", filesRoutes);

  // Thread outputs (model-shared files surfaced as download chips in the chat)
  // Legacy mount at /api/* with deprecation log; the new /api/:org/* mount
  // is wired in a later task.
  const legacyThreadOutputsRoutes = new Hono<{
    Variables: { meshContext: MeshContext };
  }>();
  legacyThreadOutputsRoutes.use("*", logDeprecatedRoute);
  legacyThreadOutputsRoutes.route("/", createThreadOutputsRoutes());
  app.route("/api", legacyThreadOutputsRoutes);

  // OpenAI-compatible LLM API routes
  app.route("/api", openaiCompatRoutes);

  // Trigger callback endpoint (external MCPs → Mesh automations).
  // Legacy mount at /api/trigger-callback with deprecation log; the new
  // /api/:org/trigger-callback mount is wired in a later task.
  const legacyTriggerCallback = new Hono<{
    Variables: { meshContext: MeshContext };
  }>();
  legacyTriggerCallback.use("*", logDeprecatedRoute);
  legacyTriggerCallback.route(
    "/",
    createTriggerCallbackRoutes({
      tokenStorage: triggerCallbackTokenStorage,
      eventTriggerEngine,
    }),
  );
  app.route("/api", legacyTriggerCallback);

  // KV store (org-scoped, for external MCPs to persist state)
  // Legacy mount at /api/* with deprecation log; the new /api/:org/* mount
  // is wired in a later task.
  const kvStorage = new KyselyKVStorage(database.db);
  const legacyKVRoutes = new Hono<{
    Variables: { meshContext: MeshContext };
  }>();
  legacyKVRoutes.use("*", logDeprecatedRoute);
  legacyKVRoutes.route("/", createKVRoutes({ kvStorage }));
  app.route("/api", legacyKVRoutes);

  // Public Events endpoint — legacy mount with deprecation log. New mount
  // lives at `POST /api/:org/events/:type` (registered via createOrgScopedApi).
  app.use("/org/:organizationId/events/:type", logDeprecatedRoute);
  app.post("/org/:organizationId/events/:type", eventsHandler);

  // ============================================================================
  // SSE Watch Endpoint — stream events for an organization in real time
  // (Legacy mount with deprecation log. New mount lives at
  // `GET /api/:org/watch` via createOrgScopedApi.)
  // ============================================================================

  app.use("/org/:organizationId/watch", logDeprecatedRoute);
  app.get("/org/:organizationId/watch", watchHandler);

  // Downstream token management routes
  // Legacy mount at /api/* with deprecation log; the new /api/:org/* mount
  // is wired in a later task.
  const legacyDownstreamTokenRoutes = new Hono<{
    Variables: { meshContext: MeshContext };
  }>();
  legacyDownstreamTokenRoutes.use("*", logDeprecatedRoute);
  legacyDownstreamTokenRoutes.route("/", createDownstreamTokenRoutes());
  app.route("/api", legacyDownstreamTokenRoutes);

  // Deco.cx sites list (requires meshContext / auth)
  // /profile is user-scoped (no org), stays mounted permanently — no
  // deprecation log.
  app.route("/api/deco-sites", createDecoSitesUserRoutes());

  // Org-scoped deco-sites routes (GET /, POST /connection). Currently mounted
  // at /api/deco-sites with a deprecation log; the new /api/:org/deco-sites
  // mount is wired in a later task.
  const legacyDecoSitesOrg = new Hono<{
    Variables: { meshContext: MeshContext };
  }>();
  legacyDecoSitesOrg.use("*", logDeprecatedRoute);
  legacyDecoSitesOrg.route("/", createDecoSitesOrgRoutes());
  app.route("/api/deco-sites", legacyDecoSitesOrg);

  // Unified VM events SSE — single auth-gated stream that emits pre-Ready
  // lifecycle phases, then proxies the daemon's `/_decopilot_vm/events` once
  // the sandbox is up. Replaces the prior split between `/api/vm-lifecycle`
  // and the browser's direct daemon EventSource.
  // Legacy mount at /api/vm-events with deprecation log; the new
  // /api/:org/vm-events mount is wired in a later task.
  const legacyVmEvents = new Hono<{
    Variables: { meshContext: MeshContext };
  }>();
  legacyVmEvents.use("*", logDeprecatedRoute);
  legacyVmEvents.route("/", createVmEventsRoutes());
  app.route("/api/vm-events", legacyVmEvents);

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

  // New canonical org-scoped API surface — all routes that depend on org context
  // live here. Old routes still work (with deprecation logs) until the cleanup
  // PR removes them after the deprecation window.
  const orgScopedApi = createOrgScopedApi({
    kvStorage,
    tokenStorage: triggerCallbackTokenStorage,
    eventTriggerEngine,
    mountDevAssets: usesLocalObjectStorage(),
    mcpAuth,
    oauthProxyHandler,
    eventsHandler,
    watchHandler,
    betterAuthProtectedResourceHandler,
  });
  app.route("/api/:org", orgScopedApi);

  // ============================================================================
  // Server Plugin Routes
  // ============================================================================

  // Mount routes from registered server plugins
  // - Public routes are mounted at root level (e.g., /connect/:sessionId)
  // - Authenticated routes are mounted at /api/plugins/:pluginId/*
  // Note: vault and initializePluginStorage are called earlier (before eventBus.start)
  // to avoid race conditions with plugin onStartup hooks.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mountPluginRoutes(app, { db: database.db as any, vault });

  // ============================================================================
  // 404 Handler
  // ============================================================================

  app.notFound((c) => {
    return c.json({ error: "Not Found", path: c.req.path }, 404);
  });

  // ============================================================================
  // Error Handler
  // ============================================================================

  app.onError((err, c) => {
    console.error("Server error :", err);

    // If error is Error, provide message
    const message = err instanceof Error ? err.message : "Unknown error";

    return c.json(
      {
        error: "Internal Server Error",
        message,
      },
      500,
    );
  });

  const markShuttingDown = () => {
    isShuttingDown = true;
  };

  const shutdown = async () => {
    console.log("[shutdown] Stopping workers...");

    // Phase 1: Stop all workers/consumers in parallel (independent of each other)
    await Promise.allSettled([
      eventBus.isRunning() ? eventBus.stop() : Promise.resolve(),
      sseHub.stop(),
      currentCronWorkerCleanup
        ? Promise.resolve(currentCronWorkerCleanup()).finally(() => {
            currentCronWorkerCleanup = null;
          })
        : Promise.resolve(),
      currentDecopilotCleanup
        ? Promise.resolve(currentDecopilotCleanup()).finally(() => {
            currentDecopilotCleanup = null;
          })
        : Promise.resolve(),
    ]);

    // Phase 2: Clear timers
    if (currentRetentionTimer) {
      clearInterval(currentRetentionTimer);
      currentRetentionTimer = null;
    }

    // Sweep sandbox containers — Docker only. Other runners' sandboxes
    // outlive mesh by design, so a generic sweep would nuke active user VMs.
    // Must run before NATS/DB close (sweep writes state).
    const dockerRunner = asDockerRunner(getSharedRunnerIfInit());
    if (dockerRunner) {
      const { sweepDockerOrphansOnShutdown } = await import(
        "@decocms/sandbox/runner"
      );
      await sweepDockerOrphansOnShutdown(dockerRunner);
    }

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

  return Object.assign(app, { markShuttingDown, shutdown });
}
