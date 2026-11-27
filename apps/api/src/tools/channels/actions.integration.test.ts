import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import { checkApiKeyPermission } from "../../auth/api-key-permissions";
import {
  getCachedBuiltinRoleStatements,
  resolveBuiltinRolePermission,
} from "../../auth/builtin-role-permission";
import { AccessControl } from "../../core/access-control";
import type { BoundAuthClient, StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { getSettings, setGlobalSettings } from "../../settings";
import { ChannelsStorage } from "../../storage/channels";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import type { Permission } from "../../storage/types";
import { UserStorage } from "../../storage/user";
import {
  CHANNELS_ACTION_CALL,
  CHANNELS_ACTION_LIST,
  CHANNELS_ACTION_SEND,
} from "./index";
import { callWorkerTool } from "./worker";

/**
 * The action tools against a fake channel worker: a real HTTP server on a
 * random port answering the JSON-RPC subset a worker's /api/mcp speaks
 * (tools/list as SSE, tools/call as JSON), recording what Studio sent it.
 */

const ORG_ID = "org_123";
const OTHER_ORG_ID = "org_456";
const USER_ID = "user_1";
const HUB_TOKEN = "hub-token-test";

type Principal =
  | { kind: "member"; role: string; email?: string }
  | { kind: "apiKey"; allowlist: Permission };

/** A bound auth that answers the way the real one does for each principal. */
function boundAuthFor(principal: Principal): BoundAuthClient {
  return {
    isApiKeyPrincipal: principal.kind === "apiKey",
    hasPermission: async (requested: Permission) =>
      principal.kind === "apiKey"
        ? checkApiKeyPermission(principal.allowlist, requested)
        : resolveBuiltinRolePermission(
            principal.role,
            requested,
            getCachedBuiltinRoleStatements(),
          ) === "grant",
  } as unknown as BoundAuthClient;
}

type Call = { auth: string | null; name: string; arguments: unknown };

describe("CHANNELS_ACTION tools", () => {
  let database: StudioDatabase;
  let channels: ChannelsStorage;
  let users: UserStorage;
  let organizationSettings: OrganizationSettingsStorage;
  let worker: ReturnType<typeof Bun.serve>;
  let connectionId: string;
  let foreignConnectionId: string;
  const calls: Call[] = [];
  const originalSettings = getSettings();

  const configure = (urls: Record<string, string> | undefined) =>
    setGlobalSettings({
      ...originalSettings,
      channelsHubToken: HUB_TOKEN,
      channelsWorkerUrls: urls,
    });

  function makeCtx(
    toolName: string,
    principal: Principal = { kind: "member", role: "owner" },
  ): StudioContext {
    const role = principal.kind === "member" ? principal.role : undefined;
    return {
      auth: {
        // An API key's user carries no email; the tool looks it up.
        user:
          principal.kind === "member"
            ? {
                id: USER_ID,
                email: principal.email ?? "member@example.com",
                role,
              }
            : { id: USER_ID },
      },
      organization: { id: ORG_ID, slug: ORG_ID, name: ORG_ID },
      access: new AccessControl(
        USER_ID,
        toolName,
        boundAuthFor(principal),
        role,
        "self",
        undefined,
        ORG_ID,
      ),
      storage: { channels, users, organizationSettings },
    } as unknown as StudioContext;
  }

  const list = (principal?: Principal, id = connectionId) =>
    CHANNELS_ACTION_LIST.handler(
      { connection_id: id },
      makeCtx("CHANNELS_ACTION_LIST", principal),
    );

  const call = (
    tool: string,
    args: Record<string, unknown> = {},
    principal?: Principal,
  ) =>
    CHANNELS_ACTION_CALL.handler(
      { connection_id: connectionId, tool, arguments: args },
      makeCtx("CHANNELS_ACTION_CALL", principal),
    );

  const send = (
    tool: string,
    args: Record<string, unknown> = {},
    principal?: Principal,
  ) =>
    CHANNELS_ACTION_SEND.handler(
      { connection_id: connectionId, tool, arguments: args },
      makeCtx("CHANNELS_ACTION_SEND", principal),
    );

  beforeAll(async () => {
    worker = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          id: number;
          method: string;
          params: { name?: string; arguments?: Record<string, unknown> };
        };
        const answer = (result: unknown) =>
          Response.json({ jsonrpc: "2.0", id: body.id, result });
        if (body.method === "tools/list") {
          const message = JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                { name: "pair_number", inputSchema: { type: "object" } },
                { name: "send_message", description: "Send a message" },
                { name: "open_inbox", description: "The inbox view" },
              ],
            },
          });
          return new Response(`event: message\ndata: ${message}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        const name = body.params.name ?? "";
        calls.push({
          auth: req.headers.get("authorization"),
          name,
          arguments: body.params.arguments,
        });
        if (name === "slow") await Bun.sleep(1000);
        if (name === "pair_number" && body.params.arguments?.fail) {
          return answer({
            isError: true,
            content: [{ type: "text", text: "This number isn't paired." }],
          });
        }
        return answer({ structuredContent: { ok: true, tool: name } });
      },
    });

    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem-actions', ${USER_ID}, ${ORG_ID}, 'owner', ${new Date().toISOString()})
    `.execute(database.db);
    channels = new ChannelsStorage(database.db);
    users = new UserStorage(database.db);
    organizationSettings = new OrganizationSettingsStorage(database.db);
    await organizationSettings.upsert(ORG_ID, {
      flags: { channels_enabled: true },
    });
    const own = await channels.createConnection({
      organizationId: ORG_ID,
      source: "whatsapp",
      externalId: "+5500000000001",
    });
    const foreign = await channels.createConnection({
      organizationId: OTHER_ORG_ID,
      source: "whatsapp",
      externalId: "+5500000000002",
    });
    if (!own || !foreign) throw new Error("connections not created");
    connectionId = own.connection.id;
    foreignConnectionId = foreign.connection.id;
  });

  beforeEach(() => {
    calls.length = 0;
    configure({ whatsapp: `http://127.0.0.1:${worker.port}` });
  });

  afterAll(async () => {
    setGlobalSettings(originalSettings);
    worker.stop(true);
    await closeTestPgDatabase(database);
  });

  it("lists the worker's actions with their capability, views left out", async () => {
    expect(await list({ kind: "member", role: "user" })).toEqual({
      actions: [
        {
          name: "pair_number",
          description: null,
          scope: "connections:manage",
          input_schema: { type: "object" },
        },
        {
          name: "send_message",
          description: "Send a message",
          scope: "channels:send",
          input_schema: null,
        },
      ],
    });
  });

  it("never runs a view", async () => {
    await expect(call("open_inbox")).rejects.toThrow("is a view");
    expect(calls).toEqual([]);
  });

  it("stamps the caller as the viewer and drops any viewer the caller sent", async () => {
    const result = await send("send_message", {
      chat: "c1",
      text: "hello",
      _viewer: "someone-else@example.com",
      _org: "another-org",
    });
    expect(result).toEqual({ result: { ok: true, tool: "send_message" } });
    expect(calls).toEqual([
      {
        auth: `Bearer ${HUB_TOKEN}`,
        name: "send_message",
        arguments: { chat: "c1", text: "hello", _viewer: "member@example.com" },
      },
    ]);
  });

  it("refuses to send without channels:send, which the built-in user lacks", async () => {
    const user: Principal = { kind: "member", role: "user" };
    await expect(send("send_message", {}, user)).rejects.toThrow(
      "Access denied",
    );
    expect(await call("pair_number", {}, user)).toEqual({
      result: { ok: true, tool: "pair_number" },
    });
    expect(calls.map((c) => c.name)).toEqual(["pair_number"]);
  });

  it("refuses a setup action without connections:manage, and acts as the key's creator", async () => {
    const sendOnly: Principal = {
      kind: "apiKey",
      allowlist: { self: ["CHANNELS_ACTION_SEND", "CHANNELS_ACTION_LIST"] },
    };
    await expect(call("pair_number", {}, sendOnly)).rejects.toThrow(
      "Access denied",
    );
    await send("send_message", { chat: "c1" }, sendOnly);
    expect(calls).toEqual([
      {
        auth: `Bearer ${HUB_TOKEN}`,
        name: "send_message",
        arguments: { chat: "c1", _viewer: `${USER_ID}@test.com` },
      },
    ]);
  });

  it("keeps each tool to its own scope", async () => {
    await expect(call("send_message")).rejects.toThrow("CHANNELS_ACTION_SEND");
    await expect(send("pair_number")).rejects.toThrow("CHANNELS_ACTION_CALL");
    expect(calls).toEqual([]);
  });

  it("surfaces the worker's error as the tool's error", async () => {
    await expect(call("pair_number", { fail: true })).rejects.toThrow(
      "This number isn't paired.",
    );
  });

  it("reaches only the org's own connections", async () => {
    await expect(list(undefined, foreignConnectionId)).rejects.toThrow(
      "Channel connection not found",
    );
  });

  it("refuses when the source has no worker configured", async () => {
    configure({ discord: `http://127.0.0.1:${worker.port}` });
    await expect(call("pair_number")).rejects.toThrow(
      "whatsapp has no worker configured",
    );
    configure(undefined);
    await expect(call("pair_number")).rejects.toThrow("aren't configured");
    expect(calls).toEqual([]);
  });

  it("gives up on a worker that doesn't answer in time", async () => {
    await expect(
      callWorkerTool("whatsapp", "slow", {}, "member@example.com", 100),
    ).rejects.toThrow("didn't answer in time");
  });
});
