import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  type ContentClient,
  ContentProtocolError,
  type DescribeResult,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import { en } from "@/i18n/en/index.ts";
import type { ProtocolBackend } from "./content-backend";
import { resetContentSync } from "./content-sync";
import { BlockConflictError } from "./decofile-api";
import * as realBackend from "./use-content-backend";
import * as realDecofile from "./use-decofile";
import * as realSessionRuntime from "@/hooks/use-session-runtime";
import * as realNamedRuleConflict from "./named-rule-conflict";
import * as realLocalPreview from "@/hooks/use-local-preview-url";
import type { SaveGuard } from "./use-save-block";
import { draftVersionOf } from "./draft-version";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;

/** A content server whose entries carry versions; a stale `ifMatch` is a Conflict. */
const server = {
  blocks: {} as Record<string, Record<string, unknown>>,
  versions: {} as Record<string, string>,
  applied: [] as Array<{
    set?: Record<string, unknown>;
    delete?: string[];
    ifMatch?: Record<string, string | null>;
  }>,
  /** A refusal carries the draft's copies, as Studio's hosted route answers. */
  draftInRefusal: false,
  /** `changes.get` reads. */
  reads: 0,
  /** Versions are the blocks' content hashes, as Studio's hosted draft's. */
  hashed: false,
};

const client = {
  blocksApply: async (patch: {
    set?: Record<string, Record<string, unknown>>;
    delete?: string[];
    ifMatch?: Record<string, string | null>;
  }) => {
    server.applied.push(patch);
    for (const [name, expected] of Object.entries(patch.ifMatch ?? {})) {
      const actual = server.versions[name] ?? null;
      if (actual !== expected) {
        throw new ContentProtocolError(ErrorCode.Conflict, "changed", {
          entries: { [name]: { expected, actual } },
          ...(server.draftInRefusal
            ? {
                draft: {
                  [name]: server.blocks[name]
                    ? { block: server.blocks[name], version: actual }
                    : { block: null, version: "tombstone" },
                },
              }
            : {}),
        });
      }
    }
    const versions: Record<string, string | null> = {};
    for (const name of patch.delete ?? []) {
      delete server.blocks[name];
      server.versions[name] = "tombstone";
      versions[name] = null;
    }
    for (const [name, value] of Object.entries(patch.set ?? {})) {
      server.blocks[name] = value;
      versions[name] = server.versions[name] = server.hashed
        ? await draftVersionOf(value)
        : `${server.versions[name]}+`;
    }
    return { revision: "r2", versions };
  },
  changesGet: async ({ names }: { names: string[] }) => ({
    _read: server.reads++,
    base: { revision: "main", resolvedRef: "main" },
    entries: Object.fromEntries(
      names.map((name) => [
        name,
        {
          kind: "set",
          before: null,
          after: server.blocks[name] ?? null,
          version: server.versions[name] ?? null,
          baseVersion: null,
        },
      ]),
    ),
    diagnostics: [],
  }),
  changesList: async () => ({
    notModified: false,
    revision: "c1",
    base: { revision: "main", resolvedRef: "main" },
    changes: {},
  }),
} as unknown as ContentClient;

const backend: ProtocolBackend = {
  kind: "protocol",
  source: "github",
  client,
  describe: {} as DescribeResult,
  cacheKeySuffix: "",
};

mock.module("./use-content-backend", () => ({
  ...realBackend,
  useContentBackend: () => backend,
}));
mock.module("./use-decofile", () => ({
  ...realDecofile,
  useDecofileCacheKey: () => CACHE_KEY,
}));

mock.module("./use-package-path", () => ({ usePackagePath: () => null }));
mock.module("@/hooks/use-session-runtime", () => ({
  ...realSessionRuntime,
  useSessionRuntime: () => ({ runtime: null }),
}));
mock.module("@/hooks/use-local-preview-url", () => ({
  ...realLocalPreview,
  useLocalPreviewUrl: () => ({ url: null }),
}));

/** The reconcile flow's answers: every value in conflict on `asked.choice`. */
const asked = {
  choice: "mine" as "mine" | "theirs",
  fields: [] as Array<{ pointer: string; mine: unknown; theirs: unknown }>,
  /** "Keep my version" / "Leave it deleted" questions asked. */
  deleted: [] as Array<{ kind: string; label: string }>,
  /** What the values question says about the block and who changed it. */
  about: undefined as
    | { block?: string; author?: { blockKey: string } | null }
    | undefined,
};
// The real dialog module, restored for the test files that run after this
// one in the same process (named-rule-conflict.test.tsx renders it).
const namedRuleConflict = { ...realNamedRuleConflict };
afterAll(() => {
  mock.module("./named-rule-conflict", () => namedRuleConflict);
});
mock.module("./named-rule-conflict", () => ({
  canAskNamedRuleConflict: () => true,
  askDeletedConflict: async (conflict: { kind: string; label: string }) => {
    asked.deleted.push(conflict);
    return asked.choice;
  },
  askNamedRuleConflict: async (
    plan: { pointers: string[] },
    fields: Array<{ pointer: string; mine: unknown; theirs: unknown }>,
    about?: { block?: string; author?: { blockKey: string } | null },
  ) => {
    asked.fields = fields;
    asked.about = about;
    return Object.fromEntries(plan.pointers.map((p) => [p, asked.choice]));
  },
}));

const { useSaveBlock, useDebouncedSaveBlock } = await import(
  "./use-save-block"
);
const { useCopyEpochs } = await import("./held-copy");
const { protocolMetaQueryKey } = await import("./content-protocol-api");
const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };
const { useDeleteBlock } = await import("./use-delete-block");
const { useMoveBlocks } = await import("./use-move-blocks");

afterEach(() => resetContentSync());

/** The editor holds Hero at `h1`; meanwhile another writer stored `theirs` at `h2`. */
function setup() {
  server.blocks = { Hero: { title: "theirs" } };
  server.versions = { Hero: "h2" };
  server.applied = [];
  server.draftInRefusal = false;
  server.reads = 0;
  server.hashed = false;
  asked.choice = "mine";
  asked.fields = [];
  asked.deleted = [];
  asked.about = undefined;
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
    Hero: { title: "loaded" },
  });
  queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), { Hero: "h1" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => useSaveBlock({ orgSlug: ORG, virtualMcpId: VM, branch: BRANCH }),
    { wrapper },
  );
  return { queryClient, result };
}

/** The draft's changes as the editor last read them: each name's version. */
function draftHolds(
  queryClient: QueryClient,
  versions: Record<string, string>,
  deleted: string[] = [],
) {
  queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), {
    revision: "c1",
    base: { revision: "main", resolvedRef: "main" },
    changes: {
      ...Object.fromEntries(
        Object.entries(versions).map(([name, version]) => [
          name,
          { kind: "set", version, baseVersion: "m1" },
        ]),
      ),
      ...Object.fromEntries(
        deleted.map((name) => [
          name,
          { kind: "delete", version: "tombstone", baseVersion: "m1" },
        ]),
      ),
    },
  });
}

const heroInCache = (queryClient: QueryClient) =>
  queryClient.getQueryData<Record<string, unknown>>(KEYS.decofile(CACHE_KEY))
    ?.Hero;

describe("useSaveBlock on the content protocol (v8)", () => {
  it("a form save refused as stale keeps the other writer's block and fails like a 409", async () => {
    const { queryClient, result } = setup();
    const rejected: unknown[] = [];
    const guard: SaveGuard = {
      ifMatch: (key) => ({ [key]: "h1" }),
      onRejected: (error) => rejected.push(error),
      reloadOnConflict: true,
    };
    let failure: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ blockKey: "Hero", data: { title: "mine" }, guard })
        .catch((error: unknown) => {
          failure = error;
        });
    });
    expect(server.applied).toEqual([
      { set: { Hero: { title: "mine" } }, ifMatch: { Hero: "h1" } },
    ]);
    // Nothing was written over the other writer's change.
    expect(server.blocks.Hero).toEqual({ title: "theirs" });
    // The form re-reads the stored block, not the copy it started from.
    expect(heroInCache(queryClient)).toEqual({ title: "theirs" });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ Hero: "h2" });
    expect(failure).toBeInstanceOf(BlockConflictError);
    expect((failure as Error).message).toBe(
      en["sectionsEditor.sectionsEditor.blockChangedElsewhere"],
    );
    expect(rejected).toHaveLength(1);
  });

  it("on the hosted draft, a refused form save takes the draft's copy from the refusal: nothing is read", async () => {
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), {
      revision: "c1",
      base: { revision: "main", resolvedRef: "main" },
      changes: { Hero: { kind: "set", version: "h1", baseVersion: "m1" } },
    });
    const guard: SaveGuard = {
      ifMatch: (key) => ({ [key]: "h1" }),
      reloadOnConflict: true,
    };
    let failure: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ blockKey: "Hero", data: { title: "mine" }, guard })
        .catch((error: unknown) => {
          failure = error;
        });
    });
    expect(failure).toBeInstanceOf(BlockConflictError);
    expect(server.reads).toBe(0);
    expect(heroInCache(queryClient)).toEqual({ title: "theirs" });
    // The next guard is the draft's version, "before" kept.
    expect(
      queryClient.getQueryData<{ changes: Record<string, unknown> }>(
        KEYS.contentChanges(CACHE_KEY),
      )?.changes.Hero,
    ).toEqual({ kind: "set", version: "h2", baseVersion: "m1" });
  });

  it("a guarded save that lands reports the block's new version", async () => {
    const { queryClient, result } = setup();
    const applied: Array<Record<string, string | null>> = [];
    const guard: SaveGuard = {
      ifMatch: (key) => ({ [key]: "h2" }),
      onApplied: (versions) => applied.push(versions),
      reloadOnConflict: true,
    };
    await act(async () => {
      await result.current.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine" },
        guard,
      });
    });
    expect(applied).toEqual([{ Hero: "h2+" }]);
    expect(heroInCache(queryClient)).toEqual({ title: "mine" });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ Hero: "h2+" });
  });

  it("a guard without reloadOnConflict keeps the protocol's Conflict and rolls back (a local deco serve)", async () => {
    // Hosted v8 reconciles instead (see "an editor's own create-only guard").
    const source = backend.source;
    (backend as { source: string }).source = "local";
    try {
      const { queryClient, result } = setup();
      let failure: unknown;
      await act(async () => {
        await result.current
          .mutateAsync({
            blockKey: "Hero",
            data: { title: "mine" },
            guard: { ifMatch: (key) => ({ [key]: null }) },
          })
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect(failure).toBeInstanceOf(ContentProtocolError);
      expect(heroInCache(queryClient)).toEqual({ title: "loaded" });
    } finally {
      (backend as { source: string }).source = source;
    }
  });
});

describe("saved JSON carries no editor metadata", () => {
  it("a save sends the block exactly as the form holds it: no __meta, no user id", async () => {
    const { queryClient, result } = setup();
    draftHolds(queryClient, { Hero: "h2" });
    await act(async () => {
      await result.current.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine" },
      });
    });
    expect(server.applied).toEqual([
      { set: { Hero: { title: "mine" } }, ifMatch: { Hero: "h2" } },
    ]);
    expect(JSON.stringify(server.blocks)).not.toMatch(/__meta|lastEdited/);
  });

  describe("a hosted create (`create: true`)", () => {
    /** Someone else already created Promo in the draft (version p1). */
    function setupCreate(choice: "mine" | "theirs") {
      const { queryClient, result } = setup();
      server.blocks = { Promo: { title: "theirs", note: "same" } };
      server.versions = { Promo: "p1" };
      asked.choice = choice;
      asked.fields = [];
      queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), {
        revision: "c1",
        base: { revision: "main", resolvedRef: "main" },
        changes: {},
      });
      return { queryClient, result };
    }

    for (const choice of ["mine", "theirs"] as const) {
      it(`is saved with "must not exist yet", and a name taken meanwhile opens the reconcile flow (${choice})`, async () => {
        const { queryClient, result } = setupCreate(choice);
        let outcome: unknown;
        await act(async () => {
          outcome = await result.current.mutateAsync({
            blockKey: "Promo",
            data: { title: "mine", note: "same" },
            create: true,
          });
        });
        // Taking theirs is what the draft holds already: nothing is written.
        expect(server.applied.map((p) => p.ifMatch)).toEqual(
          choice === "mine"
            ? [{ Promo: null }, { Promo: "p1" }]
            : [{ Promo: null }],
        );
        if (choice === "theirs") {
          expect(outcome).toEqual({ keptTheirs: true, deleted: false });
        }
        expect(asked.fields.map((f) => [f.pointer, f.mine, f.theirs])).toEqual([
          ["/title", "mine", "theirs"],
        ]);
        const title = choice === "mine" ? "mine" : "theirs";
        expect(server.blocks.Promo).toEqual({ title, note: "same" });
        expect(
          queryClient.getQueryData<Record<string, unknown>>(
            KEYS.decofile(CACHE_KEY),
          )?.Promo,
        ).toEqual({ title, note: "same" });
      });
    }

    it("a name taken meanwhile opens the reconcile flow from the refusal alone", async () => {
      const { result } = setupCreate("mine");
      server.draftInRefusal = true;
      await act(() =>
        result.current.mutateAsync({
          blockKey: "Promo",
          data: { title: "mine", note: "same" },
          create: true,
        }),
      );
      expect(server.reads).toBe(0);
      expect(server.applied.map((p) => p.ifMatch)).toEqual([
        { Promo: null },
        { Promo: "p1" },
      ]);
      expect(asked.fields.map((f) => f.pointer)).toEqual(["/title"]);
    });

    it("a name the draft deletes is created over the deletion, guarded by its tombstone", async () => {
      // Whatever the reconcile flow would answer, nothing is asked.
      const { result } = setupCreate("theirs");
      server.draftInRefusal = true;
      server.blocks = {};
      server.versions = { Promo: "tombstone" };
      await act(() =>
        result.current.mutateAsync({
          blockKey: "Promo",
          data: { title: "mine" },
          create: true,
        }),
      );
      expect(server.reads).toBe(0);
      expect(server.applied.map((p) => p.ifMatch)).toEqual([
        { Promo: null },
        { Promo: "tombstone" },
      ]);
      expect(server.blocks.Promo).toEqual({ title: "mine" });
      expect(asked.fields).toEqual([]);
      // A create starts from no copy: nobody deleted anything it edited, so
      // there is no "Keep my version" / "Leave it deleted" question.
      expect(asked.deleted).toEqual([]);
    });

    it("a name nobody holds is written once, guarded", async () => {
      const { result } = setupCreate("mine");
      server.blocks = {};
      server.versions = {};
      await act(() =>
        result.current.mutateAsync({
          blockKey: "Promo",
          data: { title: "mine" },
          create: true,
        }),
      );
      expect(server.applied.map((p) => p.ifMatch)).toEqual([{ Promo: null }]);
      expect(asked.fields).toEqual([]);
    });
  });
});

describe("every hosted v8 save is guarded by the draft (no guard of its own)", () => {
  it("carries the draft's version, or null when the draft doesn't hold the block", async () => {
    const { queryClient, result } = setup();
    server.versions = { Hero: "h2" };
    draftHolds(queryClient, { Hero: "h2" });
    await act(async () => {
      await result.current.mutateAsync({ blockKey: "Hero", data: { a: 1 } });
      await result.current.mutateAsync({ blockKey: "Footer", data: { b: 1 } });
    });
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: "h2" },
      { Footer: null },
    ]);
  });

  it("a stale save never overwrites someone else's edit: the reconcile flow asks first", async () => {
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    draftHolds(queryClient, { Hero: "h1" });
    await act(async () => {
      await result.current.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine" },
      });
    });
    expect(asked.fields.map((f) => [f.pointer, f.mine, f.theirs])).toEqual([
      ["/title", "mine", "theirs"],
    ]);
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: "h1" },
      { Hero: "h2" },
    ]);
    expect(server.blocks.Hero).toEqual({ title: "mine" });
  });

  it("taking theirs writes nothing more and says so", async () => {
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    asked.choice = "theirs";
    draftHolds(queryClient, { Hero: "h1" });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine" },
      });
    });
    expect(server.applied).toHaveLength(1);
    expect(outcome).toEqual({ keptTheirs: true, deleted: false });
    expect(heroInCache(queryClient)).toEqual({ title: "theirs" });
  });

  for (const choice of ["mine", "theirs"] as const) {
    it(`a stale save of a block the draft deleted asks "Keep my version" / "Leave it deleted" (${choice})`, async () => {
      const { queryClient, result } = setup();
      server.draftInRefusal = true;
      server.blocks = {};
      server.versions = { Hero: "tombstone" };
      asked.choice = choice;
      draftHolds(queryClient, { Hero: "h1" });
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.mutateAsync({
          blockKey: "Hero",
          data: { title: "mine", name: "Hero banner" },
        });
      });
      expect(asked.deleted).toEqual([
        { kind: "theyDeleted", label: "Hero banner" },
      ]);
      if (choice === "mine") {
        expect(server.applied.map((p) => p.ifMatch)).toEqual([
          { Hero: "h1" },
          { Hero: "tombstone" },
        ]);
        expect(server.blocks.Hero).toEqual({
          title: "mine",
          name: "Hero banner",
        });
      } else {
        expect(server.applied).toHaveLength(1);
        expect(outcome).toEqual({ keptTheirs: true, deleted: true });
        expect(server.blocks.Hero).toBeUndefined();
        expect(heroInCache(queryClient)).toBeUndefined();
      }
    });
  }

  it("a rename of a block someone deleted asks about it by the name that was deleted", async () => {
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    server.blocks = {};
    server.versions = { Letter: "tombstone" };
    asked.choice = "theirs";
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      Letter: { name: "Spring Letter I", title: "t" },
    });
    draftHolds(queryClient, { Letter: "h1" });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        blockKey: "Letter",
        data: { name: "Spring Letter I renamed", title: "t" },
      });
    });
    expect(asked.deleted).toEqual([
      { kind: "theyDeleted", label: "Spring Letter I" },
    ]);
    expect(outcome).toEqual({ keptTheirs: true, deleted: true });
  });

  it("a section form's save of a page the draft deleted asks too, and keeps the edit over the tombstone", async () => {
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    server.blocks = {};
    server.versions = { Hero: "tombstone" };
    draftHolds(queryClient, { Hero: "h1" });
    const applied: Array<Record<string, string | null>> = [];
    const guard: SaveGuard = {
      ifMatch: (key) => ({ [key]: "h1" }),
      onApplied: (versions) => applied.push(versions),
      reloadOnConflict: true,
    };
    await act(async () => {
      await result.current.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine" },
        guard,
      });
    });
    expect(asked.deleted.map((q) => q.kind)).toEqual(["theyDeleted"]);
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: "h1" },
      { Hero: "tombstone" },
    ]);
    expect(applied).toEqual([{ Hero: "tombstone+" }]);
    expect(heroInCache(queryClient)).toEqual({ title: "mine" });
  });

  describe("an editor's own create-only guard (Settings' CMS block)", () => {
    /** "create" until a save lands, then no guard of its own (`undefined`). */
    function createOnlyGuard() {
      const state = { mode: "create" as "create" | "off", rejected: 0 };
      const guard: SaveGuard = {
        ifMatch: (key) =>
          state.mode === "create" ? { [key]: null } : undefined,
        onApplied: () => {
          state.mode = "off";
        },
        onRejected: () => {
          state.rejected++;
        },
      };
      return { state, guard };
    }

    it("once the block exists, each save is guarded by the draft's version (never refused unread)", async () => {
      const { queryClient, result } = setup();
      server.versions = { Hero: "h2" };
      draftHolds(queryClient, { Hero: "h2" });
      const { state, guard } = createOnlyGuard();
      state.mode = "off";
      await act(async () => {
        await result.current.mutateAsync({
          blockKey: "Hero",
          data: { title: "mine" },
          guard,
        });
      });
      expect(server.applied.map((p) => p.ifMatch)).toEqual([{ Hero: "h2" }]);
      expect(server.blocks.Hero).toEqual({ title: "mine" });
    });

    it("a block someone created first opens the reconcile flow, not a failure", async () => {
      const { queryClient, result } = setup();
      server.draftInRefusal = true;
      draftHolds(queryClient, { Hero: "h2" });
      const { state, guard } = createOnlyGuard();
      await act(async () => {
        await result.current.mutateAsync({
          blockKey: "Hero",
          data: { title: "mine" },
          guard,
        });
      });
      expect(asked.fields.map((f) => [f.pointer, f.mine, f.theirs])).toEqual([
        ["/title", "mine", "theirs"],
      ]);
      expect(server.applied.map((p) => p.ifMatch)).toEqual([
        { Hero: null },
        { Hero: "h2" },
      ]);
      expect(server.blocks.Hero).toEqual({ title: "mine" });
      expect(state).toEqual({ mode: "off", rejected: 0 });
    });
  });

  it("a refused form save says whether the refusal carried the draft's copy (no pause before the dialog)", async () => {
    for (const carried of [true, false]) {
      const { queryClient, result } = setup();
      server.draftInRefusal = carried;
      draftHolds(queryClient, { Hero: "h1" });
      let failure: unknown;
      await act(async () => {
        await result.current
          .mutateAsync({
            blockKey: "Hero",
            data: { title: "mine" },
            guard: {
              ifMatch: (key) => ({ [key]: "h1" }),
              reloadOnConflict: true,
            },
          })
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect(failure).toBeInstanceOf(BlockConflictError);
      expect((failure as BlockConflictError).carriedStored).toBe(carried);
    }
  });
});

describe("an editor that keeps its own copy (holdsCopy) is guarded by the copy it shows", () => {
  const LOADED = { title: "loaded", body: "same" };
  const v = (block: unknown) => draftVersionOf(block);

  /**
   * The editor opened Hero as the draft holds it ("loaded"); its hook is
   * mounted then, as an editor keyed by its block is. Versions are content
   * hashes, as the hosted draft's.
   */
  async function setupHeld(
    opts: { debounced?: boolean; listed?: Record<string, string> } = {},
  ) {
    const { queryClient } = setup();
    server.hashed = true;
    server.blocks = { Hero: { ...LOADED } };
    server.versions = { Hero: await v(LOADED) };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      Hero: { ...LOADED },
    });
    draftHolds(queryClient, opts.listed ?? { Hero: await v(LOADED) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        save: useSaveBlock(
          { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH },
          { holdsCopy: true },
        ),
        debounced: useDebouncedSaveBlock(
          { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH },
          { holdsCopy: true },
        ),
        epochOf: useCopyEpochs(`${ORG}/${VM}/${BRANCH}`),
      }),
      { wrapper },
    );
    return { queryClient, result };
  }

  /** Someone else saved Hero and the editor's poll read it. */
  async function theyChangedIt(queryClient: QueryClient, title = "theirs") {
    const theirs = { title, body: "same" };
    server.blocks = { Hero: theirs };
    server.versions = { Hero: await v(theirs) };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), { Hero: theirs });
    draftHolds(queryClient, { Hero: await v(theirs) });
    return theirs;
  }

  it("a poll that read someone else's change never lets the next keystroke overwrite it", async () => {
    const { queryClient, result } = await setupHeld();
    server.draftInRefusal = true;
    const theirs = await theyChangedIt(queryClient);
    await act(async () => {
      // The form still shows "loaded": the user edits the body.
      await result.current.save.mutateAsync({
        blockKey: "Hero",
        data: { title: "loaded", body: "mine" },
      });
    });
    // Guarded by the copy the form shows, refused, and merged: their title
    // and the user's body, with nothing to ask.
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: await v(LOADED) },
      { Hero: await v(theirs) },
    ]);
    expect(asked.fields).toEqual([]);
    expect(server.blocks.Hero).toEqual({ title: "theirs", body: "mine" });
  });

  it("the guard is the hash of the copy the form shows, even when the draft's changes were read ahead of the blocks", async () => {
    // The changes list already has someone else's version; the blocks (and
    // the form seeded from them) are still the copy the editor loaded. A
    // guard paired from the two caches would be their version: the save
    // would land over their change unasked.
    const theirs = { title: "theirs", body: "same" };
    const { queryClient, result } = await setupHeld({
      listed: { Hero: await v(theirs) },
    });
    server.draftInRefusal = true;
    server.blocks = { Hero: theirs };
    server.versions = { Hero: await v(theirs) };
    await act(async () => {
      await result.current.save.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine", body: "same" },
      });
    });
    expect(server.applied[0]?.ifMatch).toEqual({ Hero: await v(LOADED) });
    expect(asked.fields.map((f) => [f.pointer, f.mine, f.theirs])).toEqual([
      ["/title", "mine", "theirs"],
    ]);
    expect(queryClient).toBeDefined();
  });

  it('a block the draft doesn\'t hold is guarded "must not exist in the draft"', async () => {
    const { result } = await setupHeld({ listed: {} });
    server.versions = {};
    await act(async () => {
      await result.current.save.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine", body: "same" },
      });
    });
    expect(server.applied[0]?.ifMatch).toEqual({ Hero: null });
  });

  it("a value both changed asks, with the copy the form loaded as the ancestor", async () => {
    const { queryClient, result } = await setupHeld();
    server.draftInRefusal = true;
    await theyChangedIt(queryClient);
    await act(async () => {
      await result.current.save.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine", body: "same" },
      });
    });
    expect(asked.fields.map((f) => [f.pointer, f.mine, f.theirs])).toEqual([
      ["/title", "mine", "theirs"],
    ]);
    expect(server.blocks.Hero).toEqual({ title: "mine", body: "same" });
  });

  it("its own confirmed saves move the copy it holds", async () => {
    const { result } = await setupHeld();
    const one = { title: "one", body: "same" };
    await act(async () => {
      await result.current.save.mutateAsync({ blockKey: "Hero", data: one });
      await result.current.save.mutateAsync({
        blockKey: "Hero",
        data: { title: "two", body: "same" },
      });
    });
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: await v(LOADED) },
      { Hero: await v(one) },
    ]);
  });

  for (const outcome of ["theirs", "deleted", "merged"] as const) {
    it(`the editor is told to show what the draft holds after the reconcile (${outcome}), and its old copy can't overwrite it`, async () => {
      const { queryClient, result } = await setupHeld();
      server.draftInRefusal = true;
      if (outcome === "deleted") {
        server.blocks = {};
        server.versions = { Hero: "tombstone" };
        draftHolds(queryClient, {}, ["Hero"]);
      } else {
        await theyChangedIt(queryClient);
      }
      asked.choice = "theirs";
      const before = result.current.epochOf("Hero");
      await act(async () => {
        await result.current.save.mutateAsync({
          blockKey: "Hero",
          data:
            outcome === "merged"
              ? { title: "loaded", body: "mine" }
              : { title: "mine", body: "same" },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      // The form remounts from the draft's copy (or its deleted state).
      expect(result.current.epochOf("Hero")).toBe(before + 1);
      const applied = server.applied.length;
      // A keystroke still pending in the old form is refused, never written
      // over the result unasked.
      asked.choice = "theirs";
      await act(async () => {
        await result.current.save.mutateAsync({
          blockKey: "Hero",
          data: { title: "stale", body: "same" },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(server.applied[applied]?.ifMatch).toEqual({
        Hero: await v(LOADED),
      });
      expect(server.blocks.Hero).toEqual(
        outcome === "deleted"
          ? undefined
          : outcome === "merged"
            ? { title: "theirs", body: "mine" }
            : { title: "theirs", body: "same" },
      );
    });
  }

  it("an edit made before the form was reseeded keeps the copy it was made on: refused and asked, never written over what the form shows now", async () => {
    const { queryClient, result } = await setupHeld();
    server.draftInRefusal = true;
    asked.choice = "theirs";
    // The user types in the form showing "loaded"; the save is pending.
    act(() =>
      result.current.debounced.save("Hero", { title: "mine", body: "same" }),
    );
    // Meanwhile someone else's change arrives and the form is reseeded
    // with it (another block opened and back, a reconcile elsewhere…).
    const theirs = await theyChangedIt(queryClient);
    act(() => result.current.debounced.hold("Hero"));
    // The pending edit was made on "loaded": guarded by it, refused, and
    // asked about; nothing is written over their title.
    await act(async () => {
      result.current.debounced.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.applied[0]?.ifMatch).toEqual({ Hero: await v(LOADED) });
    expect(asked.fields.map((f) => [f.pointer, f.mine, f.theirs])).toEqual([
      ["/title", "mine", "theirs"],
    ]);
    expect(server.blocks.Hero).toEqual(theirs);
    // An edit made on the reseeded form is guarded by what it shows.
    const applied = server.applied.length;
    act(() =>
      result.current.debounced.save("Hero", { title: "theirs", body: "next" }),
    );
    await act(async () => {
      result.current.debounced.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.applied[applied]?.ifMatch).toEqual({ Hero: await v(theirs) });
    expect(server.blocks.Hero).toEqual({ title: "theirs", body: "next" });
  });
});

describe("a debounced editor keeping its own copy (hosted v8)", () => {
  for (const holdsCopy of [true, false]) {
    it(`an edit still pending when the form unmounts is ${holdsCopy ? "saved (and reconciled), never dropped" : "dropped, as before"}`, async () => {
      const { queryClient } = setup();
      const loaded = await draftVersionOf({ title: "loaded" });
      server.hashed = true;
      server.blocks = { Hero: { title: "loaded" } };
      server.versions = { Hero: loaded };
      draftHolds(queryClient, { Hero: loaded });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
      const { result, unmount } = renderHook(
        () =>
          useDebouncedSaveBlock(
            { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH },
            { holdsCopy },
          ),
        { wrapper },
      );
      act(() => result.current.save("Hero", { title: "pending" }));
      unmount();
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(server.applied.map((p) => p.ifMatch)).toEqual(
        holdsCopy ? [{ Hero: loaded }] : [],
      );
    });
  }
});

describe("the reconcile question of a block save names it as the editor does", () => {
  it("the block by its title, its fields by the form's labels, and who changed it (when known)", async () => {
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    const footer = (about: string) => ({
      __resolveType: "site/sections/Footer.tsx",
      name: "Footer",
      about,
    });
    server.blocks = { "footer-1": footer("theirs") };
    server.versions = { "footer-1": "f2" };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      "footer-1": footer("loaded"),
    });
    draftHolds(queryClient, { "footer-1": "f1" });
    queryClient.setQueryData(protocolMetaQueryKey(params, backend), {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Footer.tsx": {
              type: "object",
              properties: { about: { type: "string", title: "About us" } },
            },
          },
        },
      },
      schema: {},
    });
    await act(async () => {
      await result.current.mutateAsync({
        blockKey: "footer-1",
        data: footer("mine"),
      });
    });
    expect(asked.fields.map((f) => (f as { label?: string }).label)).toEqual([
      "About us",
    ]);
    expect(asked.about?.block).toBe("Footer");
    expect(asked.about?.author?.blockKey).toBe("footer-1");
  });
});

describe("a hosted save that can't go on guides the user, never a dead end", () => {
  const t = (key: string, vars?: Record<string, string>) =>
    Object.entries(vars ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      (en as Record<string, string>)[key] ?? key,
    );

  it("when the draft's changes can't be read: nothing is sent, and it says what to do", async () => {
    const { saveErrorMessage } = await import("./serve-save-error");
    const { result } = setup();
    const changesList = client.changesList;
    (client as { changesList: unknown }).changesList = async () => {
      throw new Error("network down");
    };
    let failure: unknown;
    try {
      await act(async () => {
        await result.current
          .mutateAsync({ blockKey: "Hero", data: { title: "mine" } })
          .catch((error: unknown) => {
            failure = error;
          });
      });
    } finally {
      (client as { changesList: unknown }).changesList = changesList;
    }
    expect(server.applied).toEqual([]);
    expect(saveErrorMessage(t as never, failure as Error, "github")).toBe(
      en["siteEditor.save.draftUnread"],
    );
  });

  it("after three rounds it stops asking and says, calmly, what to do", async () => {
    const { saveErrorMessage } = await import("./serve-save-error");
    const { queryClient, result } = setup();
    server.draftInRefusal = true;
    draftHolds(queryClient, { Hero: "h1" });
    // Someone keeps saving Hero: every guarded save finds a newer version.
    const blocksApply = client.blocksApply;
    let n = 0;
    (client as { blocksApply: unknown }).blocksApply = (patch: never) => {
      server.versions.Hero = `busy${++n}`;
      server.blocks.Hero = { title: `theirs ${n}` };
      return blocksApply(patch);
    };
    let failure: unknown;
    try {
      await act(async () => {
        await result.current
          .mutateAsync({ blockKey: "Hero", data: { title: "mine" } })
          .catch((error: unknown) => {
            failure = error;
          });
      });
    } finally {
      (client as { blocksApply: unknown }).blocksApply = blocksApply;
    }
    expect(server.applied.length).toBe(3);
    expect(saveErrorMessage(t as never, failure as Error, "github")).toBe(
      en["siteEditor.save.keptChanging"],
    );
  });
});

describe("a hosted move refused until it gave up", () => {
  it("says, in the editor's words, to check the latest and make the change again", async () => {
    const { queryClient } = setup();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMoveBlocks(params), { wrapper });
    server.draftInRefusal = true;
    draftHolds(queryClient, { Hero: "h1" });
    asked.choice = "mine";
    const blocksApply = client.blocksApply;
    let n = 0;
    (client as { blocksApply: unknown }).blocksApply = (patch: never) => {
      server.versions.Hero = `busy${++n}`;
      server.blocks.Hero = { title: `theirs ${n}` };
      return blocksApply(patch);
    };
    let failure: unknown;
    try {
      await act(async () => {
        await result.current
          .move({ writes: { Banner: { title: "loaded" } }, deletes: ["Hero"] })
          .catch((error: unknown) => {
            failure = error;
          });
      });
    } finally {
      (client as { blocksApply: unknown }).blocksApply = blocksApply;
    }
    expect((failure as Error).message).toBe(en["siteEditor.save.keptChanging"]);
    // The editor shows the draft's latest, not the copy the move started on.
    expect(heroInCache(queryClient)).toEqual({ title: `theirs ${n}` });
  });
});

describe("every hosted blocks.apply carries a precondition per block", () => {
  it("a patch missing one is refused before it is sent", async () => {
    const { applyProtocolPatch } = await import("./content-protocol-api");
    const { queryClient } = setup();
    const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };
    for (const ifMatch of [undefined, { Hero: "h2" }]) {
      let failure: unknown;
      await applyProtocolPatch(
        queryClient,
        backend,
        params,
        CACHE_KEY,
        { set: { Hero: { a: 1 } }, delete: ["Gone"] },
        ifMatch,
      ).catch((error: unknown) => {
        failure = error;
      });
      expect(failure).toBeInstanceOf(Error);
    }
    expect(server.applied).toEqual([]);
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Hero: { a: 1 } }, delete: ["Gone"] },
      { Hero: "h2", Gone: null },
    );
    expect(server.applied).toHaveLength(1);
  });
});

describe("hosted v8 deletes and moves are guarded by the draft too", () => {
  function setupHook<T>(hook: () => T) {
    const { queryClient } = setup();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(hook, { wrapper });
    return { queryClient, result };
  }
  const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };

  it("a delete carries the draft's version", async () => {
    const { queryClient, result } = setupHook(() => useDeleteBlock(params));
    draftHolds(queryClient, { Hero: "h2" });
    await act(async () => {
      await result.current.mutateAsync({ blockKey: "Hero" });
    });
    expect(server.applied).toEqual([
      { set: {}, delete: ["Hero"], ifMatch: { Hero: "h2" } },
    ]);
  });

  for (const choice of ["mine", "theirs"] as const) {
    it(`a delete of a block someone changed meanwhile asks "Delete anyway" / "Keep their version" (${choice})`, async () => {
      const { queryClient, result } = setupHook(() => useDeleteBlock(params));
      server.draftInRefusal = true;
      asked.choice = choice;
      draftHolds(queryClient, { Hero: "h1" });
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.mutateAsync({ blockKey: "Hero" });
      });
      expect(asked.deleted.map((q) => q.kind)).toEqual(["youDeleted"]);
      if (choice === "mine") {
        expect(server.applied.map((p) => p.ifMatch)).toEqual([
          { Hero: "h1" },
          { Hero: "h2" },
        ]);
        expect(server.blocks.Hero).toBeUndefined();
        // The editor shows what the draft holds: the block is gone.
        expect(heroInCache(queryClient)).toBeUndefined();
      } else {
        expect(server.applied).toHaveLength(1);
        expect(outcome).toEqual({ keptTheirs: true, deleted: false });
        expect(server.blocks.Hero).toEqual({ title: "theirs" });
        expect(heroInCache(queryClient)).toEqual({ title: "theirs" });
      }
    });
  }

  it("a delete from an editor's own copy is guarded by that copy: a change it never showed is asked about", async () => {
    const { queryClient, result } = setupHook(() => useDeleteBlock(params));
    server.draftInRefusal = true;
    asked.choice = "theirs";
    // A poll read someone else's change (h2); the form still shows h1.
    draftHolds(queryClient, { Hero: "h2" });
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      Hero: { title: "theirs" },
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        blockKey: "Hero",
        shown: () => ({ value: { title: "loaded" }, inDraft: true }),
      });
    });
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: await draftVersionOf({ title: "loaded" }) },
    ]);
    expect(asked.deleted.map((q) => q.kind)).toEqual(["youDeleted"]);
    expect(outcome).toEqual({ keptTheirs: true, deleted: false });
    expect(server.blocks.Hero).toEqual({ title: "theirs" });
  });

  for (const choice of ["mine", "theirs"] as const) {
    it(`a refused move leaves the editor's copy as the draft holds it (${choice})`, async () => {
      const { queryClient, result } = setupHook(() => useMoveBlocks(params));
      server.draftInRefusal = true;
      asked.choice = choice;
      // The editor read Hero at h1; someone changed it to "theirs" (h2).
      draftHolds(queryClient, { Hero: "h1" });
      let failure: unknown;
      await act(async () => {
        await result.current
          .move({ writes: { Banner: { title: "loaded" } }, deletes: ["Hero"] })
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect(asked.deleted.map((q) => q.kind)).toEqual(["youDeleted"]);
      const cached = queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(CACHE_KEY),
      );
      if (choice === "mine") {
        expect(failure).toBeUndefined();
        expect(server.blocks).toEqual({ Banner: { title: "loaded" } });
        expect(cached?.Hero).toBeUndefined();
        expect(cached?.Banner).toEqual({ title: "loaded" });
      } else {
        // Nothing moved: no Banner the draft doesn't have, and the caller
        // undoes its own state.
        expect(failure).toBeDefined();
        expect(server.blocks).toEqual({ Hero: { title: "theirs" } });
        expect(cached?.Hero).toEqual({ title: "theirs" });
        expect(cached?.Banner).toBeUndefined();
      }
    });
  }

  for (const choice of ["mine", "theirs"] as const) {
    for (const when of ["refused", "already read"] as const) {
      it(`a move of a block someone deleted meanwhile asks "Keep my version" / "Leave it deleted" (${choice}, ${when})`, async () => {
        const { queryClient, result } = setupHook(() => useMoveBlocks(params));
        server.draftInRefusal = true;
        server.blocks = {};
        server.versions = { Hero: "tombstone" };
        asked.choice = choice;
        // Refused: the editor read Hero at h1. Already read: a poll brought
        // the deletion, but the editor's copy (a form) still shows Hero.
        if (when === "refused") draftHolds(queryClient, { Hero: "h1" });
        else draftHolds(queryClient, {}, ["Hero"]);
        let failure: unknown;
        await act(async () => {
          await result.current
            .move({
              writes: { Banner: { title: "loaded", name: "Hero banner" } },
              deletes: ["Hero"],
            })
            .catch((error: unknown) => {
              failure = error;
            });
        });
        expect(asked.deleted).toEqual([
          { kind: "theyDeleted", label: "Hero banner" },
        ]);
        const cached = queryClient.getQueryData<Record<string, unknown>>(
          KEYS.decofile(CACHE_KEY),
        );
        if (choice === "mine") {
          expect(failure).toBeUndefined();
          expect(server.blocks).toEqual({
            Banner: { title: "loaded", name: "Hero banner" },
          });
          expect(cached?.Banner).toEqual({
            title: "loaded",
            name: "Hero banner",
          });
        } else {
          // Never brought back under its new name.
          expect(failure).toBeDefined();
          expect(server.blocks).toEqual({});
          // Only the refused attempt (nothing written), or nothing at all.
          expect(server.applied).toHaveLength(when === "refused" ? 1 : 0);
          expect(cached?.Banner).toBeUndefined();
          expect(cached?.Hero).toBeUndefined();
        }
      });
    }
  }

  for (const choice of ["mine", "theirs"] as const) {
    it(`a move built from an editor's own copy is guarded by that copy, so a change it never showed is asked about (${choice})`, async () => {
      const { queryClient, result } = setupHook(() => useMoveBlocks(params));
      server.draftInRefusal = true;
      asked.choice = choice;
      // The editor's form shows Hero as loaded (h1); a poll already read
      // someone else's change (h2), which the form never showed.
      draftHolds(queryClient, { Hero: "h2" });
      queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
        Hero: { title: "theirs" },
      });
      let failure: unknown;
      await act(async () => {
        await result.current
          .move(
            { writes: { Banner: { title: "loaded" } }, deletes: ["Hero"] },
            {
              shown: () => ({
                Hero: { value: { title: "loaded" }, inDraft: true },
              }),
            },
          )
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect(server.applied[0]?.ifMatch).toEqual({
        Banner: null,
        Hero: await draftVersionOf({ title: "loaded" }),
      });
      expect(asked.deleted.map((q) => q.kind)).toEqual(["youDeleted"]);
      if (choice === "theirs") {
        expect(failure).toBeDefined();
        expect(server.blocks).toEqual({ Hero: { title: "theirs" } });
      } else {
        expect(failure).toBeUndefined();
        expect(server.blocks).toEqual({ Banner: { title: "loaded" } });
      }
    });
  }

  it("a save of several blocks built from an editor's own copy merges what only the other side changed", async () => {
    const { queryClient, result } = setupHook(() => useMoveBlocks(params));
    server.draftInRefusal = true;
    server.blocks = { Hero: { title: "loaded", body: "theirs" } };
    server.versions = { Hero: "h2" };
    draftHolds(queryClient, { Hero: "h2" });
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      Hero: { title: "loaded", body: "theirs" },
    });
    await act(async () => {
      await result.current.move(
        { writes: { Hero: { title: "mine", body: "same" } }, deletes: [] },
        {
          shown: () => ({
            Hero: { value: { title: "loaded", body: "same" }, inDraft: true },
          }),
        },
      );
    });
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { Hero: await draftVersionOf({ title: "loaded", body: "same" }) },
      { Hero: "h2" },
    ]);
    expect(asked.fields).toEqual([]);
    expect(server.blocks.Hero).toEqual({ title: "mine", body: "theirs" });
  });

  it("a move is one blocks.apply guarded by the draft's versions", async () => {
    const { queryClient, result } = setupHook(() => useMoveBlocks(params));
    draftHolds(queryClient, { Hero: "h2" });
    await act(async () => {
      await result.current.move({
        writes: { Banner: { title: "loaded" } },
        deletes: ["Hero"],
      });
    });
    expect(server.applied).toEqual([
      {
        set: { Banner: { title: "loaded" } },
        delete: ["Hero"],
        ifMatch: { Banner: null, Hero: "h2" },
      },
    ]);
  });
});
