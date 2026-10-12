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
  probeSandbox,
  V8_PROBE_RETRY,
} from "./use-content-backend";

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

/**
 * What `useContentBackend` decides in GitHub mode when main's schema (read by
 * the server with the same `isV8Schema`) is `schema`, any org.
 */
async function decideV8Session(schema: unknown) {
  const probed = await probe(githubServing(schema));
  const answer = probed.v8Schema ? "v8" : "v7";
  return selectContentBackend({
    hasProject: true,
    hasServeConnection: false,
    runtime: "cms",
    mainSchema: answer,
    githubSite: answer,
  });
}

describe("v7/v8 detection over the GitHub backend", () => {
  test('a schema with "blocksMajor": 8 is a v8 site', async () => {
    expect(await decideV8Session({ major: 1, blocksMajor: 8, ...deco1 })).toBe(
      "protocol-github",
    );
  });

  // Only the field makes a site v8 (`isV8Schema`), never the file.
  test("a committed schema without the v8 field stays v7", async () => {
    // A v7-shaped schema, and a `schema.gen.json` from an older `deco schema`.
    expect(await decideV8Session(deco1)).toBe("legacy");
    expect(await decideV8Session({ major: 1, ...deco1 })).toBe("legacy");
  });

  test("any other value of the v8 field stays v7", async () => {
    for (const value of [7, "8", null, 9]) {
      expect(
        await decideV8Session({ major: 1, blocksMajor: value, ...deco1 }),
      ).toBe("legacy");
    }
  });

  test("no committed schema stays v7", async () => {
    expect(await decideV8Session(null)).toBe("legacy");
  });
});

describe("v7/v8 detection over a sandbox's daemon", () => {
  async function decide(schema: unknown) {
    const probed = await probe(githubServing(schema));
    return selectContentBackend({
      hasProject: true,
      hasServeConnection: false,
      runtime: "sandbox",
      // Main's answer plays no part in Sandbox mode, whatever it is.
      mainSchema: "loading",
      githubSite: "loading",
      sandboxSite: probed.v8Schema ? "v8" : "v7",
    });
  }

  test('a working tree whose schema says "blocksMajor": 8 is a v8 site', async () => {
    expect(await decide({ major: 1, blocksMajor: 8, ...deco1 })).toBe(
      "protocol-sandbox",
    );
  });

  test("a v7 working tree (or none) stays legacy", async () => {
    expect(await decide({ major: 1, ...deco1 })).toBe("legacy");
    expect(await decide(null)).toBe("legacy");
  });
});

describe("sandbox probe", () => {
  const endpoint = "http://studio.test/rpc";

  test("an older daemon answering 404 is v7, not an error", async () => {
    expect(
      await probeSandbox(
        endpoint,
        async () => new Response("404 page not found", { status: 404 }),
      ),
    ).toBe(null);
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
        mainSchema: "v8",
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
    v8Schema: true,
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

  test("a schema that isn't v8 can't be edited; no schema yet is the schemaless guide", () => {
    expect(
      kind(
        localServeBackend({
          ...base,
          probed: { ...probed, v8Schema: false } as Probe,
        }),
      ),
    ).toBe("unavailable:not-v8");
    const schemaless = localServeBackend({
      ...base,
      probed: { ...probed, hasSchema: false, v8Schema: false } as Probe,
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
