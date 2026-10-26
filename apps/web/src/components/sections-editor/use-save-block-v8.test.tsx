import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterEach, describe, expect, it, mock } from "bun:test";
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
    ifMatch?: Record<string, string | null>;
  }>,
};

const client = {
  blocksApply: async (patch: {
    set?: Record<string, Record<string, unknown>>;
    ifMatch?: Record<string, string | null>;
  }) => {
    server.applied.push(patch);
    for (const [name, expected] of Object.entries(patch.ifMatch ?? {})) {
      const actual = server.versions[name] ?? null;
      if (actual !== expected) {
        throw new ContentProtocolError(ErrorCode.Conflict, "changed", {
          entries: { [name]: { expected, actual } },
        });
      }
    }
    const versions: Record<string, string> = {};
    for (const [name, value] of Object.entries(patch.set ?? {})) {
      server.blocks[name] = value;
      versions[name] = server.versions[name] = `${server.versions[name]}+`;
    }
    return { revision: "r2", versions };
  },
  changesGet: async ({ names }: { names: string[] }) => ({
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
};
mock.module("./named-rule-conflict", () => ({
  canAskNamedRuleConflict: () => true,
  askNamedRuleConflict: async (
    plan: { pointers: string[] },
    fields: Array<{ pointer: string; mine: unknown; theirs: unknown }>,
  ) => {
    asked.fields = fields;
    return Object.fromEntries(plan.pointers.map((p) => [p, asked.choice]));
  },
}));

const { useSaveBlock } = await import("./use-save-block");

afterEach(() => resetContentSync());

/** The editor holds Hero at `h1`; meanwhile another writer stored `theirs` at `h2`. */
function setup() {
  server.blocks = { Hero: { title: "theirs" } };
  server.versions = { Hero: "h2" };
  server.applied = [];
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

  it("a guard without reloadOnConflict keeps the protocol's Conflict and rolls back", async () => {
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
  });
});

describe("saved JSON carries no editor metadata", () => {
  it("a save sends the block exactly as the form holds it: no __meta, no user id", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync({
        blockKey: "Hero",
        data: { title: "mine" },
      });
    });
    expect(server.applied).toEqual([{ set: { Hero: { title: "mine" } } }]);
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
        await act(() =>
          result.current.mutateAsync({
            blockKey: "Promo",
            data: { title: "mine", note: "same" },
            create: true,
          }),
        );
        expect(server.applied.map((p) => p.ifMatch)).toEqual([
          { Promo: null },
          { Promo: "p1" },
        ]);
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
