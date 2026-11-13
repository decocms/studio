import { describe, expect, test } from "bun:test";
import {
  type BatchCall,
  type BatchOutcome,
  type ContentClient,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from "@decocms/blocks/protocol";
import { selectContentBackend } from "./content-backend";
import { NotDecoServeError } from "./deco-serve-connection";
import {
  LOCAL_RECONNECT_GRACE_FAILURES,
  localServeBackend,
  type Probe,
  probe,
  GITHUB_SITE_NOT_OWNED,
  probeGithub,
  probeHosted,
  probeSandbox,
  sandboxSiteAnswer,
  V8_PROBE_RETRY,
} from "@/cms/use-content-backend";
import { cmsUrl } from "@/cms/cms-api";

const deco1 = {
  manifest: { blocks: {} },
  schema: { definitions: {}, root: {} },
};

/** The GitHub backend answering `describe` + `schema.get` with `schema`. */
function githubServing(schema: unknown): ContentClient {
  return {
    batch: async (calls: BatchCall[]) =>
      calls.map(
        (call): BatchOutcome =>
          call.method === "describe"
            ? {
                ok: true,
                result: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION },
              }
            : {
                ok: true,
                result: {
                  notModified: false,
                  version: "s1",
                  resolvedRef: "main",
                  schema,
                },
              },
      ),
  } as unknown as ContentClient;
}

describe("the schema never decides v8: the switch does", () => {
  const schemas = [
    { major: 1, blocksMajor: 8, ...deco1 },
    { major: 1, ...deco1 },
    deco1,
    { major: 1, blocksMajor: 7, ...deco1 },
  ];

  test("GitHub mode: the hosted backend answers for any schema; the switch decides", async () => {
    for (const schema of schemas) {
      const probed = await probe(githubServing(schema));
      expect(probed.hasSchema).toBe(true);
      for (const v8 of [true, false]) {
        expect(
          selectContentBackend({
            hasProject: true,
            hasServeConnection: false,
            runtime: "cms",
            v8,
            githubSite: "ready",
          }),
        ).toBe(v8 ? "protocol-github" : "legacy");
      }
    }
  });

  test("Sandbox mode: the working tree's schema plays no part", async () => {
    for (const schema of [...schemas, null]) {
      await probe(githubServing(schema));
      for (const v8 of [true, false]) {
        expect(
          selectContentBackend({
            hasProject: true,
            hasServeConnection: false,
            runtime: "sandbox",
            v8,
            githubSite: "loading",
            sandboxSite: "ready",
          }),
        ).toBe(v8 ? "protocol-sandbox" : "legacy");
      }
    }
  });

  test("Localhost: a deco serve whose schema is v7-shaped still connects", async () => {
    const probed = await probe(githubServing({ major: 1, ...deco1 }));
    expect(
      localServeBackend({
        probed,
        isError: false,
        failureCount: 0,
        failure: null,
        describe: undefined,
        endpoint: "http://localhost:4545/rpc",
      }).kind,
    ).toBe("protocol");
  });

  test("no schema yet is reported as such (the schemaless guide)", async () => {
    expect((await probe(githubServing(null))).hasSchema).toBe(false);
  });
});

describe("sandbox probe", () => {
  const endpoint = "http://studio.test/rpc";

  test("a session whose sandbox is gone (404) is an error the editor retries", async () => {
    await expect(
      probeSandbox(endpoint, async () =>
        Response.json({ error: "sandbox not found" }, { status: 404 }),
      ),
    ).rejects.toThrow();
  });

  test("any other failure is an error (retried)", async () => {
    await expect(
      probeSandbox(endpoint, async () => new Response("boom", { status: 502 })),
    ).rejects.toThrow();
  });
});

describe("GitHub probe", () => {
  const endpoint = "http://studio.test/rpc";

  test("a v8 site this project doesn't own is a guided state, not an error", async () => {
    expect(
      await probeGithub(endpoint, async () =>
        Response.json(
          { error: "linked to another project", code: "site_not_owned" },
          { status: 409 },
        ),
      ),
    ).toBe(GITHUB_SITE_NOT_OWNED);
    expect(
      selectContentBackend({
        hasProject: true,
        hasServeConnection: false,
        runtime: "cms",
        v8: true,
        githubSite: "not-owned",
      }),
    ).toBe("site-not-owned-github");
  });

  test("any other failure is an error (retried)", async () => {
    await expect(
      probeGithub(endpoint, async () =>
        Response.json({ error: "conflict" }, { status: 409 }),
      ),
    ).rejects.toThrow();
    await expect(
      probeGithub(endpoint, async () =>
        Response.json({ error: "not configured" }, { status: 503 }),
      ),
    ).rejects.toThrow();
  });
});

describe("the hosted backend (the CMS on R2)", () => {
  test("the editor's probe of a v8 site makes no /decofile/ request", async () => {
    const seen: string[] = [];
    await probeGithub(
      `http://studio.test${cmsUrl("acme", "drafts/main/rpc")}`,
      async (request) => {
        seen.push(new URL(request.url).pathname);
        return Response.json([
          {
            jsonrpc: "2.0",
            id: 1,
            result: { protocol: "deco-content", protocolVersion: "1.2" },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            result: { schema: { blocksMajor: 8 }, version: "s" },
          },
        ]);
      },
    ).catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    for (const path of seen) {
      expect(path).toBe("/api/cms/acme/drafts/main/rpc");
    }
  });
});

describe("the sandbox's answer (sandboxSiteAnswer)", () => {
  const answered = { hasSchema: true } as unknown as Probe;

  test("before its first answer it waits for the working tree", () => {
    expect(
      sandboxSiteAnswer({
        data: undefined,
        isError: false,
        workingTreeReady: false,
      }),
    ).toBe("unavailable");
    expect(
      sandboxSiteAnswer({
        data: undefined,
        isError: false,
        workingTreeReady: true,
      }),
    ).toBe("loading");
    expect(
      sandboxSiteAnswer({
        data: undefined,
        isError: true,
        workingTreeReady: true,
      }),
    ).toBe("error");
  });

  test("answered, then hibernate/wake: stays on the protocol", () => {
    for (const workingTreeReady of [true, false]) {
      for (const isError of [true, false]) {
        expect(
          sandboxSiteAnswer({ data: answered, isError, workingTreeReady }),
        ).toBe("ready");
      }
    }
  });
});

describe("V8_PROBE_RETRY", () => {
  test("the editor waits on it, so a failure is re-polled until it recovers", () => {
    const failed = { state: { status: "error" } };
    const ok = { state: { status: "success" } };
    expect(V8_PROBE_RETRY.retry).toBe(2);
    expect(V8_PROBE_RETRY.refetchInterval(failed)).toBeGreaterThan(0);
    expect(V8_PROBE_RETRY.refetchInterval(ok)).toBe(false);
  });
});

describe("Localhost (localServeBackend)", () => {
  const probed = {
    client: {} as ContentClient,
    describe: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION },
    hasSchema: true,
  } as unknown as Probe;
  const base = {
    endpoint: "http://localhost:4545/rpc",
    describe: undefined,
    isError: false,
    failureCount: 0,
    failure: null as unknown,
  };
  const stopped = new TypeError("Failed to fetch");
  const kind = (backend: ReturnType<typeof localServeBackend>) =>
    backend.kind === "unavailable"
      ? `unavailable:${backend.problem?.reason}`
      : backend.kind;

  test("whatever site deco serve runs, it connects (no site check)", () => {
    const anySite = {
      ...probed,
      describe: {
        ...probed.describe,
        site: "another-store",
        secrets: { publicKey: "age1another" },
      },
    } as unknown as Probe;
    expect(kind(localServeBackend({ ...base, probed: anySite }))).toBe(
      "protocol",
    );
    expect(
      kind(
        localServeBackend({
          ...base,
          probed: {
            ...probed,
            describe: { ...probed.describe, secrets: null },
          } as unknown as Probe,
        }),
      ),
    ).toBe("protocol");
  });

  test("a connected site rides out a short outage, then says it's not running", () => {
    for (
      let failures = 0;
      failures < LOCAL_RECONNECT_GRACE_FAILURES;
      failures++
    ) {
      expect(
        kind(
          localServeBackend({
            ...base,
            probed,
            failureCount: failures,
            failure: failures ? stopped : null,
          }),
        ),
      ).toBe("protocol");
    }
    expect(
      kind(
        localServeBackend({
          ...base,
          probed,
          failureCount: LOCAL_RECONNECT_GRACE_FAILURES,
          failure: stopped,
        }),
      ),
    ).toBe("unavailable:not-answering");
  });

  test("an answered error (not retried) wins over an earlier answer", () => {
    expect(
      kind(
        localServeBackend({
          ...base,
          probed,
          isError: true,
          failure: new NotDecoServeError(),
        }),
      ),
    ).toBe("unavailable:not-deco-serve");
  });

  test("no schema yet is the schemaless guide", () => {
    const schemaless = localServeBackend({
      ...base,
      probed: { ...probed, hasSchema: false } as Probe,
    });
    expect(schemaless).toMatchObject({ kind: "protocol", hasSchema: false });
  });

  test("never answered: pending, then not running; answering again connects", () => {
    expect(kind(localServeBackend({ ...base, probed: undefined }))).toBe(
      "pending",
    );
    expect(
      kind(
        localServeBackend({
          ...base,
          probed: undefined,
          failureCount: 1,
          failure: stopped,
        }),
      ),
    ).toBe("unavailable:not-answering");
    expect(kind(localServeBackend({ ...base, probed }))).toBe("protocol");
  });
});

describe("the hosted probe on a draft that doesn't exist yet", () => {
  /** The CMS rpc route: 404 draft_not_found before JSON-RPC while the row is absent. */
  function cms() {
    const rows = new Set<string>();
    const calls: string[] = [];
    const rpc = async (request: Request) => {
      const body = (await request.json()) as
        | { id: number; method: string }
        | Array<{ id: number; method: string }>;
      calls.push(`rpc ${rows.has("main") ? "row" : "no-row"}`);
      if (!rows.has("main")) {
        return Response.json(
          { error: "Draft not found", code: "draft_not_found" },
          { status: 404 },
        );
      }
      const answer = (call: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: call.id,
        result:
          call.method === "describe"
            ? { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION }
            : call.method === "schema.get"
              ? {
                  notModified: false,
                  version: "s",
                  resolvedRef: null,
                  schema: { blocksMajor: 8, definitions: {}, root: {} },
                }
              : { revision: "e2", versions: { home: "v" } },
      });
      return Response.json(
        Array.isArray(body) ? body.map(answer) : answer(body),
      );
    };
    const ensure = async () => {
      calls.push("ensure");
      rows.add("main");
    };
    return { rpc, ensure, calls };
  }
  const endpoint = "http://studio.test/api/cms/acme/drafts/main/rpc";

  test("probing alone never gets past the missing row", async () => {
    const { rpc } = cms();
    await expect(probeGithub(endpoint, rpc)).rejects.toThrow();
  });

  test("the probe ensures the draft first, then answers, and a save lands", async () => {
    const { rpc, ensure, calls } = cms();
    const answer = await probeHosted(endpoint, ensure, rpc);
    expect(answer).not.toBe(GITHUB_SITE_NOT_OWNED);
    expect(calls[0]).toBe("ensure");
    expect(calls.slice(1).every((c) => c === "rpc row")).toBe(true);
    const save = await rpc(
      new Request(endpoint, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "blocks.apply",
          params: { set: { home: {} }, ifMatch: { home: null } },
        }),
      }),
    );
    expect(save.status).toBe(200);
    expect(((await save.json()) as { result: unknown }).result).toMatchObject({
      revision: "e2",
    });
  });

  test("a failed ensure fails the probe (retried), with no rpc", async () => {
    const { rpc, calls } = cms();
    await expect(
      probeHosted(
        endpoint,
        async () => {
          throw new Error("offline");
        },
        rpc,
      ),
    ).rejects.toThrow("offline");
    expect(calls).toEqual([]);
  });
});
