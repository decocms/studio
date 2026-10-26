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
      versions[name] = server.versions[name] = `${server.versions[name]}+`;
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
  ) => {
    asked.fields = fields;
    return Object.fromEntries(plan.pointers.map((p) => [p, asked.choice]));
  },
}));

const { useSaveBlock } = await import("./use-save-block");
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
  asked.choice = "mine";
  asked.fields = [];
  asked.deleted = [];
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
      } else {
        expect(server.applied).toHaveLength(1);
        expect(outcome).toEqual({ keptTheirs: true, deleted: false });
        expect(server.blocks.Hero).toEqual({ title: "theirs" });
        expect(heroInCache(queryClient)).toEqual({ title: "theirs" });
      }
    });
  }

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
