import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { ChannelAccountStorage } from "./channel-accounts";

describe("ChannelAccountStorage", () => {
  let database: StudioDatabase;
  let accounts: ChannelAccountStorage;
  const orgId = "org_channels_test";
  const otherOrg = "org_channels_other";
  const ana = "user_channels_ana";
  const bia = "user_channels_bia";

  const claimFor = (accountId: string, org = orgId) => ({
    organizationId: org,
    channel: "slack",
    accountId,
    accountName: "Ana",
    accountWhere: "Acme",
    accountEmail: " Ana@Example.com ",
    returnUrl: "https://channels.example/studio/connected?c=1",
  });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    accounts = new ChannelAccountStorage(database.db);
    const now = new Date().toISOString();
    for (const id of [orgId, otherOrg]) {
      await sql`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${id}, ${id}, ${id}, ${now})
      `.execute(database.db);
    }
    for (const id of [ana, bia]) {
      await sql`
        INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
        VALUES (${id}, ${`${id}@example.com`}, false, ${id}, ${now}, ${now})
      `.execute(database.db);
    }
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("a claim is read only in its own org, with the email normalized", async () => {
    const claim = await accounts.createClaim(claimFor("T1:U1"));
    expect(claim.accountEmail).toBe("ana@example.com");
    expect(await accounts.getClaim(orgId, claim.id)).toMatchObject({
      channel: "slack",
      accountId: "T1:U1",
      accountName: "Ana",
      accountWhere: "Acme",
    });
    expect(await accounts.getClaim(otherOrg, claim.id)).toBeNull();
  });

  test("a new link for the same account replaces the old one", async () => {
    const first = await accounts.createClaim(claimFor("T1:U2"));
    const second = await accounts.createClaim(claimFor("T1:U2"));
    expect(await accounts.getClaim(orgId, first.id)).toBeNull();
    expect(await accounts.getClaim(orgId, second.id)).not.toBeNull();
  });

  test("connecting spends the claim once and links the account to the person", async () => {
    const claim = await accounts.createClaim(claimFor("T1:U3"));
    // Another org's member can't spend it.
    expect(await accounts.connect(otherOrg, claim.id, bia)).toBeNull();
    const connected = await accounts.connect(orgId, claim.id, ana);
    expect(connected).toMatchObject({
      returnUrl: "https://channels.example/studio/connected?c=1",
      account: {
        channel: "slack",
        accountId: "T1:U3",
        userId: ana,
        organizationId: orgId,
        lastUsedAt: null,
      },
    });
    expect(await accounts.connect(orgId, claim.id, bia)).toBeNull();
    expect(await accounts.getClaim(orgId, claim.id)).toBeNull();
    expect(
      await accounts.get({ channel: "slack", accountId: "T1:U3" }),
    ).toMatchObject({ userId: ana });
  });

  test("an expired claim connects nothing", async () => {
    const claim = await accounts.createClaim(claimFor("T1:U4"));
    await sql`
      UPDATE channel_account_claims SET expires_at = now() - interval '1 second'
      WHERE id = ${claim.id}
    `.execute(database.db);
    expect(await accounts.getClaim(orgId, claim.id)).toBeNull();
    expect(await accounts.connect(orgId, claim.id, ana)).toBeNull();
    expect(
      await accounts.get({ channel: "slack", accountId: "T1:U4" }),
    ).toBeNull();
  });

  test("an account connected again becomes the new person's", async () => {
    const claim = await accounts.createClaim(claimFor("T1:U3"));
    await accounts.touch({ channel: "slack", accountId: "T1:U3" });
    await accounts.connect(orgId, claim.id, bia);
    expect(
      await accounts.get({ channel: "slack", accountId: "T1:U3" }),
    ).toMatchObject({ userId: bia, lastUsedAt: null });
    expect(await accounts.listForUser(ana)).toEqual([]);
  });

  test("a person lists and disconnects only their own accounts", async () => {
    const ref = { channel: "slack", accountId: "T1:U3" };
    expect((await accounts.listForUser(bia)).map((a) => a.accountId)).toEqual([
      "T1:U3",
    ]);
    expect(await accounts.disconnectOwn(ana, ref)).toBe(false);
    expect(await accounts.disconnectOwn(bia, ref)).toBe(true);
    expect(await accounts.get(ref)).toBeNull();
  });

  test("the service disconnects a workspace by prefix, in its own org only", async () => {
    for (const [id, org, user] of [
      ["T2:U1", orgId, ana],
      ["T2:U2", orgId, bia],
      ["T2_:U3", orgId, ana],
      ["T2:U9", otherOrg, bia],
    ] as const) {
      const claim = await accounts.createClaim(claimFor(id, org));
      await accounts.connect(org, claim.id, user);
    }
    expect(
      await accounts.disconnectInOrg(orgId, "slack", { accountPrefix: "T2:" }),
    ).toBe(2);
    // `_` in a prefix is a literal, not a wildcard.
    expect(
      await accounts.disconnectInOrg(orgId, "slack", { accountPrefix: "T2_" }),
    ).toBe(1);
    expect(
      await accounts.get({ channel: "slack", accountId: "T2:U9" }),
    ).not.toBeNull();
    expect(
      await accounts.disconnectInOrg(orgId, "slack", { accountId: "T2:U9" }),
    ).toBe(0);
  });

  test("deleting the person removes their accounts", async () => {
    const claim = await accounts.createClaim(claimFor("T3:U1"));
    await accounts.connect(orgId, claim.id, ana);
    await sql`DELETE FROM "user" WHERE id = ${ana}`.execute(database.db);
    expect(
      await accounts.get({ channel: "slack", accountId: "T3:U1" }),
    ).toBeNull();
  });
});
