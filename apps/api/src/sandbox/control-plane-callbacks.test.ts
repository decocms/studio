import { describe, expect, it } from "bun:test";
import type { TenantPool } from "@decocms/sandbox/provider/agent-sandbox";
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

function setup(
  opts: {
    /** `orgId:userId` pairs that are members; default the one TENANT. */
    members?: string[];
    /** Credential source id → owning org; default both owned by org_1. */
    owners?: Record<string, string>;
    pools?: TenantPool[];
    mint?: SandboxCallbackDeps["mintCloneUrl"];
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
    ["no tenant and no pool", {}, undefined],
  ])("refuses %s without minting", async (_label, opts, tenant) => {
    const { post, mints } = setup(opts);
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
      ...(tenant ? { tenant } : {}),
    });
    expect(res.status).toBe(403);
    expect(mints).toEqual([]);
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
    const res = await post(ORG_FS, { tenant });
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
