import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantPool } from "@decocms/sandbox/provider/tenant-pools";
import {
  type CloneCredentialSource,
  cloneUrlIdentity,
  createSandboxControllerCallbackApp,
  serveSandboxControllerCallbacks,
  type SandboxControllerCallbackDeps,
} from "./controller-callbacks";

const CONNECTION = "conn_1";
const REPOSITORY = "repo_1";
const ACME_SITE = "https://x-access-token:ghs_old@github.com/acme/site.git";
const TENANT = { orgId: "org_1", userId: "user_1" };

function setup(
  opts: {
    /** `orgId:userId` pairs that are members; default the one TENANT. */
    members?: string[];
    /** Credential source id → owning org; default both owned by org_1. */
    owners?: Record<string, string>;
    pools?: TenantPool[];
    mint?: SandboxControllerCallbackDeps["mintCloneUrl"];
  } = {},
) {
  const members = opts.members ?? ["org_1:user_1"];
  const owners = opts.owners ?? {
    [CONNECTION]: "org_1",
    [REPOSITORY]: "org_1",
  };
  const sources: CloneCredentialSource[] = [];
  const mints: Array<
    Parameters<SandboxControllerCallbackDeps["mintCloneUrl"]>
  > = [];
  const orgFsMints: Array<{ orgId: string; userId: string; orgSlug?: string }> =
    [];
  const app = createSandboxControllerCallbackApp({
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
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, post, sources, mints, orgFsMints };
}

const CLONE = "/api/_sandbox-controller/clone-url";
const ORG_FS = "/api/_sandbox-controller/org-fs-config";

const pool: TenantPool = {
  name: "tenant-acme",
  orgId: "org_1",
  repo: "Acme/Site",
  connectionId: CONNECTION,
  branch: "main",
  workload: { runtime: "node" },
};

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

  it("answers null when the mint fails, so the controller keeps its URL", async () => {
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

describe("cloneUrlIdentity", () => {
  it("ignores the credential, case, trailing slash and .git", () => {
    expect(cloneUrlIdentity("https://tok@GitHub.com/Acme/Site.git/")).toBe(
      "github.com/acme/site",
    );
  });

  it.each([
    "not a url",
    "ssh://git@github.com/acme/site",
    "https://github.com",
  ])("has no identity for %p", (url) => {
    expect(cloneUrlIdentity(url)).toBeNull();
  });
});

const haveOpenssl = Bun.which("openssl") !== null;

describe.skipIf(!haveOpenssl)("callback listener mTLS", () => {
  let dir = "";
  let server: ReturnType<typeof serveSandboxControllerCallbacks> | null = null;
  const pem = (f: string) => readFileSync(join(dir, f), "utf8");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "controller-callbacks-mtls-"));
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(["openssl", ...args], { cwd: dir });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    const ec = [
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
    ];
    const ca = (name: string) =>
      run(
        "req",
        "-x509",
        ...ec,
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.crt`,
        "-days",
        "1",
        "-subj",
        `/CN=${name}`,
      );
    const issue = (name: string, by: string, ext: string) => {
      writeFileSync(join(dir, `${name}.ext`), ext);
      run(
        "req",
        ...ec,
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
        "-subj",
        `/CN=${name}`,
      );
      run(
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        `${by}.crt`,
        "-CAkey",
        `${by}.key`,
        "-CAcreateserial",
        "-out",
        `${name}.crt`,
        "-days",
        "1",
        "-extfile",
        `${name}.ext`,
      );
    };
    ca("installation-ca");
    ca("other-ca");
    issue(
      "studio",
      "installation-ca",
      "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n",
    );
    issue(
      "controller",
      "installation-ca",
      "subjectAltName=DNS:sandbox-controller\nextendedKeyUsage=clientAuth\n",
    );
    issue(
      "intruder",
      "other-ca",
      "subjectAltName=DNS:sandbox-controller\nextendedKeyUsage=clientAuth\n",
    );

    const { app } = setup();
    server = serveSandboxControllerCallbacks({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: pem("studio.crt"),
        key: pem("studio.key"),
        ca: pem("installation-ca.crt"),
      },
      app,
    });
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (client?: string) =>
    fetch(`https://127.0.0.1:${server?.port}${CLONE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: CONNECTION,
        cloneUrl: ACME_SITE,
        tenant: TENANT,
      }),
      tls: {
        ca: pem("installation-ca.crt"),
        ...(client
          ? { cert: pem(`${client}.crt`), key: pem(`${client}.key`) }
          : {}),
      },
    });

  it("serves the controller's certificate", async () => {
    const res = await call("controller");
    expect(res.status).toBe(200);
  });

  it("refuses a certificate from another CA", async () => {
    await expect(call("intruder")).rejects.toThrow();
  });

  it("refuses a caller without a certificate", async () => {
    await expect(call()).rejects.toThrow();
  });
});
