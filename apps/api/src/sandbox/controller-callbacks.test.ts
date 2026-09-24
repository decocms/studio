import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantPool } from "@decocms/sandbox/provider/tenant-pools";
import type { CloneCredentialSource } from "@/storage/sandbox-runner-state";
import {
  cloneUrlIdentity,
  createSandboxControllerCallbackApp,
  serveSandboxControllerCallbacks,
  type SandboxControllerCallbackDeps,
} from "./controller-callbacks";

const CONNECTION = "conn_1";
const REPOSITORY = "repo_1";
const ACME_SITE = "https://x-access-token:ghs_old@github.com/acme/site.git";

function row(repo: Record<string, string>) {
  return { token: "t", ensureOpts: { repo: { userName: "u", ...repo } } };
}

function setup(
  opts: {
    states?: unknown[];
    tenantStates?: unknown[];
    pools?: TenantPool[];
    mint?: SandboxControllerCallbackDeps["mintCloneUrl"];
  } = {},
) {
  const sources: CloneCredentialSource[] = [];
  const mints: Array<
    Parameters<SandboxControllerCallbackDeps["mintCloneUrl"]>
  > = [];
  const orgFsMints: Array<{ orgId: string; userId: string; orgSlug?: string }> =
    [];
  const app = createSandboxControllerCallbackApp({
    statesByCloneSource: async (source) => {
      sources.push(source);
      return opts.states ?? [];
    },
    statesByTenant: async () => opts.tenantStates ?? [],
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

describe("clone-url callback", () => {
  it("mints for a connection a live sandbox already clones with", async () => {
    const { post, mints, sources } = setup({
      states: [
        row({
          cloneUrl: "https://x-access-token:ghs_first@github.com/Acme/Site",
          connectionId: CONNECTION,
        }),
      ],
    });
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
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

  it("verifies a first-class repository by its id, not the connection", async () => {
    const { post, sources } = setup({
      states: [row({ cloneUrl: ACME_SITE, repositoryId: REPOSITORY })],
    });
    const res = await post(CLONE, {
      repositoryId: REPOSITORY,
      connectionId: "conn_other",
      cloneUrl: ACME_SITE,
    });
    expect(res.status).toBe(200);
    expect(sources).toEqual([{ repositoryId: REPOSITORY }]);
  });

  it("mints for a configured warm pool, which has no state row", async () => {
    const { post } = setup({
      pools: [
        {
          name: "tenant-acme",
          orgId: "org_1",
          repo: "Acme/Site",
          connectionId: CONNECTION,
          branch: "main",
          workload: { runtime: "node" },
        },
      ],
    });
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
    });
    expect(res.status).toBe(200);
  });

  it.each([
    [
      "a connection no sandbox uses",
      [row({ cloneUrl: ACME_SITE, connectionId: "conn_other" })],
    ],
    [
      "another repository on the same connection",
      [
        row({
          cloneUrl: "https://github.com/acme/other.git",
          connectionId: CONNECTION,
        }),
      ],
    ],
    [
      "the same repository on another host",
      [
        row({
          cloneUrl: "https://gitlab.com/acme/site.git",
          connectionId: CONNECTION,
        }),
      ],
    ],
    ["a row whose state does not parse", [{ ensureOpts: { repo: "nope" } }]],
    ["no rows at all", []],
  ])("refuses %s without minting", async (_label, states) => {
    const { post, mints } = setup({ states });
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
    });
    expect(res.status).toBe(403);
    expect(mints).toEqual([]);
  });

  it("does not let a warm pool vouch for a repository id", async () => {
    const { post } = setup({
      pools: [
        {
          name: "tenant-acme",
          orgId: "org_1",
          repo: "acme/site",
          connectionId: CONNECTION,
          branch: "main",
          workload: { runtime: "node" },
        },
      ],
    });
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
    ["a non-JSON body", "{nope"],
  ])("rejects %s", async (_label, body) => {
    const { post, mints } = setup({
      states: [row({ cloneUrl: ACME_SITE, connectionId: CONNECTION })],
    });
    const res = await post(CLONE, body);
    expect(res.status).toBe(400);
    expect(mints).toEqual([]);
  });

  it("answers null when the mint fails, so the controller keeps its URL", async () => {
    const { post } = setup({
      states: [row({ cloneUrl: ACME_SITE, connectionId: CONNECTION })],
      mint: async () => {
        throw new Error("legacy token needs an org context");
      },
    });
    const res = await post(CLONE, {
      connectionId: CONNECTION,
      cloneUrl: ACME_SITE,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cloneUrl: null });
  });
});

describe("org-fs-config callback", () => {
  const tenantRow = {
    tenant: { orgId: "org_1", userId: "user_1", orgSlug: "acme" },
    ensureOpts: { orgFsConfigJson: '{"token":"old"}' },
  };

  it("mints for the tenant the sandbox was provisioned for", async () => {
    const { post, orgFsMints } = setup({ tenantStates: [tenantRow] });
    const res = await post(ORG_FS, {
      tenant: { orgId: "org_1", userId: "user_1", orgSlug: "someone-else" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgFsConfigJson: '{"token":"fresh"}' });
    expect(orgFsMints).toEqual([
      { orgId: "org_1", userId: "user_1", orgSlug: "acme" },
    ]);
  });

  it.each([
    ["no sandbox for the tenant", []],
    [
      "a sandbox without org-fs",
      [{ tenant: { orgId: "org_1", userId: "user_1" }, ensureOpts: {} }],
    ],
    [
      "a row for another user",
      [{ ...tenantRow, tenant: { orgId: "org_1", userId: "user_2" } }],
    ],
  ])("refuses %s", async (_label, tenantStates) => {
    const { post, orgFsMints } = setup({ tenantStates });
    const res = await post(ORG_FS, {
      tenant: { orgId: "org_1", userId: "user_1" },
    });
    expect(res.status).toBe(403);
    expect(orgFsMints).toEqual([]);
  });

  it("rejects a tenant without ids", async () => {
    const { post } = setup({ tenantStates: [tenantRow] });
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

    const { app } = setup({
      states: [row({ cloneUrl: ACME_SITE, connectionId: CONNECTION })],
    });
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
      body: JSON.stringify({ connectionId: CONNECTION, cloneUrl: ACME_SITE }),
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
