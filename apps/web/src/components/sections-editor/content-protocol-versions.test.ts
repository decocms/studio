import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  type BatchCall,
  type BatchOutcome,
  type ContentClient,
  ContentProtocolError,
  type DescribeResult,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import type { ProtocolBackend } from "./content-backend";
import {
  applyProtocolPatch,
  pollProtocolContent,
  protocolBlockVersion,
  reloadProtocolBlock,
} from "./content-protocol-api";
import { decofileWriteMutationKey } from "./decofile-api";
import { resetContentSync } from "./content-sync";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;
const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };

afterEach(() => resetContentSync());

/**
 * A content server with per-entry versions, as the protocol keeps them: each
 * write of an entry gives it a new version, and a guarded write whose
 * `ifMatch` no longer holds is a Conflict that writes nothing.
 */
function versionedBackend() {
  const state = {
    revision: 1,
    blocks: {
      Hero: { title: "stored" },
      "pages-home": { sections: [] },
    } as Record<string, Record<string, unknown>>,
    versions: { Hero: "h1", "pages-home": "p1" } as Record<string, string>,
    applied: [] as Array<{ ifMatch?: Record<string, string | null> }>,
    changesGet: true,
  };
  /** Another writer's save, straight to the server. */
  const writeElsewhere = (name: string, value: Record<string, unknown>) => {
    state.blocks[name] = value;
    state.versions[name] = `${name[0]!.toLowerCase()}${++state.revision}`;
  };
  const list = () => ({
    notModified: false as const,
    revision: `r${state.revision}`,
    resolvedRef: null,
    blocks: structuredClone(state.blocks),
    versions: { ...state.versions },
    diagnostics: [],
  });
  const client = {
    blocksApply: async (patch: {
      set?: Record<string, Record<string, unknown>>;
      ifMatch?: Record<string, string | null>;
    }) => {
      state.applied.push(patch);
      const entries: Record<string, unknown> = {};
      for (const [name, expected] of Object.entries(patch.ifMatch ?? {})) {
        const actual = state.versions[name] ?? null;
        if (actual !== expected) entries[name] = { expected, actual };
      }
      if (Object.keys(entries).length > 0) {
        throw new ContentProtocolError(ErrorCode.Conflict, "changed", {
          entries,
        });
      }
      const versions: Record<string, string> = {};
      for (const [name, value] of Object.entries(patch.set ?? {})) {
        writeElsewhere(name, value);
        versions[name] = state.versions[name]!;
      }
      return { revision: `r${state.revision}`, versions };
    },
    changesGet: async ({ names }: { names: string[] }) => {
      if (!state.changesGet) {
        throw new ContentProtocolError(ErrorCode.MethodNotFound, "no");
      }
      return {
        base: { revision: "main", resolvedRef: "main" },
        entries: Object.fromEntries(
          names.map((name) => [
            name,
            {
              kind: "set",
              before: null,
              after: state.blocks[name] ?? null,
              version: state.versions[name] ?? null,
              baseVersion: null,
            },
          ]),
        ),
        diagnostics: [],
      };
    },
    blocksList: async () => list(),
    batch: async (calls: BatchCall[]) =>
      calls.map(
        (call): BatchOutcome =>
          call.method === "blocks.list"
            ? {
                ok: true,
                result:
                  (call.params as { ifNoneMatch?: string } | undefined)
                    ?.ifNoneMatch === `r${state.revision}`
                    ? { notModified: true, revision: `r${state.revision}` }
                    : list(),
              }
            : call.method === "changes.list"
              ? {
                  ok: true,
                  result: {
                    notModified: false,
                    revision: `c${state.revision}`,
                    base: { revision: "main", resolvedRef: "main" },
                    changes: {},
                  },
                }
              : {
                  ok: true,
                  result: {
                    notModified: false,
                    version: null,
                    resolvedRef: null,
                    schema: null,
                  },
                },
      ),
  } as unknown as ContentClient;
  const backend: ProtocolBackend = {
    kind: "protocol",
    source: "github",
    client,
    describe: {} as DescribeResult,
    cacheKeySuffix: "",
  };
  return { state, backend, writeElsewhere };
}

const cachedBlocks = (queryClient: QueryClient) =>
  queryClient.getQueryData<Record<string, unknown>>(KEYS.decofile(CACHE_KEY));

describe("content-protocol block versions", () => {
  it("are unknown before the first read, then follow the listed versions", async () => {
    const queryClient = new QueryClient();
    const { backend } = versionedBackend();
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe(
      undefined,
    );
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe("h1");
    // Listed without it: the content has no such block.
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Footer")).toBe(null);
  });

  it("move with each write's answer", async () => {
    const queryClient = new QueryClient();
    const { backend } = versionedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const result = await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { title: "mine" } } },
      { Hero: "h1" },
    );
    expect(result.versions).toEqual({ Hero: "h2" });
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe("h2");
  });

  it("a block being saved keeps its last landed version through a poll", async () => {
    const queryClient = new QueryClient();
    const { backend, writeElsewhere } = versionedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    // A write of Hero is in flight while the poll lists someone else's.
    let release!: () => void;
    const inFlight = queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationKey: decofileWriteMutationKey(ORG, VM, BRANCH),
        mutationFn: () => new Promise<void>((resolve) => (release = resolve)),
      })
      .execute({ blockKey: "Hero", data: { title: "mine" } });
    writeElsewhere("Hero", { title: "theirs" });
    writeElsewhere("pages-home", { sections: [1] });
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe("h1");
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "pages-home")).toBe(
      "p3",
    );
    release();
    await inFlight;
  });

  it("are unknown for a block the cache holds but no read or write versioned", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {});
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), { Hero: {} });
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe(
      undefined,
    );
  });
});

describe("content-protocol block versions over time", () => {
  /** The app's cache drops an entry nothing watches after `gcTime` (5 minutes; here 20 ms). */
  const shortLivedCache = () =>
    new QueryClient({ defaultOptions: { queries: { gcTime: 20 } } });
  const later = () => new Promise((resolve) => setTimeout(resolve, 60));

  it("stay known after the cache's unused-entry time, with saves and polls in between", async () => {
    const queryClient = shortLivedCache();
    const { backend } = versionedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await later();
    // The editor saves one block, then polls: nothing changed elsewhere.
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { title: "mine" } } },
      { Hero: "h1" },
    );
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await later();
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe("h2");
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "pages-home")).toBe(
      "p1",
    );
  });

  it("a read that finds the versions gone reads the content whole", async () => {
    const queryClient = new QueryClient();
    const { backend } = versionedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    queryClient.removeQueries({ queryKey: KEYS.contentVersions(CACHE_KEY) });
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "pages-home")).toBe(
      "p1",
    );
  });
});

describe("reloadProtocolBlock", () => {
  it("puts the stored copy and its version in place of a refused edit", async () => {
    const queryClient = new QueryClient();
    const { backend, writeElsewhere } = versionedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    writeElsewhere("Hero", { title: "theirs" });
    // The editor's optimistic copy of its refused save.
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      ...cachedBlocks(queryClient),
      Hero: { title: "mine" },
    });
    await reloadProtocolBlock(queryClient, backend, params, CACHE_KEY, "Hero");
    expect(cachedBlocks(queryClient)?.Hero).toEqual({ title: "theirs" });
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe("h2");
  });

  it("reads the whole content on a server without changes.get", async () => {
    const queryClient = new QueryClient();
    const { backend, state, writeElsewhere } = versionedBackend();
    state.changesGet = false;
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    writeElsewhere("Hero", { title: "theirs" });
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      ...cachedBlocks(queryClient),
      Hero: { title: "mine" },
    });
    await reloadProtocolBlock(queryClient, backend, params, CACHE_KEY, "Hero");
    expect(cachedBlocks(queryClient)?.Hero).toEqual({ title: "theirs" });
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe("h2");
  });

  it("drops a block another writer deleted", async () => {
    const queryClient = new QueryClient();
    const { backend, state } = versionedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    delete state.blocks.Hero;
    delete state.versions.Hero;
    await reloadProtocolBlock(queryClient, backend, params, CACHE_KEY, "Hero");
    expect(cachedBlocks(queryClient)).not.toHaveProperty("Hero");
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero")).toBe(null);
  });
});
