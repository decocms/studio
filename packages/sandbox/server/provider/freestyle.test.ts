import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Freestyle, FreestyleApiError } from "freestyle";
import { sleep } from "@decocms/shared/std";
import { FreestyleSandboxProvider } from "./freestyle";

const ID = { userId: "u1", projectRef: "agent:org:vmcp:feature-x" };
const realFetch = globalThis.fetch;

/** Every daemon call answers 200. */
beforeEach(() => {
  globalThis.fetch = Object.assign(async () => Response.json({}), {
    preconnect: realFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeClient(opts: { autoDeleteCap?: boolean } = {}) {
  const creates: Record<string, unknown>[] = [];
  const vm = {
    exec: async () => ({ statusCode: 0, stdout: "" }),
    delete: async () => {},
  };
  const client = {
    vms: {
      get: async () => {
        throw new FreestyleApiError(404, { code: "NOT_FOUND" });
      },
      snapshots: { get: async () => ({}) },
      create: async (options: Record<string, unknown>) => {
        creates.push(options);
        if (opts.autoDeleteCap && options.autoDeleteSeconds !== undefined) {
          throw new FreestyleApiError(400, { code: "INVALID_REQUEST" });
        }
        return { vm };
      },
    },
  };
  return { client: client as unknown as Freestyle, creates };
}

describe("FreestyleSandboxProvider", () => {
  test("creates VMs that are deleted after a day paused", async () => {
    const { client, creates } = fakeClient();
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(creates.at(-1)?.autoDeleteSeconds).toBe(24 * 60 * 60);
    provider.close();
  });

  test("takes the plan's cap when it refuses autoDeleteSeconds", async () => {
    const { client, creates } = fakeClient({ autoDeleteCap: true });
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(creates.at(-1)).not.toHaveProperty("autoDeleteSeconds");
    provider.close();
  });

  test("warm caches each namespace mode in a separate base snapshot", async () => {
    const snapshots: string[] = [];
    const exec: string[] = [];
    const vm = {
      exec: async ({ command }: { command: string }) => {
        exec.push(command);
        return { statusCode: 0, stdout: "" };
      },
      snapshot: async ({ slug }: { slug: string }) => {
        snapshots.push(slug);
      },
      delete: async () => {},
    };
    const client = {
      vms: {
        snapshots: {
          get: async (slug: string) => {
            if (snapshots.includes(slug)) return {};
            throw new FreestyleApiError(404, { code: "NOT_FOUND" });
          },
        },
        create: async () => ({ vm }),
      },
    } as unknown as Freestyle;
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client,
      image: "example/sandbox:1",
    });
    await Promise.all([provider.warm(), provider.warm()]);
    await provider.warm();
    expect(snapshots).toHaveLength(1);
    expect(exec.some((c) => c.includes("example/sandbox:1"))).toBe(true);
    const ordinaryRun = exec.find((c) =>
      c.startsWith("docker run -d --name sandbox"),
    );
    expect(ordinaryRun).not.toContain("seccomp=unconfined");
    expect(ordinaryRun).not.toContain("apparmor=unconfined");
    const nested = new FreestyleSandboxProvider({
      apiKey: "k",
      client,
      image: "example/sandbox:1",
      allowUserNamespaces: true,
    });
    await nested.warm();
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots).size).toBe(2);
    const nestedRun = exec.findLast((c) =>
      c.startsWith("docker run -d --name sandbox"),
    );
    expect(nestedRun).toContain("--security-opt seccomp=unconfined");
    expect(nestedRun).toContain("--security-opt apparmor=unconfined");
    nested.close();
    provider.close();
  });

  test("warm swallows a failed build", async () => {
    const client = {
      vms: {
        snapshots: {
          get: async () => {
            throw new FreestyleApiError(500, { code: "INTERNAL" });
          },
        },
      },
    } as unknown as Freestyle;
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.warm();
    provider.close();
  });
});

describe("pauseIdle", () => {
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const vm = (slug: string, extra: Record<string, unknown> = {}) => ({
    id: `id-${slug}`,
    slug,
    state: "running",
    metadata: { "studio-daemon-token": "t" },
    createdAt: old,
    ...extra,
  });

  test("pauses only VMs whose daemon has been unused for idlePauseMs", async () => {
    const idle: Record<string, number> = {
      quiet: 11 * 60_000,
      busy: 30_000,
      fresh: 60 * 60_000,
      foreign: 60 * 60_000,
    };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).hostname.split(".")[0]!;
        if (host === "silent") throw new Error("unreachable");
        return Response.json({ idleMs: idle[host] });
      },
      { preconnect: realFetch.preconnect },
    );
    const pauses: string[] = [];
    const client = {
      vms: {
        list: async () => ({
          vms: [
            vm("quiet"),
            vm("busy"),
            vm("silent"),
            vm("fresh", { createdAt: new Date().toISOString() }),
            vm("foreign", { metadata: {} }),
          ],
        }),
        ref: (id: string) => ({
          pause: async () => {
            pauses.push(id);
          },
        }),
      },
    } as unknown as Freestyle;
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client,
      idlePauseMs: 10 * 60_000,
    });
    expect(await provider.pauseIdle()).toEqual(["quiet"]);
    expect(pauses).toEqual(["id-quiet"]);
    provider.close();
  });

  test("swallows a failed listing", async () => {
    const client = {
      vms: {
        list: async () => {
          throw new FreestyleApiError(500, { code: "INTERNAL" });
        },
      },
    } as unknown as Freestyle;
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    expect(await provider.pauseIdle()).toEqual([]);
    provider.close();
  });
});

describe("releaseAfter", () => {
  test("pauses only a daemon that stayed unused through the grace", async () => {
    const idle: Record<string, number> = { quiet: 60_000, busy: 10 };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).hostname.split(".")[0]!;
        if (host === "silent") throw new Error("unreachable");
        return Response.json({ idleMs: idle[host] });
      },
      { preconnect: realFetch.preconnect },
    );
    const pauses: string[] = [];
    const client = {
      vms: {
        get: async (slug: string) => ({
          id: `id-${slug}`,
          metadata: { "studio-daemon-token": "t" },
        }),
        ref: (id: string) => ({
          pause: async () => {
            pauses.push(id);
          },
        }),
      },
    } as unknown as Freestyle;
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client,
      idlePauseMs: 0,
    });
    for (const handle of ["quiet", "busy", "silent"]) {
      await provider.releaseAfter(handle, 50);
    }
    await sleep(150);
    expect(pauses).toEqual(["id-quiet"]);
    provider.close();
  });
});

describe("resume reclaims a daemon that lost its claim", () => {
  const TOKEN = "vm-token";
  function existingVm() {
    const execs: string[] = [];
    const client = {
      vms: {
        get: async (slug: string) => ({
          id: `id-${slug}`,
          metadata: { "studio-daemon-token": TOKEN },
        }),
        ref: () => ({
          data: async () => ({
            state: "running",
            sourceSnapshotSlugAtCreate: "studio-sandbox-abc",
            metadata: {},
          }),
          exec: async ({ command }: { command: string }) => {
            execs.push(command);
            return { statusCode: 0, stdout: "" };
          },
        }),
      },
    } as unknown as Freestyle;
    return { client, execs };
  }

  /** `config` answers each /_sandbox/config call in turn; /health is up. */
  function daemon(config: ((auth: string) => Response)[]) {
    const calls: { auth: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/_sandbox/config")) {
          return Response.json({});
        }
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        calls.push({ auth, body: JSON.parse(String(init?.body)) });
        const answer = config[calls.length - 1];
        if (!answer) throw new Error("no answer scripted");
        return answer(auth);
      },
      { preconnect: realFetch.preconnect },
    );
    return calls;
  }

  test("a daemon that still holds its token keeps it", async () => {
    const { client, execs } = existingVm();
    const calls = daemon([() => new Response("no", { status: 401 })]);
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).not.toBe(`Bearer ${TOKEN}`);
    expect(execs).toEqual([]);
    provider.close();
  });

  test("a rebooted daemon is claimed again with the VM's token", async () => {
    const { client, execs } = existingVm();
    const calls = daemon([() => Response.json({})]);
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(calls[0]!.body.auth).toEqual({ rotateToken: TOKEN });
    expect(execs).toEqual([]);
    provider.close();
  });

  test("a guest whose writes hang is rebooted, then claimed", async () => {
    const { client, execs } = existingVm();
    const calls = daemon([
      () => {
        throw new Error("The operation timed out.");
      },
      () => Response.json({}),
    ]);
    const provider = new FreestyleSandboxProvider({ apiKey: "k", client });
    await provider.ensure(ID);
    expect(execs).toEqual(["reboot -f"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.auth).toEqual({ rotateToken: TOKEN });
    provider.close();
  });
});

describe("repo snapshots", () => {
  const TOKEN = "ghs_secret";
  const CLONE_URL = `https://x-access-token:${TOKEN}@github.com/acme/site.git`;
  const TENANT = { orgId: "org-1", userId: "u1" };
  const REPO = {
    cloneUrl: CLONE_URL,
    branch: "thread-branch",
    userName: "u",
    userEmail: "u@example.com",
  };

  function client(opts: { tokenLeft?: boolean } = {}) {
    const snapshots: string[] = [];
    const creates: Record<string, unknown>[] = [];
    const posted: string[] = [];
    const commands: string[] = [];
    const vm = {
      exec: async ({
        command,
        env,
      }: {
        command: string;
        env?: Record<string, string>;
      }) => {
        commands.push(command);
        if (env?.DAEMON_BODY) posted.push(env.DAEMON_BODY);
        if (command.includes("/health")) {
          return { statusCode: 0, stdout: '{"ready":true}' };
        }
        if (command.includes("grep -rqsF")) {
          return {
            statusCode: 0,
            stdout: opts.tokenLeft ? "scan=0" : "scan=1",
          };
        }
        return { statusCode: 0, stdout: "" };
      },
      snapshot: async ({ slug }: { slug: string }) => {
        snapshots.push(slug);
      },
      delete: async () => {},
    };
    const fake = {
      vms: {
        get: async () => {
          throw new FreestyleApiError(404, { code: "NOT_FOUND" });
        },
        snapshots: {
          get: async (slug: string) => {
            if (
              slug.startsWith("studio-sandbox-") ||
              snapshots.includes(slug)
            ) {
              return {};
            }
            throw new FreestyleApiError(404, { code: "NOT_FOUND" });
          },
        },
        create: async (options: Record<string, unknown>) => {
          creates.push(options);
          return { vm };
        },
      },
    } as unknown as Freestyle;
    return { fake, snapshots, creates, posted, commands };
  }

  const ref = (name: string) => ({
    ...ID,
    projectRef: `agent:org:vmcp:${name}`,
  });

  /** The default branch's head, as the remote advertises it. */
  let head = "a".repeat(40);
  const refsRequests: { url: string; auth: string | null }[] = [];
  beforeEach(() => {
    head = "a".repeat(40);
    refsRequests.length = 0;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/info/refs")) return Response.json({});
        refsRequests.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(
          `001e# service=git-upload-pack\n0000015${head} HEAD\0multi_ack\n`,
        );
      },
      { preconnect: realFetch.preconnect },
    );
  });

  async function settled(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i++) await sleep(5);
  }

  test("the first sandbox for a repo builds its snapshot; the next forks it", async () => {
    const { fake, snapshots, creates, posted, commands } = client();
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client: fake,
    });

    const first = await provider.ensure(ref("a"), {
      tenant: TENANT,
      repo: REPO,
      repoSnapshot: true,
    });
    expect(first.warmPoolAdopted).toBe(false);
    await settled(() => snapshots.length > 0);
    expect(snapshots).toHaveLength(1);
    // Built from the default branch with the credential, snapshotted without it.
    const built = posted.filter((b) => !b.includes("thread-branch"));
    expect(built.at(0)).toContain(TOKEN);
    expect(built.at(-1)).not.toContain(TOKEN);
    // A fork's branch checkout refuses the tree install left dirty.
    expect(commands.some((c) => c.includes("reset -q --hard HEAD"))).toBe(true);

    const second = await provider.ensure(ref("b"), {
      tenant: TENANT,
      repo: REPO,
      repoSnapshot: true,
    });
    expect(creates.at(-1)?.snapshotId).toBe(snapshots[0]);
    expect(second.warmPoolAdopted).toBe(true);

    // Another org never forks it.
    await provider.ensure(ref("c"), {
      tenant: { ...TENANT, orgId: "org-2" },
      repo: REPO,
      repoSnapshot: true,
    });
    expect(String(creates.at(-1)?.snapshotId)).toStartWith("studio-sandbox-");
    provider.close();
  });

  test("a push to the default branch rebuilds; meanwhile sandboxes fork the previous head's", async () => {
    const { fake, snapshots, creates } = client();
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client: fake,
    });
    const opts = { tenant: TENANT, repo: REPO, repoSnapshot: true };
    // Builds create VMs too; a sandbox's is the one with a slug.
    const forked = () => creates.filter((c) => c.slug).at(-1)?.snapshotId;
    await provider.ensure(ref("a"), opts);
    await settled(() => snapshots.length === 1);
    const [first] = snapshots;

    await provider.ensure(ref("b"), opts);
    expect(forked()).toBe(first);
    expect(snapshots).toHaveLength(1);

    head = "b".repeat(40);
    await provider.ensure(ref("c"), opts);
    expect(forked()).toBe(first);
    await settled(() => snapshots.length === 2);
    expect(snapshots[1]).not.toBe(first);

    await provider.ensure(ref("d"), opts);
    expect(forked()).toBe(snapshots[1]);
    // The credential rides in the header, never in the URL.
    expect(refsRequests.every((r) => !r.url.includes(TOKEN))).toBe(true);
    expect(atob(refsRequests[0]!.auth!.slice("Basic ".length))).toContain(
      TOKEN,
    );
    provider.close();
  });

  test("builds nothing unless asked, nor for a run with no dev server", async () => {
    const { fake, snapshots } = client();
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client: fake,
    });
    await provider.ensure(ref("a"), { tenant: TENANT, repo: REPO });
    await provider.ensure(ref("b"), {
      tenant: TENANT,
      repo: REPO,
      repoSnapshot: true,
      cloneOnly: true,
    });
    await sleep(50);
    expect(snapshots).toHaveLength(0);
    provider.close();
  });

  test("a credential left on disk is never snapshotted, nor retried at once", async () => {
    const { fake, snapshots, creates } = client({ tokenLeft: true });
    const provider = new FreestyleSandboxProvider({
      apiKey: "k",
      client: fake,
    });
    const opts = { tenant: TENANT, repo: REPO, repoSnapshot: true };
    await provider.ensure(ref("a"), opts);
    await sleep(50);
    const builds = creates.filter((c) => !c.slug).length;
    await provider.ensure(ref("b"), opts);
    await sleep(50);
    expect(snapshots).toHaveLength(0);
    expect(creates.filter((c) => !c.slug).length).toBe(builds);
    provider.close();
  });
});
