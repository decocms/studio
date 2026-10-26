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

describe("hosted draft guards (Studio's GitHub backend)", () => {
  /** A hosted server: main's blocks with the draft on top; saves read the draft alone. */
  function hostedBackend() {
    const state = {
      main: "m1",
      etag: "e1",
      draft: {} as Record<
        string,
        { value: Record<string, unknown>; version: string }
      >,
      mainBlocks: { Hero: { title: "main" } } as Record<string, unknown>,
      /** Names the draft deletes (tombstones). */
      deleted: new Set<string>(),
      reads: 0,
      applied: [] as Array<{ ifMatch?: Record<string, string | null> }>,
    };
    /** A block's version in the draft: a deletion's is its tombstone's. */
    const draftVersion = (name: string) =>
      state.deleted.has(name)
        ? "tombstone"
        : (state.draft[name]?.version ?? null);
    const revision = () => `${state.main}~${state.etag}`;
    const changes = () => ({
      notModified: false as const,
      revision: `c-${revision()}`,
      base: { revision: state.main, resolvedRef: "main" },
      changes: Object.fromEntries([
        ...Object.entries(state.draft).map(([name, entry]) => [
          name,
          { kind: "set", version: entry.version, baseVersion: "main-v" },
        ]),
        // A deletion of a block main has (one main lacks hides nothing).
        ...[...state.deleted]
          .filter((name) => name in state.mainBlocks)
          .map((name) => [
            name,
            { kind: "delete", version: null, baseVersion: "main-v" },
          ]),
      ]),
    });
    const client = {
      blocksApply: async (patch: {
        set?: Record<string, Record<string, unknown>>;
        delete?: string[];
        ifMatch?: Record<string, string | null>;
      }) => {
        state.applied.push(patch);
        for (const [name, expected] of Object.entries(patch.ifMatch ?? {})) {
          const actual = draftVersion(name);
          if (actual !== expected) {
            // As Studio's route answers it: the draft's copy rides along.
            throw new ContentProtocolError(ErrorCode.Conflict, "changed", {
              entries: { [name]: { expected, actual } },
              draft: {
                [name]: state.deleted.has(name)
                  ? { block: null, version: "tombstone" }
                  : state.draft[name]
                    ? {
                        block: state.draft[name]!.value,
                        version: state.draft[name]!.version,
                      }
                    : null,
              },
            });
          }
        }
        state.etag = `e${state.applied.length + 1}`;
        const versions: Record<string, string | null> = {};
        for (const [name, value] of Object.entries(patch.set ?? {})) {
          versions[name] = `d${state.applied.length}`;
          state.draft[name] = { value, version: versions[name]! };
          state.deleted.delete(name);
        }
        for (const name of patch.delete ?? []) {
          versions[name] = null;
          delete state.draft[name];
          state.deleted.add(name);
        }
        // A save never reads main: no main part.
        return { revision: `~${state.etag}`, versions };
      },
      batch: async (calls: BatchCall[]) => {
        state.reads++;
        return calls.map((call): BatchOutcome => {
          const ifNoneMatch = (call.params as { ifNoneMatch?: string })
            ?.ifNoneMatch;
          if (call.method === "blocks.list") {
            if (ifNoneMatch === revision()) {
              return {
                ok: true,
                result: { notModified: true, revision: revision() },
              };
            }
            const blocks: Record<string, unknown> = { ...state.mainBlocks };
            const versions: Record<string, string> = { Hero: "main-v" };
            for (const [name, entry] of Object.entries(state.draft)) {
              blocks[name] = entry.value;
              versions[name] = entry.version;
            }
            for (const name of state.deleted) {
              delete blocks[name];
              delete versions[name];
            }
            return {
              ok: true,
              result: {
                notModified: false,
                revision: revision(),
                resolvedRef: "main",
                blocks,
                versions,
                diagnostics: [],
              },
            };
          }
          if (call.method === "changes.list") {
            return { ok: true, result: changes() };
          }
          return {
            ok: true,
            result: {
              notModified: false,
              version: null,
              resolvedRef: null,
              schema: null,
            },
          };
        });
      },
      changesGet: async () => {
        state.reads++;
        throw new Error("read through GitHub");
      },
      blocksList: async () => {
        state.reads++;
        throw new Error("read through GitHub");
      },
    } as unknown as ContentClient;
    const backend: ProtocolBackend = {
      kind: "protocol",
      source: "github",
      client,
      describe: {} as DescribeResult,
      cacheKeySuffix: "",
    };
    return { state, backend };
  }

  /** Another editor's save, straight into the draft. */
  const saveElsewhere = (
    state: ReturnType<typeof hostedBackend>["state"],
    name: string,
    value: Record<string, unknown> | null,
  ) => {
    state.etag = `x${state.etag}`;
    if (value === null) {
      delete state.draft[name];
      state.deleted.add(name);
    } else {
      state.draft[name] = { value, version: `other-${state.etag}` };
      state.deleted.delete(name);
    }
  };

  const refusalOf = async (write: Promise<unknown>) => {
    try {
      await write;
    } catch (error) {
      return error;
    }
    throw new Error("the save was not refused");
  };

  it("a refused save opens from the draft's copy it carries: nothing is read", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    saveElsewhere(state, "Hero", { title: "theirs" });
    const refusal = await refusalOf(
      applyProtocolPatch(
        queryClient,
        backend,
        params,
        CACHE_KEY,
        { set: { Hero: { title: "mine" } } },
        { Hero: null },
      ),
    );
    const reads = state.reads;
    await reloadProtocolBlock(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      "Hero",
      refusal,
    );
    expect(state.reads).toBe(reads);
    expect(cachedBlocks(queryClient)?.Hero).toEqual({ title: "theirs" });
    // The next guard is the draft's version: choosing mine now lands.
    const version = protocolBlockVersion(
      queryClient,
      CACHE_KEY,
      "Hero",
      backend,
    );
    expect(version).toBe(`other-${state.etag}`);
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { title: "mine" } } },
      { Hero: version! },
    );
    expect(state.draft.Hero?.value).toEqual({ title: "mine" });
  });

  it("a block deleted in the draft is guarded by its tombstone, main's or not", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    // A block only the draft has, deleted here: main lacks it.
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Promo: { v: 1 } } },
      { Promo: null },
    );
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { delete: ["Promo"] },
      {
        Promo: protocolBlockVersion(queryClient, CACHE_KEY, "Promo", backend)!,
      },
    );
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Promo", backend)).toBe(
      "tombstone",
    );
    // Undo lands, guarded by the tombstone.
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Promo: { v: 1 } } },
      {
        Promo: protocolBlockVersion(queryClient, CACHE_KEY, "Promo", backend)!,
      },
    );
    expect(state.draft.Promo?.value).toEqual({ v: 1 });

    // Main's Hero, deleted by another editor: a stale "must not exist" save
    // is refused and shows the deletion, read from the refusal alone.
    saveElsewhere(state, "Hero", null);
    const refusal = await refusalOf(
      applyProtocolPatch(
        queryClient,
        backend,
        params,
        CACHE_KEY,
        { set: { Hero: { title: "mine" } } },
        { Hero: null },
      ),
    );
    const reads = state.reads;
    await reloadProtocolBlock(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      "Hero",
      refusal,
    );
    expect(state.reads).toBe(reads);
    expect(cachedBlocks(queryClient)).not.toHaveProperty("Hero");
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero", backend)).toBe(
      "tombstone",
    );
    // After a poll too: the draft's changes list the deletion.
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero", backend)).toBe(
      "tombstone",
    );
  });

  it("a tombstone the draft no longer holds (published meanwhile) stops guarding", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    // A block only the draft has, created and deleted here: its tombstone.
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Promo: { v: 1 } } },
      { Promo: null },
    );
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { delete: ["Promo"] },
      {
        Promo: protocolBlockVersion(queryClient, CACHE_KEY, "Promo", backend)!,
      },
    );
    // Publish elsewhere empties the draft: the tombstone is gone.
    state.draft = {};
    state.deleted.clear();
    state.etag = "published";
    (backend.client as unknown as { changesGet: unknown }).changesGet =
      async () => {
        state.reads++;
        return {
          base: { revision: state.main, resolvedRef: "main" },
          entries: {},
        };
      };
    const refusal = await refusalOf(
      applyProtocolPatch(
        queryClient,
        backend,
        params,
        CACHE_KEY,
        { set: { Promo: { v: 2 } } },
        {
          Promo: protocolBlockVersion(
            queryClient,
            CACHE_KEY,
            "Promo",
            backend,
          )!,
        },
      ),
    );
    await reloadProtocolBlock(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      "Promo",
      refusal,
    );
    // The refusal says the draft doesn't hold it: "must not exist" again.
    expect(
      protocolBlockVersion(queryClient, CACHE_KEY, "Promo", backend),
    ).toBeNull();
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Promo: { v: 2 } } },
      { Promo: null },
    );
    expect(state.draft.Promo?.value).toEqual({ v: 2 });
  });

  it("a block only main has is guarded by null; once saved, by the draft's version", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedBackend();
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero", backend)).toBe(
      undefined,
    );
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero", backend)).toBe(
      null,
    );
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { title: "mine" } } },
      { Hero: null },
    );
    expect(protocolBlockVersion(queryClient, CACHE_KEY, "Hero", backend)).toBe(
      "d1",
    );
    // The next save, guarded by the first one's answer, lands.
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { title: "mine again" } } },
      { Hero: protocolBlockVersion(queryClient, CACHE_KEY, "Hero", backend)! },
    );
    expect(state.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: null },
      { Hero: "d1" },
    ]);
    // The changes list holds the saved block, its "before" main's version.
    expect(
      queryClient.getQueryData<{ changes: Record<string, unknown> }>(
        KEYS.contentChanges(CACHE_KEY),
      )?.changes.Hero,
    ).toEqual({ kind: "set", version: "d2", baseVersion: "main-v" });
  });

  it("a save keeps the main part of the revision read, so the next poll is not modified", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = hostedBackend();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const reads = state.reads;
    const result = await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { title: "mine" } } },
      { Hero: null },
    );
    // Saving read nothing.
    expect(state.reads).toBe(reads);
    expect(result.revision).toBe("m1~e2");
    expect(
      queryClient.getQueryData<{ revision?: string }>(
        KEYS.contentRevision(CACHE_KEY),
      )?.revision,
    ).toBe("m1~e2");
    const before = cachedBlocks(queryClient);
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    // "Not modified": the blocks the editor holds stay as they are.
    expect(cachedBlocks(queryClient)).toBe(before);
  });
});
