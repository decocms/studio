import { Hono } from "hono";
import type { ServerPluginContext } from "@decocms/bindings/server-plugin";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PLUGIN_ID } from "../../shared";
import { PublishRequestStorage } from "../storage/publish-request";
import { PublishApiKeyStorage } from "../storage/publish-api-key";
import { PublicPublishRequestInputSchema } from "../tools/schema";
import type { PrivateRegistryDatabase } from "../storage/types";

type RateLimitWindow = "minute" | "hour";

const DEFAULT_RATE_LIMIT_ENABLED = true;
const DEFAULT_RATE_LIMIT_WINDOW: RateLimitWindow = "hour";
const DEFAULT_RATE_LIMIT_MAX = 100;

type CoreDb = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectFrom: (...args: any[]) => any;
};

type EventDb = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insertInto: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectFrom: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeQuery?: (...args: any[]) => Promise<unknown>;
};

async function publishRequestCreatedEvent(args: {
  db: EventDb;
  organizationId: string;
  request: {
    id: string;
    requested_id: string | null;
    title: string;
    status: string;
    created_at: string;
    requester_name: string | null;
    requester_email: string | null;
  };
}): Promise<void> {
  const now = new Date().toISOString();
  const eventId = randomUUID();
  const sourceConnectionId = WellKnownOrgMCPId.SELF(args.organizationId);
  const eventType = "registry.publish_request.created";
  const eventData = {
    requestId: args.request.id,
    requestedId: args.request.requested_id,
    title: args.request.title,
    status: args.request.status,
    createdAt: args.request.created_at,
    requester: {
      name: args.request.requester_name,
      email: args.request.requester_email,
    },
  };

  await args.db
    .insertInto("events")
    .values({
      id: eventId,
      organization_id: args.organizationId,
      type: eventType,
      source: sourceConnectionId,
      specversion: "1.0",
      subject: args.request.id,
      time: now,
      datacontenttype: "application/json",
      dataschema: null,
      data: JSON.stringify(eventData),
      cron: null,
      status: "pending",
      attempts: 0,
      last_error: null,
      next_retry_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const subscriptions = await args.db
    .selectFrom("event_subscriptions")
    .select(["id"])
    .where("organization_id", "=", args.organizationId)
    .where("enabled", "=", 1)
    .where("event_type", "=", eventType)
    .where((eb: any) =>
      eb.or([
        eb("publisher", "is", null),
        eb("publisher", "=", sourceConnectionId),
      ]),
    )
    .execute();

  if (subscriptions.length > 0) {
    await args.db
      .insertInto("event_deliveries")
      .values(
        subscriptions.map((subscription: { id: string }) => ({
          id: randomUUID(),
          event_id: eventId,
          subscription_id: subscription.id,
          status: "pending",
          attempts: 0,
          last_error: null,
          delivered_at: null,
          next_retry_at: null,
          created_at: now,
        })),
      )
      .execute();
  }

  // Best effort wake-up for PostgreSQL LISTEN/NOTIFY deployments.
  // On SQLite, this query is expected to fail and is safely ignored.
  try {
    await sql`SELECT pg_notify('mesh_events', ${eventId})`.execute(
      args.db as any,
    );
  } catch {
    // no-op
  }
}

async function resolveOrganizationId(
  db: CoreDb,
  orgRef: string,
): Promise<string | null> {
  const byIdRows = await db
    .selectFrom("organization")
    .select(["id"])
    .where("id", "=", orgRef)
    .execute();
  const byId = byIdRows[0] as { id: string } | undefined;
  if (byId?.id) return byId.id;

  const bySlugRows = await db
    .selectFrom("organization")
    .select(["id"])
    .where("slug", "=", orgRef)
    .execute();
  const bySlug = bySlugRows[0] as { id: string } | undefined;
  return bySlug?.id ?? null;
}

interface PluginSettings {
  acceptPublishRequests?: boolean;
  requireApiToken?: boolean;
  rateLimitEnabled: boolean;
  rateLimitWindow: RateLimitWindow;
  rateLimitMax: number;
}

async function getPluginSettings(
  db: CoreDb,
  orgId: string,
): Promise<PluginSettings> {
  const rows = await db
    .selectFrom("project_plugin_configs")
    .innerJoin("projects", "projects.id", "project_plugin_configs.project_id")
    .select(["project_plugin_configs.settings as settings"])
    .where("projects.organization_id", "=", orgId)
    .where("project_plugin_configs.plugin_id", "=", PLUGIN_ID)
    .execute();

  for (const row of rows as Array<{ settings: string | null }>) {
    const rawSettings = row.settings;
    const settings =
      typeof rawSettings === "string"
        ? (() => {
            try {
              return JSON.parse(rawSettings) as Record<string, unknown>;
            } catch {
              return {};
            }
          })()
        : ((rawSettings as Record<string, unknown> | null) ?? {});

    if (settings.acceptPublishRequests === true) {
      const rateLimitWindow: RateLimitWindow =
        settings.rateLimitWindow === "minute" ? "minute" : "hour";
      const rawRateLimitMax = settings.rateLimitMax;
      const rateLimitMax =
        typeof rawRateLimitMax === "number" &&
        Number.isFinite(rawRateLimitMax) &&
        rawRateLimitMax >= 1
          ? Math.floor(rawRateLimitMax)
          : DEFAULT_RATE_LIMIT_MAX;

      return {
        acceptPublishRequests: true,
        requireApiToken: settings.requireApiToken === true,
        rateLimitEnabled:
          settings.rateLimitEnabled === undefined
            ? DEFAULT_RATE_LIMIT_ENABLED
            : settings.rateLimitEnabled === true,
        rateLimitWindow,
        rateLimitMax,
      };
    }
  }

  return {
    acceptPublishRequests: false,
    requireApiToken: false,
    rateLimitEnabled: DEFAULT_RATE_LIMIT_ENABLED,
    rateLimitWindow: DEFAULT_RATE_LIMIT_WINDOW,
    rateLimitMax: DEFAULT_RATE_LIMIT_MAX,
  };
}

/**
 * Check how many publish requests were created for this org in the configured window.
 */
async function countRecentRequests(
  db: Kysely<PrivateRegistryDatabase>,
  orgId: string,
  window: RateLimitWindow,
): Promise<number> {
  const windowMs = window === "minute" ? 60 * 1000 : 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const row = await db
    .selectFrom("private_registry_publish_request")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("organization_id", "=", orgId)
    .where("created_at", ">=", windowStart)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

/**
 * Prevent publish requests from colliding with an existing registry item.
 * We block when either the requested ID or title is already in use.
 */
async function findRegistryItemConflict(
  db: Kysely<PrivateRegistryDatabase>,
  orgId: string,
  requestedId: string,
  requestedTitle: string,
): Promise<{ id: string; title: string } | null> {
  const conflict = await db
    .selectFrom("private_registry_item")
    .select(["id", "title"])
    .where("organization_id", "=", orgId)
    .where((eb) =>
      eb.or([eb("id", "=", requestedId), eb("title", "=", requestedTitle)]),
    )
    .executeTakeFirst();

  return conflict
    ? { id: String(conflict.id), title: String(conflict.title) }
    : null;
}

export function publicPublishRequestRoutes(
  app: Hono,
  ctx: ServerPluginContext,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = ctx.db as any;
  const typedDb = ctx.db as Kysely<PrivateRegistryDatabase>;
  const storage = new PublishRequestStorage(typedDb);
  const apiKeyStorage = new PublishApiKeyStorage(typedDb);

  app.post("/org/:orgRef/registry/publish-request", async (c) => {
    const orgRef = c.req.param("orgRef");
    const organizationId = await resolveOrganizationId(db as CoreDb, orgRef);
    if (!organizationId) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // ── Check plugin settings ──
    const settings = await getPluginSettings(db as CoreDb, organizationId);

    if (!settings.acceptPublishRequests) {
      return c.json(
        { error: "Publish requests are not enabled for this registry." },
        403,
      );
    }

    // ── API key validation ──
    if (settings.requireApiToken) {
      const authHeader = c.req.header("Authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;

      if (!token) {
        return c.json(
          { error: "API key required. Use Authorization: Bearer <key>" },
          401,
        );
      }

      const valid = await apiKeyStorage.validate(organizationId, token);
      if (!valid) {
        return c.json({ error: "Invalid API key" }, 401);
      }
    }

    // ── Rate limit ──
    if (settings.rateLimitEnabled) {
      const recentCount = await countRecentRequests(
        typedDb,
        organizationId,
        settings.rateLimitWindow,
      );
      if (recentCount >= settings.rateLimitMax) {
        return c.json(
          {
            error: "Too many publish requests. Please try again later.",
            retryAfterSeconds:
              settings.rateLimitWindow === "minute" ? 60 : 3600,
          },
          429,
        );
      }
    }

    // ── Parse and create ──
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = PublicPublishRequestInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid publish request payload",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    // ── Existing item collision guard ──
    const conflict = await findRegistryItemConflict(
      typedDb,
      organizationId,
      parsed.data.data.id,
      parsed.data.data.title,
    );
    if (conflict) {
      return c.json(
        {
          error:
            "A registry item with the same id or title already exists. Please use a different name/id.",
          conflict,
        },
        409,
      );
    }

    const created = await storage.createOrUpdate({
      organization_id: organizationId,
      requested_id: parsed.data.data.id,
      title: parsed.data.data.title,
      description: parsed.data.data.description ?? null,
      _meta: parsed.data.data._meta,
      server: parsed.data.data.server,
      requester_name: parsed.data.requester?.name ?? null,
      requester_email: parsed.data.requester?.email ?? null,
    });

    try {
      await publishRequestCreatedEvent({
        db: db as EventDb,
        organizationId,
        request: created,
      });
    } catch (error) {
      console.warn(
        "[private-registry] failed to emit publish-request event:",
        error,
      );
    }

    return c.json(
      {
        id: created.id,
        requested_id: created.requested_id,
        status: created.status,
      },
      201,
    );
  });
}
