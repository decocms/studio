/**
 * Trigger Callback Endpoint
 *
 * Receives trigger events from external MCPs (e.g., GitHub webhook handler)
 * and fires matching automations via AutomationEventDispatcher.
 *
 * Auth: Bearer token (callback token generated during TRIGGER_CONFIGURE)
 * Routes:
 *   POST /api/:org/trigger-callback — canonical; ConfigureTrigger mints the
 *     callback URL with the org's own slug, so a legitimate caller's :org
 *     always matches the token's bound organization.
 *   POST /api/trigger-callback — legacy, unscoped, deprecated.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AutomationEventDispatcher } from "@/automations/automation-event-dispatcher";
import type { DeprecatedRouteAttribution } from "@/api/middleware/log-deprecated-route";
import type { StudioContext } from "@/core/studio-context";
import type { TriggerCallbackTokenStorage } from "@/storage/trigger-callback-tokens";

const TriggerCallbackBodySchema = z.object({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

interface TriggerCallbackDeps {
  tokenStorage: TriggerCallbackTokenStorage;
  automationEventDispatcher: AutomationEventDispatcher;
}

const MAX_BODY_SIZE = 1_048_576; // 1MB

export function createTriggerCallbackRoutes(deps: TriggerCallbackDeps) {
  const app = new Hono<{
    Variables: {
      deprecatedRouteAttribution?: DeprecatedRouteAttribution;
      studioContext?: StudioContext;
    };
  }>();

  app.post(
    "/trigger-callback",
    bodyLimit({
      maxSize: MAX_BODY_SIZE,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    async (c) => {
      // Extract Bearer token
      const authHeader = c.req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json(
          { error: "Missing or invalid Authorization header" },
          401,
        );
      }
      const token = authHeader.slice(7);

      // Validate token
      const context = await deps.tokenStorage.validateToken(token);
      if (!context) {
        return c.json({ error: "Invalid callback token" }, 401);
      }

      // Under the org-scoped mount, resolveOrgFromPath has already resolved
      // `:org` onto studioContext.organization. Cross-check it against the
      // token's bound organization so a token can't be replayed against a
      // mismatched URL — same defense-in-depth as automation-webhooks.ts.
      // The legacy unscoped mount has no path-resolved org, so this is a
      // no-op there.
      const pathOrgId = c.get("studioContext")?.organization?.id;
      if (pathOrgId && pathOrgId !== context.organizationId) {
        return c.json({ error: "Invalid callback token" }, 401);
      }

      // Attribute the legacy-route deprecation log to the token's
      // org/connection — the legacy mount has no session-based studioContext.
      c.set("deprecatedRouteAttribution", {
        organizationId: context.organizationId,
        connectionId: context.connectionId,
      });

      // Parse and validate body
      const parsed = TriggerCallbackBodySchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400,
        );
      }

      const { type, data } = parsed.data;

      // Fire matching automations (fire-and-forget)
      deps.automationEventDispatcher.dispatchForEvents([
        {
          source: context.connectionId,
          type,
          data: data ?? {},
          organizationId: context.organizationId,
        },
      ]);

      return c.json({ ok: true, type }, 202);
    },
  );

  return app;
}
