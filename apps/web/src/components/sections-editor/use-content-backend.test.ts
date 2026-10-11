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
  committedKeyOf,
  LOCAL_RECONNECT_GRACE_FAILURES,
  localBackendOf,
  localServeBackend,
  type Probe,
  probe,
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

/** What `useContentBackend` decides for a flag-on v8 Fast Preview session. */
async function decideWithFlagOn(schema: unknown) {
  const probed = await probe(githubServing(schema));
  return selectContentBackend({
    hasProject: true,
    isV8Project: true,
    flagEnabled: true,
    hasServeConnection: false,
    runtime: "cms",
    githubSite: probed.v8Schema ? "v8" : "v7",
  });
}

describe("v7/v8 detection over the GitHub backend", () => {
  test('a schema with "blocksMajor": 8 is a v8 site', async () => {
    expect(await decideWithFlagOn({ major: 1, blocksMajor: 8, ...deco1 })).toBe(
      "protocol-github",
    );
  });

  // The server serves `schema.gen.json`, else a v7 `meta.gen.json`, as
  // written: the file name never makes a site v8, only the field does.
  test("a committed schema without blocksMajor stays v7 with the flag on", async () => {
    // A v7 `meta.gen.json`, and a `schema.gen.json` from an older `deco schema`.
    expect(await decideWithFlagOn(deco1)).toBe("legacy");
    expect(await decideWithFlagOn({ major: 1, ...deco1 })).toBe("legacy");
  });

  test("any other blocksMajor stays v7", async () => {
    for (const blocksMajor of [7, "8", null, 9]) {
      expect(await decideWithFlagOn({ major: 1, blocksMajor, ...deco1 })).toBe(
        "legacy",
      );
    }
  });

  test("no committed schema stays v7", async () => {
    expect(await decideWithFlagOn(null)).toBe("legacy");
  });
});

describe("v7/v8 detection over a sandbox's daemon", () => {
  async function decide(schema: unknown) {
    const probed = await probe(githubServing(schema));
    return selectContentBackend({
      hasProject: true,
      isV8Project: true,
      flagEnabled: true,
      hasServeConnection: false,
      runtime: "sandbox",
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

describe("V8_PROBE_RETRY", () => {
  test("the editor waits on it, so a failure is re-polled until it recovers", () => {
    const failed = { state: { status: "error" } };
    const ok = { state: { status: "success" } };
    expect(V8_PROBE_RETRY.retry).toBe(2);
    expect(V8_PROBE_RETRY.refetchInterval(failed)).toBeGreaterThan(0);
    expect(V8_PROBE_RETRY.refetchInterval(ok)).toBe(false);
  });
});

describe("Localhost site check (localBackendOf)", () => {
  const KEY = "age1publickey";
  const probed = {
    client: {} as ContentClient,
    describe: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION },
    hasSchema: true,
    v8Schema: true,
  } as unknown as Probe;
  const withKey = (publicKey: string) =>
    ({
      ...probed.describe,
      secrets: { publicKey },
    }) as unknown as Probe["describe"];
  const base = {
    probed,
    endpoint: "http://localhost:4545/rpc",
    verifySite: true,
    siteSlug: "acme",
  };
  const loaded = (data: string | null) => ({ status: "success", data });
  const kind = (backend: ReturnType<typeof localBackendOf>) =>
    backend.kind === "unavailable"
      ? `unavailable:${backend.problem?.reason}`
      : backend.kind;

  test("this site's deco serve connects", () => {
    expect(
      kind(
        localBackendOf({
          ...base,
          describe: withKey(KEY),
          committed: loaded(KEY),
        }),
      ),
    ).toBe("protocol");
  });

  test("another site's deco serve is never used", () => {
    expect(
      kind(
        localBackendOf({
          ...base,
          describe: withKey("age1other"),
          committed: loaded(KEY),
        }),
      ),
    ).toBe("unavailable:other-site");
  });

  test("waits while the committed key loads", () => {
    for (const committed of [undefined, { status: "pending" }]) {
      expect(
        kind(localBackendOf({ ...base, describe: withKey(KEY), committed })),
      ).toBe("pending");
    }
  });

  test("a failed key read is retried, never 'can't tell the site': pending, then protocol", () => {
    const describe = withKey(KEY);
    expect(
      kind(
        localBackendOf({ ...base, describe, committed: { status: "error" } }),
      ),
    ).toBe("pending");
    expect(
      kind(localBackendOf({ ...base, describe, committed: loaded(KEY) })),
    ).toBe("protocol");
  });

  test("a repository with no key can't tell the site", () => {
    expect(
      kind(
        localBackendOf({
          ...base,
          describe: withKey(KEY),
          committed: loaded(null),
        }),
      ),
    ).toBe("unavailable:site-unverified");
  });

  test("a deco serve restarted in another site's folder is caught on the next describe", () => {
    const committed = loaded(KEY);
    expect(
      kind(localBackendOf({ ...base, describe: withKey(KEY), committed })),
    ).toBe("protocol");
    expect(
      kind(
        localBackendOf({ ...base, describe: withKey("age1other"), committed }),
      ),
    ).toBe("unavailable:other-site");
  });

  test("/site-editor (no project) skips the check", () => {
    expect(
      kind(
        localBackendOf({
          ...base,
          verifySite: false,
          siteSlug: null,
          describe: probed.describe,
          committed: undefined,
        }),
      ),
    ).toBe("protocol");
  });
});

describe("Localhost after deco serve stops (localServeBackend)", () => {
  const KEY = "age1publickey";
  const probed = {
    client: {} as ContentClient,
    describe: {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      secrets: { publicKey: KEY },
    },
    hasSchema: true,
    v8Schema: true,
  } as unknown as Probe;
  const otherSite = {
    ...probed,
    describe: { ...probed.describe, secrets: { publicKey: "age1other" } },
  } as unknown as Probe;
  const base = {
    endpoint: "http://localhost:4545/rpc",
    verifySite: true,
    siteSlug: "acme",
    describe: undefined,
    committed: { status: "success", data: KEY },
    isError: false,
    failureCount: 0,
    failure: null as unknown,
  };
  const stopped = new TypeError("Failed to fetch");
  const kind = (backend: ReturnType<typeof localServeBackend>) =>
    backend.kind === "unavailable"
      ? `unavailable:${backend.problem?.reason}`
      : backend.kind;

  test("another site's answer is replaced by 'not running' once a probe fails", () => {
    expect(kind(localServeBackend({ ...base, probed: otherSite }))).toBe(
      "unavailable:other-site",
    );
    expect(
      kind(
        localServeBackend({
          ...base,
          probed: otherSite,
          failureCount: 1,
          failure: stopped,
        }),
      ),
    ).toBe("unavailable:not-answering");
  });

  test("an 'update needed' answer is replaced too", () => {
    const old = {
      ...probed,
      describe: { ...probed.describe, secrets: null },
    } as unknown as Probe;
    expect(
      kind(
        localServeBackend({
          ...base,
          probed: old,
          committed: { status: "success", data: null },
        }),
      ),
    ).toBe("unavailable:site-unverified");
    expect(
      kind(
        localServeBackend({
          ...base,
          probed: old,
          committed: { status: "success", data: null },
          failureCount: 2,
          failure: stopped,
        }),
      ),
    ).toBe("unavailable:not-answering");
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

describe("committedKeyOf", () => {
  test("a failed read keeps the last answer, or stays undecided", () => {
    expect(committedKeyOf({ status: "error" })).toBeUndefined();
    expect(committedKeyOf({ status: "error", data: "k" })).toBe("k");
    expect(committedKeyOf({ status: "error", data: null })).toBeNull();
    expect(committedKeyOf({ status: "success", data: null })).toBeNull();
    expect(committedKeyOf(undefined)).toBeUndefined();
  });
});
