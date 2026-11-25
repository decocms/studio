process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");
process.env.CHANNELS_SERVICE_TOKEN = "channels-secret";
process.env.CHANNELS_SERVICE_URL = "https://channels.example";

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { auth } from "../../auth";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { ChannelAccountStorage } from "../../storage/channel-accounts";
import { createApp } from "../app";

describe("the channels service's routes", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let accounts: ChannelAccountStorage;

  const call = (
    path: string,
    body: unknown,
    init: { method?: string; bearer?: string } = {},
  ) =>
    app.fetch(
      new Request(`http://test/api/${path}`, {
        method: init.method ?? "POST",
        headers: {
          authorization: `Bearer ${init.bearer ?? "channels-secret"}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  const ana = { channel: "slack", account_id: "T1:U1" };
  const claim = (over: Record<string, unknown> = {}) => ({
    ...ana,
    account_name: "Ana",
    account_where: "Acme",
    return_url: "https://channels.example/studio/connected?c=1",
    ...over,
  });
  /** What the person does in Studio: spend the link the service opened. */
  const connect = async (org: string, userId: string, input = claim()) => {
    const res = await call(`${org}/internal/channel-accounts/claims`, input);
    const { url } = (await res.json()) as { url: string };
    const id = url.split("/").at(-1) as string;
    return { url, connected: await accounts.connect(org, id, userId) };
  };

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    accounts = new ChannelAccountStorage(database.db);
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: { message: "invalid api key" },
      key: null,
    } as never);
    const now = new Date().toISOString();
    await database.db
      .insertInto("member")
      .values([
        {
          id: "mem_channels_user_1",
          userId: "user_1",
          organizationId: "org_1",
          role: "user",
          createdAt: now,
        },
        {
          id: "mem_channels_user_123",
          userId: "user_123",
          organizationId: "org_456",
          role: "owner",
          createdAt: now,
        },
      ])
      .execute();
    app = await createApp({ database, disableNats: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.shutdown();
    if (database) await closeTestPgDatabase(database);
  });

  it("answers nobody without the service's own secret", async () => {
    for (const bearer of ["other-secret", ""]) {
      const res = await call("org_1/internal/channel-accounts/token", ana, {
        bearer,
      });
      expect(res.status).toBe(401);
    }
  });

  it("opens a link to Studio's connect page, back only to the service", async () => {
    const res = await call("org_1/internal/channel-accounts/claims", claim());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expires_in: number };
    expect(body.url).toMatch(/\/connect-channel\/org_1\/chc_[\w-]+$/);
    expect(body.expires_in).toBe(900);

    const elsewhere = await call(
      "org_1/internal/channel-accounts/claims",
      claim({ return_url: "https://evil.example/steal" }),
    );
    expect(elsewhere.status).toBe(400);
    // The service can't say who the account belongs to.
    const named = await call(
      "org_1/internal/channel-accounts/claims",
      claim({ user_id: "user_1" }),
    );
    expect(named.status).toBe(400);
  });

  it("gives no token for an account nobody connected", async () => {
    const res = await call("org_1/internal/channel-accounts/token", ana);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_linked" });
  });

  it("gives a connected account a token that acts as that person, in that org only", async () => {
    const { connected } = await connect("org_1", "user_1");
    expect(connected?.account.userId).toBe("user_1");

    const res = await call("org_1/internal/channel-accounts/token", ana);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expires_in: number;
      user: { id: string; email: string };
      orgs: { id: string; slug: string; name: string }[];
    };
    expect(body.user).toMatchObject({ id: "user_1", email: "user_1@test.com" });
    expect(body.orgs).toEqual([{ id: "org_1", slug: "org_1", name: "org_1" }]);
    expect(body.expires_in).toBe(300);

    // The token is the person: their own accounts, through the tools route.
    const mine = await call(
      "org_1/tools/CHANNEL_ACCOUNT_LIST",
      {},
      { bearer: body.token },
    );
    expect(mine.status).toBe(200);
    expect(
      ((await mine.json()) as { accounts: { accountId: string }[] }).accounts,
    ).toMatchObject([{ accountId: "T1:U1" }]);

    // Bound to the org it was asked for.
    const other = await call(
      "org_456/tools/CHANNEL_ACCOUNT_LIST",
      {},
      { bearer: body.token },
    );
    expect(other.status).toBe(403);

    // With the person's role, no more: a plain member's token manages nothing.
    const admin = await call(
      "org_1/tools/ORGANIZATION_SETTINGS_UPDATE",
      { organizationId: "org_1" },
      { bearer: body.token },
    );
    expect(admin.status).toBe(403);

    const [row] = await database.db
      .selectFrom("channel_accounts")
      .select("last_used_at")
      .execute();
    expect(row?.last_used_at).not.toBeNull();
  });

  it("can't connect an account with the token it was given", async () => {
    await connect("org_1", "user_1");
    const { token } = (await (
      await call("org_1/internal/channel-accounts/token", ana)
    ).json()) as { token: string };
    const opened = await call(
      "org_1/internal/channel-accounts/claims",
      claim({ account_id: "T1:U2", account_name: "Someone else" }),
    );
    const id = ((await opened.json()) as { url: string }).url.split("/").at(-1);
    const res = await call(
      "org_1/tools/CHANNEL_ACCOUNT_CONNECT",
      { id },
      { bearer: token },
    );
    expect(res.status).toBe(403);
    expect(
      await accounts.get({ channel: "slack", accountId: "T1:U2" }),
    ).toBeNull();
  });

  it("gives no token in an org the person isn't a member of", async () => {
    // Connected in org_456 by its owner; org_1 asks for the same account.
    await connect("org_456", "user_123");
    const res = await call("org_1/internal/channel-accounts/token", ana);
    expect(res.status).toBe(404);
    const home = await call("org_456/internal/channel-accounts/token", ana);
    expect(home.status).toBe(200);
  });

  it("disconnects accounts of its own org, one or a whole workspace", async () => {
    await connect("org_1", "user_1");
    const elsewhere = await call(
      "org_456/internal/channel-accounts",
      { channel: "slack", account_prefix: "T1:" },
      { method: "DELETE" },
    );
    expect(await elsewhere.json()).toEqual({ disconnected: 0 });
    const res = await call(
      "org_1/internal/channel-accounts",
      { channel: "slack", account_prefix: "T1:" },
      { method: "DELETE" },
    );
    expect(await res.json()).toEqual({ disconnected: 1 });
    const token = await call("org_1/internal/channel-accounts/token", ana);
    expect(token.status).toBe(404);
  });
});
