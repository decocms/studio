import { beforeEach, describe, expect, it } from "bun:test";
import { TenantConfigStore } from "../config-store";
import { makeConfigReadHandler, makeConfigUpdateHandler } from "./config";
import type { TenantConfig } from "../types";

const BOOT_ID = "boot-cfg-test";

function buildReq(method: "PUT" | "POST", body: object): Request {
  return new Request("http://x/_sandbox/config", {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const SEED: TenantConfig = {
  git: {
    repository: {
      cloneUrl: "https://example.com/repo.git",
      repoName: "repo",
      branch: "main",
    },
  },
  application: {
    packageManager: { name: "npm" },
    runtime: "node",
    port: 3000,
  },
};

describe("makeConfigUpdateHandler", () => {
  let store: TenantConfigStore;

  beforeEach(() => {
    store = new TenantConfigStore();
  });

  function handler() {
    return makeConfigUpdateHandler({ daemonBootId: BOOT_ID, store });
  }

  it("first POST emits bootstrap", async () => {
    const h = handler();
    const res = await h(buildReq("POST", SEED));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transition: string };
    expect(body.transition).toBe("bootstrap");
  });

  it("PUT branch=feature emits branch-change after seed", async () => {
    await store.apply(SEED);
    const h = handler();
    const res = await h(
      buildReq("PUT", { git: { repository: { branch: "feature" } } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transition: string };
    expect(body.transition).toBe("branch-change");
  });

  it("PUT port emits port-change", async () => {
    await store.apply(SEED);
    const h = handler();
    const res = await h(buildReq("PUT", { application: { port: 5173 } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transition: string };
    expect(body.transition).toBe("port-change");
  });

  it("rejects mismatched cloneUrl with 409", async () => {
    await store.apply(SEED);
    const h = handler();
    const res = await h(
      buildReq("PUT", {
        git: {
          repository: { cloneUrl: "https://example.com/different.git" },
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cloneUrl");
  });

  it("accepts matching cloneUrl in patch (no-op or downstream change)", async () => {
    await store.apply(SEED);
    const h = handler();
    const res = await h(
      buildReq("PUT", {
        git: {
          repository: { cloneUrl: "https://example.com/repo.git" },
        },
        application: { port: 4000 },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("invalid port returns 400", async () => {
    await store.apply(SEED);
    const h = handler();
    const res = await h(buildReq("PUT", { application: { port: 70000 } }));
    expect(res.status).toBe(400);
  });

  it("auth.rotateToken invokes setDaemonToken before applying patch", async () => {
    let captured: string | null = null;
    const h = makeConfigUpdateHandler({
      daemonBootId: BOOT_ID,
      store,
      setDaemonToken: (next) => {
        captured = next;
      },
    });
    const newToken = "a".repeat(48);
    const res = await h(
      buildReq("POST", { ...SEED, auth: { rotateToken: newToken } }),
    );
    expect(res.status).toBe(200);
    expect(captured).toBe(newToken);
    // Auth field MUST be stripped before persisting — TenantConfig has no auth.
    const persisted = store.read();
    expect((persisted as unknown as { auth?: unknown })?.auth).toBeUndefined();
  });

  it("auth.rotateToken too short returns 400 and does not call setter", async () => {
    let called = false;
    const h = makeConfigUpdateHandler({
      daemonBootId: BOOT_ID,
      store,
      setDaemonToken: () => {
        called = true;
      },
    });
    const res = await h(
      buildReq("POST", { ...SEED, auth: { rotateToken: "short" } }),
    );
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("auth.rotateToken without setter returns 400", async () => {
    const h = handler();
    const res = await h(
      buildReq("POST", { ...SEED, auth: { rotateToken: "a".repeat(48) } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("makeConfigReadHandler", () => {
  let store: TenantConfigStore;

  beforeEach(() => {
    store = new TenantConfigStore();
  });

  it("returns 200 with null config when no tenant config set", async () => {
    const h = makeConfigReadHandler({ daemonBootId: BOOT_ID, store });
    const res = await h();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bootId: string; config: null };
    expect(body.bootId).toBe(BOOT_ID);
    expect(body.config).toBeNull();
  });

  it("returns config + bootId when set", async () => {
    await store.apply(SEED);
    const h = makeConfigReadHandler({ daemonBootId: BOOT_ID, store });
    const res = await h();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bootId: string;
      config: TenantConfig;
    };
    expect(body.bootId).toBe(BOOT_ID);
    expect(body.config.git?.repository?.cloneUrl).toBe(
      SEED.git?.repository?.cloneUrl,
    );
  });

  it("returns repoDir when provided", async () => {
    const h = makeConfigReadHandler({
      daemonBootId: BOOT_ID,
      store,
      repoDir: "/home/user/project",
    });
    const res = await h();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoDir: string | null };
    expect(body.repoDir).toBe("/home/user/project");
  });

  it("returns null repoDir when not provided", async () => {
    const h = makeConfigReadHandler({ daemonBootId: BOOT_ID, store });
    const res = await h();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoDir: string | null };
    expect(body.repoDir).toBeNull();
  });

  it("redacts submodule credential tokens from the response", async () => {
    await store.apply({
      git: {
        repository: {
          cloneUrl: "https://example.com/repo.git",
          submoduleCredentials: [{ host: "github.com", token: "ghp_secret" }],
        },
      },
    });
    const h = makeConfigReadHandler({ daemonBootId: BOOT_ID, store });
    const res = await h();
    const text = await res.text();
    // The PAT must never cross the (browser-reachable) /config boundary.
    expect(text).not.toContain("ghp_secret");
    const body = JSON.parse(text) as { config: TenantConfig };
    expect(body.config.git?.repository?.submoduleCredentials).toBeUndefined();
    // Non-secret repository fields still round-trip.
    expect(body.config.git?.repository?.cloneUrl).toBe(
      "https://example.com/repo.git",
    );
  });
});

describe("makeConfigUpdateHandler — token redaction", () => {
  it("redacts submodule tokens from the PUT/POST config echo", async () => {
    const store = new TenantConfigStore();
    const h = makeConfigUpdateHandler({ daemonBootId: BOOT_ID, store });
    const res = await h(
      buildReq("POST", {
        git: {
          repository: {
            cloneUrl: "https://example.com/repo.git",
            submoduleCredentials: [{ host: "github.com", token: "ghp_echo" }],
          },
        },
      }),
    );
    const text = await res.text();
    expect(text).not.toContain("ghp_echo");
    // But the daemon's in-memory store keeps the token so the clone can use it.
    expect(store.read()?.git?.repository?.submoduleCredentials).toEqual([
      { host: "github.com", token: "ghp_echo" },
    ]);
  });
});
