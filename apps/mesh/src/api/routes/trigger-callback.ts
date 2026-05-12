/**
 * Trigger Callback Endpoint
 *
 * Receives trigger events from external MCPs (e.g., GitHub webhook handler)
 * and fires matching automations via AutomationEventDispatcher.
 *
 * Auth: Bearer token (callback token generated during TRIGGER_CONFIGURE)
 * Route: POST /api/trigger-callback
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AutomationEventDispatcher } from "@/automations/automation-event-dispatcher";
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
  const app = new Hono();

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
