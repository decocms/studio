import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AutomationEventDispatcher } from "@/automations/automation-event-dispatcher";
import type { CancelBroadcast } from "@/api/routes/decopilot/cancel-broadcast";
import type { RunRegistry } from "@/api/routes/decopilot/run-registry";
import type { StreamBuffer } from "@/api/routes/decopilot/stream-buffer";
import type { KVStorage } from "@/storage/kv";
import type { TriggerCallbackTokenStorage } from "@/storage/trigger-callback-tokens";
import { resolveOrgFromPath } from "../middleware/resolve-org-from-path";
import type { Env } from "../hono-env";

import { createAutomationWebhookRoutes } from "./automation-webhooks";
import { createDecoSitesOrgRoutes } from "./deco-sites";
import { createDevAssetsRoutes } from "./dev-assets";
import { createDownstreamTokenRoutes } from "./downstream-token";
import { createFileUploadRoutes } from "./file-uploads";
import { createKVRoutes } from "./kv";
import { createOrgScopedWellKnownProtectedResourceRoutes } from "./oauth-proxy";
import { createSsoRoutes } from "./org-sso";
import { createProxyRoutes } from "./proxy";
import { createSelfRoutes } from "./self";
import { createStudioPackChecklistsRoutes } from "./studio-pack-checklists";
import { createStudioPackWelcomeRoutes } from "./studio-pack-welcome";
import { createSuggestedActionsRoutes } from "./suggested-actions";
import { createThreadOutputsRoutes } from "./thread-outputs";
import { createTriggerCallbackRoutes } from "./trigger-callback";
import { createVirtualMcpRoutes } from "./virtual-mcp";
import { createSandboxRoutes } from "./sandbox-proxy";

interface OrgScopedDeps {
  kvStorage: KVStorage;
  /**
   * Decopilot dispatch primitives — required by the preset-task `/start`
   * route, which kicks an agent run server-side and returns the taskId
   * for the FE to navigate to. The same trio is wired into
   * `createDecopilotRoutes` in app.ts; threading them through here lets
   * server-initiated runs share the JetStream pump + cancel reactor +
   * run registry the chat path uses.
   */
  runRegistry: RunRegistry;
  streamBuffer: StreamBuffer;
  cancelBroadcast: CancelBroadcast;
  tokenStorage: TriggerCallbackTokenStorage;
  automationEventDispatcher: AutomationEventDispatcher;
  /** Whether dev-only routes should be mounted (no S3 → DevObjectStorage). */
  mountDevAssets: boolean;
  /** mcpAuth middleware (defined in app.ts; must be applied under the new MCP prefixes). */
  mcpAuth: MiddlewareHandler<Env>;
  /**
   * OAuth-proxy handler (defined in app.ts). Mounted under
   * `/api/:org/oauth-proxy/:connectionId/*` and inherits cross-org enforcement
   * from `resolveOrgFromPath` (the handler additionally checks that the
   * connection's `organization_id` matches the resolved org).
   */
  oauthProxyHandler: MiddlewareHandler<Env>;
  /**
   * Public events handler (defined in app.ts). Mounted at
   * `POST /api/:org/events/:type`.
   */
  eventsHandler: MiddlewareHandler<Env>;
  /**
   * SSE events handler (defined in app.ts). Mounted at
   * `GET /api/:org/watch`.
   */
  watchHandler: MiddlewareHandler<Env>;
  /**
   * Better-Auth-served Protected Resource Metadata for the gateway-style MCP
   * URL family. Mounted at
   * `/api/:org/mcp/:gateway?/:connectionId/.well-known/oauth-protected-resource/*`.
   */
  betterAuthProtectedResourceHandler: MiddlewareHandler<Env>;
}

export const createOrgScopedApi = (deps: OrgScopedDeps) => {
  const app = new Hono<Env>();

  // EVERY route in this sub-app gets org resolved from :org path param
  app.use("*", resolveOrgFromPath);

  // --- Routes that don't need extra middleware ---
  app.route("/", createDownstreamTokenRoutes()); // /api/:org/connections/:connectionId/oauth-token
  app.route("/", createThreadOutputsRoutes()); // /api/:org/threads/:threadId/outputs
  app.route("/", createKVRoutes({ kvStorage: deps.kvStorage }));
  app.route("/", createFileUploadRoutes()); // /api/:org/file-configs/:id/upload
  app.route("/sandbox", createSandboxRoutes()); // /api/:org/sandbox/:virtualMcpId/:branch/*
  app.route("/", createSuggestedActionsRoutes());
  app.route("/", createStudioPackChecklistsRoutes());
  app.route("/", createStudioPackWelcomeRoutes());
  app.route("/deco-sites", createDecoSitesOrgRoutes()); // /api/:org/deco-sites
  app.route("/sso", createSsoRoutes()); // /api/:org/sso/* (renamed from /api/org-sso)
  app.route(
    "/",
    createTriggerCallbackRoutes({
      tokenStorage: deps.tokenStorage,
      automationEventDispatcher: deps.automationEventDispatcher,
    }),
  ); // /api/:org/trigger-callback
  app.route("/webhooks", createAutomationWebhookRoutes()); // /api/:org/webhooks/:triggerId[/:token]

  if (deps.mountDevAssets) {
    app.route("/dev-assets", createDevAssetsRoutes({ orgFromPath: true }));
  }

  // --- MCP routes need mcpAuth in addition to resolveOrgFromPath ---
  // Order matters (preserve from legacy): virtual-mcp → self → proxy
  app.use("/mcp/:connectionId?", deps.mcpAuth);
  app.use("/mcp/gateway/:virtualMcpId?", deps.mcpAuth);
  app.use("/mcp/virtual-mcp/:virtualMcpId?", deps.mcpAuth);
  app.use("/mcp/self", deps.mcpAuth);

  // OAuth Protected-Resource discovery for connection MCPs (resource-relative
  // shape). Expands to
  // `/api/:org/mcp/:connectionId/.well-known/oauth-protected-resource`, which
  // is what the proxy's WWW-Authenticate `resource_metadata` header points to.
  // The well-known *prefix* shape lives outside this sub-app — see app.ts.
  // Must mount BEFORE the catch-all proxy routes so the well-known suffix wins.
  app.route("/", createOrgScopedWellKnownProtectedResourceRoutes());

  // Better-Auth Protected Resource Metadata for the gateway-style URL family.
  // Mounted BEFORE the proxy routes for the same reason.
  app.get(
    "/mcp/:gateway?/:connectionId/.well-known/oauth-protected-resource/*",
    deps.betterAuthProtectedResourceHandler,
  );

  app.route("/mcp", createVirtualMcpRoutes());
  app.route("/mcp/self", createSelfRoutes());
  app.route("/mcp", createProxyRoutes());

  // --- Inline routes migrated from app.ts (Task 15) ---
  // OAuth proxy under the org-scoped prefix; resolveOrgFromPath has run, so
  // the handler can enforce cross-org access (connection.organization_id
  // must match the resolved org).
  app.all("/oauth-proxy/:connectionId/*", deps.oauthProxyHandler);

  // Public events: POST /events/:type publishes; GET /watch streams.
  app.post("/events/:type", deps.eventsHandler);
  app.get("/watch", deps.watchHandler);

  return app;
};
