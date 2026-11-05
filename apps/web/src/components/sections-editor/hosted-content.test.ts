import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  type BatchOutcome,
  type ContentClient,
  ContentProtocolError,
  type DescribeResult,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { KEYS } from "@/lib/query-keys";
import type { ProtocolBackend } from "./content-backend";
import {
  applyProtocolPatch,
  pollProtocolContent,
  protocolBlockVersion,
} from "./content-protocol-api";
import { resetContentSync } from "./content-sync";
import {
  type ContentIndex,
  ensureHostedBlocks,
  type HostedCall,
  isIndexStub,
  listingOf,
  stubNames,
} from "./hosted-content";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;
const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };

afterEach(() => resetContentSync());

/**
 * Studio's hosted draft as the editor sees it: `cms.index` (versions, meta
 * and the draft's own names), `cms.blocks` (bodies), `schema.get`,
 * `changes.list` and `blocks.apply`. Every call is logged by method.
 */
function hostedServer() {
  const state = {
    token: 1,
    bodies: {
      home: { __resolveType: "page", path: "/", sections: ["Header"] },
      about: { __resolveType: "page", path: "/about" },
      Header: { __resolveType: "site/sections/Header.tsx", title: "hi" },
    } as Record<string, Record<string, unknown>>,
    versions: { home: "vH", about: "vA", Header: "vR" } as Record<
      string,
      string
    >,
    draft: {} as ContentIndex["draft"],
    calls: [] as string[],
    blocksCalls: [] as string[][],
    applied: [] as Array<{
      set?: Record<string, unknown>;
      ifMatch?: Record<string, string | null>;
    }>,
    /** Names whose write fails (once) after the others before them landed. */
    failOnce: new Set<string>(),
  };
  const revision = () => `t${state.token}`;
  const indexAnswer = (ifNoneMatch?: string) =>
    ifNoneMatch === revision()
      ? { notModified: true, revision: revision() }
      : {
          notModified: false,
          revision: revision(),
          resolvedRef: "rel-1",
          sequence: 1,
          entries: Object.fromEntries(
            Object.entries(state.bodies).map(([name, body]) => [
              name,
              {
                version: state.versions[name]!,
                meta: {
                  type: body.__resolveType as string,
                  ...(typeof body.path === "string" ? { path: body.path } : {}),
                },
              },
            ]),
          ),
          draft: structuredClone(state.draft),
        };
  const answer = (call: HostedCall): BatchOutcome => {
    state.calls.push(call.method);
    switch (call.method) {
      case "cms.index":
        return {
          ok: true,
          result: indexAnswer(
            (call.params as { ifNoneMatch?: string } | undefined)?.ifNoneMatch,
          ),
        };
      case "cms.blocks": {
        const names = (call.params as { names: string[] }).names;
        state.blocksCalls.push(names);
        const blocks: Record<string, unknown> = {};
        const versions: Record<string, string> = {};
        const missing: string[] = [];
        for (const name of names) {
          if (state.bodies[name]) {
            blocks[name] = structuredClone(state.bodies[name]);
            versions[name] = state.versions[name]!;
          } else missing.push(name);
        }
        return { ok: true, result: { blocks, versions, missing } };
      }
      case "changes.list":
        return {
          ok: true,
          result: {
            notModified: false,
            revision: revision(),
            base: { revision: "rel-1", resolvedRef: "rel-1" },
            changes: {},
          },
        };
      default:
        return {
          ok: true,
          result: {
            notModified: false,
            version: null,
            resolvedRef: null,
            schema: null,
          },
        };
    }
  };
  /** Another editor's save, straight to the draft. */
  const writeElsewhere = (name: string, body: Record<string, unknown>) => {
    state.bodies[name] = body;
    state.versions[name] = `v${name}${++state.token}`;
    state.draft[name] = {
      operation: "set",
      version: state.versions[name]!,
      editor: { userId: "u2", at: 1 },
    };
  };
  const client = {
    blocksApply: async (patch: {
      set?: Record<string, Record<string, unknown>>;
      ifMatch?: Record<string, string | null>;
    }) => {
      state.calls.push("blocks.apply");
      state.applied.push(structuredClone(patch));
      const landed: Record<string, string> = {};
      for (const name of Object.keys(patch.set ?? {}).sort()) {
        if (state.failOnce.has(name)) {
          state.failOnce.delete(name);
          throw new ContentProtocolError(ErrorCode.Unavailable, "busy", {
            retryAfterMs: 250,
            landed,
          });
        }
        state.bodies[name] = patch.set![name]!;
        state.versions[name] = `v${name}${++state.token}`;
        state.draft[name] = {
          operation: "set",
          version: state.versions[name]!,
          editor: { userId: "u1", at: 1 },
        };
        landed[name] = state.versions[name]!;
      }
      return { revision: `s-${state.token}`, versions: landed };
    },
    batch: async () => {
      throw new Error("the hosted editor reads through cms.index");
    },
  } as unknown as ContentClient;
  const hosted = {
    batch: async (calls: HostedCall[]) => calls.map(answer),
  };
  const backend: ProtocolBackend = {
    kind: "protocol",
    source: "github",
    client,
    describe: {} as DescribeResult,
    cacheKeySuffix: "",
    hosted,
  };
  return { state, backend, hosted, writeElsewhere };
}

const loadedBodies = (queryClient: QueryClient) =>
  queryClient.getQueryData<Record<string, unknown>>(KEYS.decofile(CACHE_KEY));

describe("the hosted editor reads the index, not the blocks", () => {
  it("a poll is cms.index + schema.get + changes.list: no blocks.list, no body", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(state.calls).toEqual(["cms.index", "schema.get", "changes.list"]);
    expect(loadedBodies(queryClient)).toEqual({});
    const index = queryClient.getQueryData<ContentIndex>(
      KEYS.contentIndex(CACHE_KEY),
    );
    expect(Object.keys(index!.entries)).toEqual(["home", "about", "Header"]);
    // The next poll is conditional on the token it read.
    state.calls.length = 0;
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(state.calls).toEqual(["cms.index", "schema.get", "changes.list"]);
    expect(state.blocksCalls).toEqual([]);
  });

  it("the page list sees every name as a stub with its type and path", async () => {
    const queryClient = new QueryClient();
    const { backend } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const listing = listingOf(
      queryClient.getQueryData<ContentIndex>(KEYS.contentIndex(CACHE_KEY)),
      loadedBodies(queryClient),
    );
    expect(listing.about).toMatchObject({
      __resolveType: "page",
      path: "/about",
    });
    expect(isIndexStub(listing.about)).toBe(true);
    // A stub is never written.
    expect(stubNames({ about: listing.about, x: {} })).toEqual(["about"]);
  });

  it("opening a block loads it (and only it) in one cms.blocks call", async () => {
    const queryClient = new QueryClient();
    const { state, backend, hosted } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await Promise.all([
      ensureHostedBlocks(queryClient, hosted, CACHE_KEY, ["home", "Header"]),
      // A second view asks for the same block: it joins the load.
      ensureHostedBlocks(queryClient, hosted, CACHE_KEY, ["home"]),
    ]);
    expect(state.blocksCalls).toEqual([["home", "Header"]]);
    expect(Object.keys(loadedBodies(queryClient)!).sort()).toEqual([
      "Header",
      "home",
    ]);
    // Already loaded at the index's version: nothing is read.
    await ensureHostedBlocks(queryClient, hosted, CACHE_KEY, ["home"]);
    expect(state.blocksCalls).toHaveLength(1);
    const listing = listingOf(
      queryClient.getQueryData<ContentIndex>(KEYS.contentIndex(CACHE_KEY)),
      loadedBodies(queryClient),
    );
    expect(isIndexStub(listing.home)).toBe(false);
    expect(isIndexStub(listing.about)).toBe(true);
  });

  it("asks for at most 50 names a call", async () => {
    const queryClient = new QueryClient();
    const { state, backend, hosted } = hostedServer();
    for (let i = 0; i < 120; i++) {
      state.bodies[`b${i}`] = { __resolveType: "x" };
      state.versions[`b${i}`] = `v${i}`;
    }
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await ensureHostedBlocks(
      queryClient,
      hosted,
      CACHE_KEY,
      Array.from({ length: 120 }, (_, i) => `b${i}`),
    );
    expect(state.blocksCalls.map((names) => names.length)).toEqual([
      50, 50, 20,
    ]);
  });

  it("another editor's save of an open block is read again on the next poll; closed ones aren't", async () => {
    const queryClient = new QueryClient();
    const { state, backend, hosted, writeElsewhere } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await ensureHostedBlocks(queryClient, hosted, CACHE_KEY, ["home"]);
    writeElsewhere("home", { __resolveType: "page", path: "/", sections: [] });
    writeElsewhere("about", { __resolveType: "page", path: "/about-us" });
    state.blocksCalls.length = 0;
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(state.blocksCalls).toEqual([["home"]]);
    expect(loadedBodies(queryClient)?.home).toEqual({
      __resolveType: "page",
      path: "/",
      sections: [],
    });
    // The list shows the other editor's new path from the index alone.
    const index = queryClient.getQueryData<ContentIndex>(
      KEYS.contentIndex(CACHE_KEY),
    );
    expect(index?.entries.about?.meta?.path).toBe("/about-us");
    expect(loadedBodies(queryClient)?.about).toBeUndefined();
  });
});

describe("hosted saves", () => {
  it("guard on the draft's own version from the index: null when the draft doesn't hold the block", async () => {
    const queryClient = new QueryClient();
    const { backend, writeElsewhere } = hostedServer();
    writeElsewhere("about", { __resolveType: "page", path: "/b" });
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "home", backend)).toBe(
      null,
    );
    expect(
      protocolBlockVersion(queryClient, CACHE_KEY, "about", backend),
    ).toMatch(/^vabout/);
  });

  it("a save moves the index: the next guard is the version it answered", async () => {
    const queryClient = new QueryClient();
    const { backend } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const result = await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { home: { __resolveType: "page", path: "/new" } } },
      { home: null },
    );
    const index = queryClient.getQueryData<ContentIndex>(
      KEYS.contentIndex(CACHE_KEY),
    );
    expect(index?.draft.home?.version).toBe(result.versions.home!);
    expect(index?.entries.home?.meta?.path).toBe("/new");
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "home", backend)).toBe(
      result.versions.home,
    );
  });

  it("a save that landed in part adopts what landed and sends only the rest, once", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    state.failOnce.add("home");
    const result = await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      {
        set: {
          Header: { __resolveType: "site/sections/Header.tsx", title: "a" },
          home: { __resolveType: "page", path: "/" },
        },
      },
      { Header: null, home: null },
    );
    expect(state.applied.map((p) => Object.keys(p.set ?? {}))).toEqual([
      ["Header", "home"],
      ["home"],
    ]);
    // The retry keeps the rest's guards as they were.
    expect(state.applied[1]?.ifMatch).toEqual({ home: null });
    expect(Object.keys(result.versions).sort()).toEqual(["Header", "home"]);
    expect(
      protocolBlockVersion(queryClient, CACHE_KEY, "Header", backend),
    ).toBe(state.versions.Header);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "home", backend)).toBe(
      state.versions.home,
    );
  });

  it("never writes a block it didn't load", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const stub = listingOf(
      queryClient.getQueryData<ContentIndex>(KEYS.contentIndex(CACHE_KEY)),
      {},
    ).about;
    await expect(
      applyProtocolPatch(
        queryClient,
        backend,
        params,
        CACHE_KEY,
        { set: { about: stub } },
        { about: null },
      ),
    ).rejects.toThrow("isn't loaded");
    expect(state.applied).toEqual([]);
  });

  it("a deletion's tombstone is the next guard", async () => {
    const queryClient = new QueryClient();
    const { backend } = hostedServer();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    backend.client.blocksApply = (async () => ({
      revision: "s-x",
      versions: { about: DRAFT_TOMBSTONE_VERSION },
    })) as unknown as ContentClient["blocksApply"];
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { delete: ["about"] },
      { about: null },
    );
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "about", backend)).toBe(
      DRAFT_TOMBSTONE_VERSION,
    );
    const index = queryClient.getQueryData<ContentIndex>(
      KEYS.contentIndex(CACHE_KEY),
    );
    expect(index?.entries.about).toBeUndefined();
  });
});
