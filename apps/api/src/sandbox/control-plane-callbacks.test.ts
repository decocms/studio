import { describe, expect, it } from "bun:test";
import type { TenantPool } from "@decocms/sandbox/provider/agent-sandbox";
import { type CallbackGrantScope, signCallbackGrant } from "./callback-grant";
import {
  type CloneCredentialSource,
  createSandboxCallbackApp,
  type SandboxCallbackDeps,
} from "./control-plane-callbacks";

const CONNECTION = "conn_1";
const REPOSITORY = "repo_1";
const ACME_SITE = "https://x-access-token:ghs_old@github.com/acme/site.git";
const TENANT = { orgId: "org_1", userId: "user_1" };
const TOKEN = "cp-token";
const SECRET = "s".repeat(32);

function grantFor(
  scope: Partial<CallbackGrantScope> = {},
  secrets: string[] = [SECRET],
): string {
  return signCallbackGrant(
    {
      v: 1,
      ...TENANT,
      repos: [
        { connectionId: CONNECTION, repo: "acme/site" },
        { repositoryId: REPOSITORY },
      ],
      ...scope,
    },
    secrets,
  );
}
const GRANT = grantFor();

function setup(
  opts: {
    /** `orgId:userId` pairs that are members; default the one TENANT. */
    members?: string[];
    /** Credential source id → owning org; default both owned by org_1. */
    owners?: Record<string, string>;
    pools?: TenantPool[];
    mint?: SandboxCallbackDeps["mintCloneUrl"];
    secrets?: string[];
  } = {},
) {
  const members = opts.members ?? ["org_1:user_1"];
  const owners = opts.owners ?? {
    [CONNECTION]: "org_1",
    [REPOSITORY]: "org_1",
  };
  const sources: CloneCredentialSource[] = [];
  const mints: Array<Parameters<SandboxCallbackDeps["mintCloneUrl"]>> = [];
  const orgFsMints: Array<{ orgId: string; userId: string; orgSlug?: string }> =
    [];
  const app = createSandboxCallbackApp({
    token: TOKEN,
    grantSecrets: opts.secrets ?? [SECRET],
    recordedTenant: async ({ orgId, userId }) =>
      members.includes(`${orgId}:${userId}`)
        ? { orgId, userId, orgSlug: "acme" }
        : null,
    credentialOrg: async (source) => {
      sources.push(source);
      const key =
        "repositoryId" in source ? source.repositoryId : source.connectionId;
      return owners[key] ?? null;
    },
    tenantPools: opts.pools ?? [],
    mintCloneUrl:
      opts.mint ??
      (async (...args) => {
        mints.push(args);
        return "https://x-access-token:ghs_new@github.com/acme/site.git";
      }),
    mintOrgFsConfig: async (tenant) => {
      orgFsMints.push(tenant);
      return '{"token":"fresh"}';
    },
  });
  const post = (path: string, body: unknown, token = TOKEN) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, post, sources, mints, orgFsMints };
}

const CLONE = "/api/sandbox-callbacks/clone-url";
const ORG_FS = "/api/sandbox-callbacks/org-fs-config";

const pool: TenantPool = {
  name: "tenant-acme",
  orgId: "org_1",
  repo: "Acme/Site",
  connectionId: CONNECTION,
  branch: "main",
  workload: { runtime: "node" },
};

describe.each([CLONE, ORG_FS])("%s", (path) => {
  it.each(["wrong", ""])(
    "refuses bearer %p before reading the body",
    async (token) => {
      const { post, mints, orgFsMints, sources } = setup();
      const res = await post(
        path,
        { connectionId: CONNECTION, cloneUrl: ACME_SITE, tenant: TENANT },
        token,
      );
      expect(res.status).toBe(401);
      expect([...mints, ...orgFsMints, ...sources]).toEqual([]);
    },
  );
});

describe("clone-url callback", () => {
  it("mints for a connection of the tenant's org", async () => {
    const { post, mints, sources } = setup();
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      tenant: TENANT,
      bufferMs: 1_800_000,
      grant: GRANT,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cloneUrl: "https://x-access-token:ghs_new@github.com/acme/site.git",
    });
    expect(sources).toEqual([{ connectionId: CONNECTION }]);
    expect(mints).toEqual([
      [
        {
          cloneUrl: ACME_SITE,
          connectionId: CONNECTION,
          repositoryId: undefined,
        },
        { bufferMs: 1_800_000 },
      ],
    ]);
  });

  it("checks a first-class repository by its id, not the connection", async () => {
    const { post, sources } = setup({
      owners: { [REPOSITORY]: "org_1", conn_other: "org_2" },
    });
    const res = await post(CLONE, {
      repositoryId: REPOSITORY,
      connectionId: "conn_other",
      cloneUrl: ACME_SITE,
      tenant: TENANT,
      grant: GRANT,
    });
    expect(res.status).toBe(200);
    expect(sources).toEqual([{ repositoryId: REPOSITORY }]);
  });

  it("mints for a configured warm pool, which has no tenant", async () => {
    const { post } = setup({ pools: [pool] });
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
    });
    expect(res.status).toBe(200);
  });

  it.each([
    [
      "a connection of another org",
      { owners: { [CONNECTION]: "org_2" } },
      TENANT,
    ],
    ["a connection that does not exist", { owners: {} }, TENANT],
    ["a user who is not a member", { members: [] }, TENANT],
    [
      "a member of another org naming this org's connection",
      { members: ["org_2:user_1"] },
      { orgId: "org_2", userId: "user_1" },
    ],
  ])("refuses %s without minting", async (_label, opts, tenant) => {
    const { post, mints } = setup(opts);
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      tenant,
      grant: grantFor(tenant),
    });
    expect(res.status).toBe(403);
    expect(mints).toEqual([]);
  });

  it.each([
    ["no tenant, no grant and no pool", {}],
    ["a tenant but no grant", { tenant: TENANT }],
    [
      "a grant signed with another secret",
      { tenant: TENANT, grant: grantFor({}, ["x".repeat(32)]) },
    ],
    [
      "a grant whose scope was edited after signing",
      {
        tenant: TENANT,
        grant: `${Buffer.from(
          JSON.stringify({ v: 1, orgId: "org_1", userId: "user_1", repos: [] }),
        ).toString("base64url")}.${GRANT.split(".")[1]}`,
      },
    ],
    ["a grant that is not one", { tenant: TENANT, grant: "nope" }],
    [
      "a grant for another repo on the same connection",
      {
        tenant: TENANT,
        grant: grantFor({
          repos: [{ connectionId: CONNECTION, repo: "acme/other" }],
        }),
      },
    ],
    [
      "a grant for the same repo on another connection",
      {
        tenant: TENANT,
        grant: grantFor({
          repos: [{ connectionId: "conn_other", repo: "acme/site" }],
        }),
      },
    ],
    [
      "a grant for another tenant",
      { tenant: TENANT, grant: grantFor({ userId: "user_2" }) },
    ],
  ])("refuses %s without minting", async (_label, body) => {
    const { post, mints, sources } = setup();
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      ...body,
    });
    expect(res.status).toBe(403);
    expect([...mints, ...sources]).toEqual([]);
  });

  it("refuses a repository id the grant does not name", async () => {
    const { post, mints } = setup({ owners: { repo_2: "org_1" } });
    const res = await post(CLONE, {
      repositoryId: "repo_2",
      cloneUrl: ACME_SITE,
      tenant: TENANT,
      grant: GRANT,
    });
    expect(res.status).toBe(403);
    expect(mints).toEqual([]);
  });

  it("reads the tenant from the grant when the request names none", async () => {
    const { post } = setup();
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      grant: GRANT,
    });
    expect(res.status).toBe(200);
  });

  it("verifies a grant from a secret still in rotation, not after it leaves", async () => {
    const old = "o".repeat(32);
    const body = {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      tenant: TENANT,
      grant: grantFor({}, [old]),
    };
    const rotating = setup({ secrets: [SECRET, old] });
    expect((await rotating.post(CLONE, body)).status).toBe(200);
    const rotated = setup({ secrets: [SECRET] });
    expect((await rotated.post(CLONE, body)).status).toBe(403);
  });

  it("does not let a warm pool vouch for a repository id", async () => {
    const { post } = setup({ pools: [pool] });
    const res = await post(CLONE, {
      repositoryId: REPOSITORY,
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ["neither a connection nor a repository", { cloneUrl: ACME_SITE }],
    ["no cloneUrl", { connectionId: CONNECTION }],
    ["an empty connection id", { connectionId: "", cloneUrl: ACME_SITE }],
    [
      "an oversized cloneUrl",
      {
        connectionId: CONNECTION,
        cloneUrl: `https://github.com/${"a".repeat(5000)}`,
      },
    ],
    [
      "a negative buffer",
      { connectionId: CONNECTION, cloneUrl: ACME_SITE, bufferMs: -1 },
    ],
    [
      "an unparseable cloneUrl",
      { connectionId: CONNECTION, cloneUrl: "not a url" },
    ],
    [
      "a tenant without ids",
      { connectionId: CONNECTION, cloneUrl: ACME_SITE, tenant: { orgId: "o" } },
    ],
    ["a non-JSON body", "{nope"],
    [
      "an oversized grant",
      {
        connectionId: CONNECTION,
        cloneUrl: ACME_SITE,
        grant: "g".repeat(20_000),
      },
    ],
  ])("rejects %s", async (_label, body) => {
    const { post, mints } = setup();
    const res = await post(CLONE, body);
    expect(res.status).toBe(400);
    expect(mints).toEqual([]);
  });

  it("answers null when the mint fails, so the runner keeps its URL", async () => {
    const { post } = setup({
      mint: async () => {
        throw new Error("legacy token needs an org context");
      },
    });
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      tenant: TENANT,
      grant: GRANT,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cloneUrl: null });
  });
});

describe("org-fs-config callback", () => {
  it("mints for the tenant Studio records, slug included", async () => {
    const { post, orgFsMints } = setup();
    const res = await post(ORG_FS, {
      tenant: { ...TENANT, orgSlug: "someone-else" },
      grant: GRANT,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgFsConfigJson: '{"token":"fresh"}' });
    expect(orgFsMints).toEqual([{ ...TENANT, orgSlug: "acme" }]);
  });

  it.each([
    ["a user who is not a member", { orgId: "org_1", userId: "user_2" }],
    ["an org the user is not in", { orgId: "org_2", userId: "user_1" }],
  ])("refuses %s", async (_label, tenant) => {
    const { post, orgFsMints } = setup();
    const res = await post(ORG_FS, { tenant, grant: grantFor(tenant) });
    expect(res.status).toBe(403);
    expect(orgFsMints).toEqual([]);
  });

  it.each([
    ["no grant", {}],
    ["a forged grant", { grant: grantFor({}, ["x".repeat(32)]) }],
    ["a grant for another tenant", { grant: grantFor({ orgId: "org_2" }) }],
  ])("refuses %s", async (_label, body) => {
    const { post, orgFsMints } = setup({
      members: ["org_1:user_1", "org_2:user_1"],
    });
    const res = await post(ORG_FS, { tenant: TENANT, ...body });
    expect(res.status).toBe(403);
    expect(orgFsMints).toEqual([]);
  });

  it("rejects a tenant without ids", async () => {
    const { post } = setup();
    expect((await post(ORG_FS, { tenant: { orgId: "org_1" } })).status).toBe(
      400,
    );
  });
});
