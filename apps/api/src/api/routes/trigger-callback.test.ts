import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AutomationEventDispatcher } from "@/automations/automation-event-dispatcher";
import type { StudioContext } from "@/core/studio-context";
import type { TriggerCallbackTokenStorage } from "@/storage/trigger-callback-tokens";
import { createTriggerCallbackRoutes } from "./trigger-callback";

const TOKEN_ORG = "org-a";
const TOKEN_CONNECTION = "conn-1";

function buildApp(pathOrgId: string | undefined) {
  const dispatched: unknown[] = [];
  const tokenStorage: Pick<TriggerCallbackTokenStorage, "validateToken"> = {
    validateToken: async (token: string) =>
      token === "valid-token"
        ? { organizationId: TOKEN_ORG, connectionId: TOKEN_CONNECTION }
        : null,
  };
  const automationEventDispatcher = {
    dispatchForEvents: (events: unknown[]) => {
      dispatched.push(...events);
    },
  } as unknown as AutomationEventDispatcher;

  const app = new Hono<{
    Variables: { studioContext?: StudioContext };
  }>();
  // Simulates resolveOrgFromPath having already run for the org-scoped mount.
  // The legacy unscoped mount never sets studioContext.organization, so
  // pathOrgId is undefined there.
  app.use("*", async (c, next) => {
    if (pathOrgId) {
      c.set("studioContext", {
        organization: { id: pathOrgId },
      } as unknown as StudioContext);
    }
    await next();
  });
  app.route(
    "/",
    createTriggerCallbackRoutes({
      tokenStorage: tokenStorage as TriggerCallbackTokenStorage,
      automationEventDispatcher,
    }),
  );
  return { app, dispatched };
}

describe("POST /trigger-callback — cross-org token replay", () => {
  it("fires the automation when the path org matches the token's org", async () => {
    const { app, dispatched } = buildApp(TOKEN_ORG);
    const res = await app.request("/trigger-callback", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "issue.opened" }),
    });
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });

  it("rejects a valid token replayed against a mismatched org path", async () => {
    const { app, dispatched } = buildApp("org-b");
    const res = await app.request("/trigger-callback", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "issue.opened" }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it("still fires on the legacy unscoped mount (no path-resolved org)", async () => {
    const { app, dispatched } = buildApp(undefined);
    const res = await app.request("/trigger-callback", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "issue.opened" }),
    });
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });
});
