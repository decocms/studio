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
import { planNamedRuleRename } from "./rule-references";
import { planNamedRulePick } from "./named-rule-picker";
import type { ProtocolBackend } from "./content-backend";
import { resetContentSync } from "./content-sync";
import * as realBackend from "./use-content-backend";
import * as realDecofile from "./use-decofile";
import * as realSessionRuntime from "@/hooks/use-session-runtime";
import * as realNamedRuleConflict from "./named-rule-conflict";
import * as realLocalPreview from "@/hooks/use-local-preview-url";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;

/**
 * The hosted draft's changes (`changes.list`): every stored entry is the
 * draft's here, so a guard is its stored version, as on any backend.
 */
function listedChanges() {
  return {
    notModified: false,
    revision: `c-${server.applied.length}`,
    base: { revision: "main", resolvedRef: "main" },
    changes: Object.fromEntries(
      Object.entries(server.versions).map(([name, version]) => [
        name,
        { kind: "set", version, baseVersion: null },
      ]),
    ),
  };
}

/** A content server whose entries carry versions; a stale `ifMatch` is a Conflict. */
const server = {
  blocks: {} as Record<string, Record<string, unknown>>,
  versions: {} as Record<string, string>,
  applied: [] as Array<{
    set?: Record<string, unknown>;
    delete?: string[];
    ifMatch?: Record<string, string | null>;
  }>,
  /** The content can't be read. */
  unreachable: false,
  /** Holds the next `blocks.apply` until resolved (a slow write). */
  gate: null as Promise<void> | null,
  /** A refusal carries the draft's copies, as Studio's hosted route answers. */
  draftInRefusal: false,
  /** Reads of the content (polls and `changes.get`). */
  reads: 0,
};

const client = {
  blocksApply: async (patch: {
    set?: Record<string, Record<string, unknown>>;
    delete?: string[];
    ifMatch?: Record<string, string | null>;
  }) => {
    if (server.gate) {
      const gate = server.gate;
      server.gate = null;
      await gate;
    }
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
    for (const [name, value] of Object.entries(patch.set ?? {})) {
      server.blocks[name] = value;
      versions[name] = server.versions[name] =
        `${name}@${server.applied.length}`;
    }
    for (const name of patch.delete ?? []) {
      delete server.blocks[name];
      delete server.versions[name];
      versions[name] = null;
    }
    return { revision: `r${server.applied.length}`, versions };
  },
  changesGet: async ({ names }: { names: string[] }) => ({
    _read: server.reads++,
    base: { revision: "main", resolvedRef: "main" },
    entries: Object.fromEntries(
      names
        .filter((name) => server.blocks[name])
        .map((name) => [
          name,
          {
            kind: "set",
            before: null,
            after: server.blocks[name],
            version: server.versions[name],
            baseVersion: null,
          },
        ]),
    ),
    diagnostics: [],
  }),
  // The content poll (`blocks.list`, `schema.get`, `changes.list`).
  batch: async (calls: Array<{ method: string }>) => {
    server.reads++;
    if (server.unreachable) throw new Error("offline");
    return calls.map((call) =>
      call.method === "blocks.list"
        ? {
            ok: true,
            result: {
              notModified: false,
              revision: `r-stored-${server.applied.length}`,
              resolvedRef: null,
              blocks: server.blocks,
              versions: server.versions,
            },
          }
        : call.method === "schema.get"
          ? {
              ok: true,
              result: { notModified: false, version: "s1", schema: {} },
            }
          : { ok: true, result: listedChanges() },
    );
  },
  changesList: async () => listedChanges(),
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
/** The reconcile dialog's answer, as the user would pick; null: no dialog. */
const conflictHost = {
  answer: null as
    | ((plan: { pointers: string[] }) => Record<string, "mine" | "theirs">)
    | null,
  asked: [] as Array<{ pointers: string[] }>,
  /** The fields and the block each values question was asked with. */
  shown: [] as Array<{
    fields: Array<{
      label: string;
      phrase?: string;
      mine?: unknown;
      theirs?: unknown;
    }>;
    about?: { author?: { blockKey: string } | null };
  }>,
  deleted: [] as Array<{ kind: string; label: string }>,
  /** The pointer a deleted-block question stands for. */
  deletedPointer: "",
};
// The real dialog module, restored for the test files that run after this
// one in the same process (named-rule-conflict.test.tsx renders it).
const namedRuleConflict = { ...realNamedRuleConflict };
afterAll(() => {
  mock.module("./named-rule-conflict", () => namedRuleConflict);
});
mock.module("./named-rule-conflict", () => ({
  canAskNamedRuleConflict: () => conflictHost.answer !== null,
  askNamedRuleConflict: async (
    plan: { pointers: string[] },
    fields: Array<{ label: string; phrase?: string }>,
    about?: { author?: { blockKey: string } | null },
  ) => {
    conflictHost.asked.push(plan);
    conflictHost.shown.push({ fields, about });
    return conflictHost.answer!(plan);
  },
  // A whole block one side deleted: the same answer, for its one value.
  askDeletedConflict: async (conflict: { kind: string; label: string }) => {
    conflictHost.deleted.push(conflict);
    const plan = { pointers: [conflictHost.deletedPointer] };
    conflictHost.asked.push(plan);
    return conflictHost.answer!(plan)[conflictHost.deletedPointer];
  },
}));
mock.module("@/hooks/use-session-runtime", () => ({
  ...realSessionRuntime,
  useSessionRuntime: () => ({ runtime: null }),
}));
mock.module("@/hooks/use-local-preview-url", () => ({
  ...realLocalPreview,
  useLocalPreviewUrl: () => ({ url: null }),
}));

const { planNamedRuleApply, useApplyNamedRule } = await import(
  "./use-apply-named-rule"
);
const { copyScope, useCopyEpochs } = await import("./held-copy");
const { pollProtocolContent, useRereadOnWriteElsewhere } = await import(
  "./content-protocol-api"
);

afterEach(() => resetContentSync());

const page = (rule: Record<string, unknown>) => ({
  __resolveType: "page",
  sections: {
    __resolveType: "multivariate",
    experiment: "hero",
    variants: [
      { rule, value: { __resolveType: "lazy", value: [] } },
      {
        rule: { __resolveType: "always" },
        value: { __resolveType: "lazy", value: [] },
      },
    ],
  },
});
const home = page({ __resolveType: "always" });
const homeWithTest = page({ __resolveType: "experiment", name: "hero" });
const experiments = { __resolveType: "split-traffic", hero: 50 };

/** The editor read `home` at `home@0` and no `experiments`. */
function setup() {
  server.blocks = { home };
  server.versions = { home: "home@0" };
  server.applied = [];
  server.unreachable = false;
  server.gate = null;
  server.draftInRefusal = false;
  server.reads = 0;
  conflictHost.answer = null;
  conflictHost.asked = [];
  conflictHost.shown = [];
  conflictHost.deleted = [];
  conflictHost.deletedPointer = "";
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEYS.decofile(CACHE_KEY), { home });
  queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
    home: "home@0",
  });
  queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), listedChanges());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => useApplyNamedRule({ orgSlug: ORG, virtualMcpId: VM, branch: BRANCH }),
    { wrapper },
  );
  return { queryClient, result };
}

const cached = (queryClient: QueryClient) =>
  queryClient.getQueryData<Record<string, unknown>>(KEYS.decofile(CACHE_KEY));

describe("planNamedRuleApply", () => {
  it("guards every block it writes or deletes", () => {
    const versions: Record<string, string | null> = {
      experiments: null,
      home: "h1",
      old: "o1",
    };
    expect(
      planNamedRuleApply(
        {
          writes: { experiments, home: homeWithTest },
          deletes: ["old", "home"],
        },
        (key) => versions[key],
      ),
    ).toEqual({
      kind: "apply",
      patch: {
        set: { experiments, home: homeWithTest },
        delete: ["old"],
      },
      ifMatch: { experiments: null, home: "h1", old: "o1" },
    });
  });

  it("guards a campaign rename: the block and every page that names it", () => {
    const draft = {
      campaigns: {
        __resolveType: "calendar",
        "black-friday": { start: "2026-11-27T00:00:00-03:00" },
      },
      home: page({ __resolveType: "campaign", name: "black-friday" }),
      about: page({ __resolveType: "always" }),
    };
    const rename = planNamedRuleRename(
      draft,
      "campaigns",
      "black-friday",
      "Black Friday",
    )!;
    const plan = planNamedRuleApply(rename, (key) => `${key}@3`);
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.ifMatch).toEqual({
      campaigns: "campaigns@3",
      home: "home@3",
    });
    expect(plan.patch.set?.home).toEqual(
      page({ __resolveType: "campaign", name: "Black Friday" }),
    );
  });

  it("asks for a read when a block's version isn't known yet", () => {
    expect(planNamedRuleApply({ writes: { home } }, () => undefined)).toEqual({
      kind: "unread",
      blockKeys: ["home"],
    });
  });
});

describe("useApplyNamedRule", () => {
  it("creates a test and the rule that uses it in one guarded write", async () => {
    const { queryClient, result } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { experiments, home: homeWithTest },
      });
    });
    expect(outcome).toEqual({ ok: true });
    expect(server.applied).toEqual([
      {
        set: { experiments, home: homeWithTest },
        ifMatch: { experiments: null, home: "home@0" },
      },
    ]);
    expect(cached(queryClient)).toEqual({
      home: homeWithTest,
      experiments,
    });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ experiments: "experiments@1", home: "home@1" });
  });

  it("a test created in the rule picker lands with the page in one guarded write", async () => {
    const { result } = setup();
    const plan = planNamedRulePick(
      { home },
      { kind: "experiments", name: "hero", create: { share: 50 } },
    );
    if (!plan.ok || !plan.blockWrite) throw new Error("expected a create");
    const carrier = page(plan.rule);
    await act(async () => {
      await result.current.apply({
        writes: {
          home: carrier,
          [plan.blockWrite!.blockKey]: plan.blockWrite!.block,
        },
      });
    });
    expect(server.applied).toEqual([
      {
        set: { home: homeWithTest, experiments },
        ifMatch: { home: "home@0", experiments: null },
      },
    ]);
  });

  it("writes nothing over a test created meanwhile, and shows what is stored", async () => {
    const { queryClient, result } = setup();
    const theirs = { __resolveType: "split-traffic", banner: 10 };
    server.blocks.experiments = theirs;
    server.versions.experiments = "theirs@1";
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { experiments, home: homeWithTest },
      });
    });
    expect(outcome).toEqual({ ok: false, reason: "changed" });
    // Neither block was written: the page keeps its rule, theirs is intact.
    expect(server.blocks).toEqual({ home, experiments: theirs });
    expect(cached(queryClient)).toEqual({ home, experiments: theirs });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ home: "home@0", experiments: "theirs@1" });
  });

  it("writes nothing when the page changed meanwhile", async () => {
    const { queryClient, result } = setup();
    const edited = { ...home, path: "/new" };
    server.blocks.home = edited;
    server.versions.home = "home@9";
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { experiments, home: homeWithTest },
      });
    });
    expect(outcome).toEqual({ ok: false, reason: "changed" });
    expect(server.blocks.experiments).toBeUndefined();
    expect(cached(queryClient)).toEqual({ home: edited });
  });

  it("reads first when the editor hasn't seen a block's version, then saves the block it still holds as stored", async () => {
    const { queryClient, result } = setup();
    queryClient.removeQueries({ queryKey: KEYS.contentVersions(CACHE_KEY) });
    queryClient.removeQueries({ queryKey: KEYS.contentChanges(CACHE_KEY) });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { home: homeWithTest } });
    });
    expect(outcome).toEqual({ ok: true });
    expect(server.applied).toEqual([
      { set: { home: homeWithTest }, ifMatch: { home: "home@0" } },
    ]);
  });

  it("reads first when the editor hasn't seen a block's version, and writes nothing when someone changed it", async () => {
    const { queryClient, result } = setup();
    queryClient.removeQueries({ queryKey: KEYS.contentVersions(CACHE_KEY) });
    queryClient.removeQueries({ queryKey: KEYS.contentChanges(CACHE_KEY) });
    const edited = { ...home, path: "/new" };
    server.blocks.home = edited;
    server.versions.home = "home@9";
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { home: homeWithTest } });
    });
    expect(outcome).toEqual({ ok: false, reason: "changed" });
    expect(server.applied).toEqual([]);
    expect(cached(queryClient)).toEqual({ home: edited });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ home: "home@9" });
  });

  it("a rule picked while the editor's earlier save of the page is on its way expects that save's version", async () => {
    const { queryClient, result } = setup();
    // "Add variant": a save of the page, slow to answer.
    const withVariant = {
      ...home,
      sections: {
        ...home.sections,
        variants: [...home.sections.variants, home.sections.variants[1]],
      },
    };
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = result.current.apply({ writes: { home: withVariant } });
      await Promise.resolve();
    });
    // The rule is picked on the page as the editor shows it, variant included.
    const ruled = {
      ...withVariant,
      sections: {
        ...withVariant.sections,
        variants: [
          {
            ...withVariant.sections.variants[0],
            rule: { __resolveType: "experiment", name: "hero" },
          },
          ...withVariant.sections.variants.slice(1),
        ],
      },
    };
    expect(cached(queryClient)?.home).toEqual(withVariant);
    await act(async () => {
      second = result.current.apply({ writes: { home: ruled, experiments } });
      await Promise.resolve();
      release();
    });
    await act(async () => {
      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: true });
    });
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { home: "home@0" },
      { home: "home@1", experiments: null },
    ]);
    expect(server.blocks.home).toEqual(ruled);
  });

  it("a rule waiting behind the editor's earlier save is still refused when someone else changed the page meanwhile", async () => {
    const { queryClient, result } = setup();
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = result.current.apply({ writes: { experiments } });
      await Promise.resolve();
    });
    await act(async () => {
      second = result.current.apply({ writes: { home: homeWithTest } });
      await Promise.resolve();
    });
    // Someone else saves the page, and a poll lists it while the rule waits.
    const theirs = { ...home, path: "/theirs" };
    server.blocks.home = theirs;
    server.versions.home = "home@theirs";
    await act(async () => {
      await pollProtocolContent(
        queryClient,
        backend,
        { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH },
        CACHE_KEY,
      );
      release();
    });
    await act(async () => {
      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: false, reason: "changed" });
    });
    expect(server.blocks.home).toEqual(theirs);
    expect(cached(queryClient)?.home).toEqual(theirs);
  });

  it("removes a test a page still uses: the page then shows it isn't there", async () => {
    const { queryClient, result } = setup();
    const stored = { home: homeWithTest, experiments };
    server.blocks = { ...stored };
    server.versions = { home: "home@0", experiments: "experiments@0" };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), stored);
    queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
      home: "home@0",
      experiments: "experiments@0",
    });
    queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), listedChanges());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { experiments: { __resolveType: "split-traffic" } },
      });
    });
    expect(outcome).toEqual({ ok: true });
    expect(server.applied).toHaveLength(1);
    expect(cached(queryClient)).toEqual({
      home: homeWithTest,
      experiments: { __resolveType: "split-traffic" },
    });
  });

  it("reread answers the draft as stored, not the editor's older copy, and adopts its versions", async () => {
    const { queryClient, result } = setup();
    // Another tab added a page using "hero" after this editor read.
    server.blocks = { home, promo: homeWithTest, experiments };
    server.versions = {
      home: "home@0",
      promo: "promo@1",
      experiments: "experiments@1",
    };
    const fresh: { value: Record<string, unknown> | null } = { value: null };
    await act(async () => {
      fresh.value = await result.current.reread();
    });
    expect(fresh.value).toEqual({ home, promo: homeWithTest, experiments });
    expect(cached(queryClient)).toEqual({
      home,
      promo: homeWithTest,
      experiments,
    });
    // A write planned from it is guarded by the versions it came with.
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ experiments: "experiments@1" });
  });

  it("reread is null when the content can't be read, so nothing is planned from a guess", async () => {
    const { result } = setup();
    server.unreachable = true;
    const fresh: { value: Record<string, unknown> | null } = { value: {} };
    await act(async () => {
      fresh.value = await result.current.reread();
    });
    expect(fresh.value).toBeNull();
  });

  it("a rename planned from the stored draft renames a use another tab added", async () => {
    const { queryClient, result } = setup();
    // A paused test (a running one keeps its name).
    const experiments = { __resolveType: "split-traffic", hero: 0 };
    // This editor holds `home` and `experiments`; another tab then put
    // "hero" on `promo`, which this editor hasn't read.
    server.blocks = { home, experiments };
    server.versions = { home: "home@0", experiments: "experiments@0" };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), { home, experiments });
    queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
      home: "home@0",
      experiments: "experiments@0",
    });
    server.blocks = { home, promo: homeWithTest, experiments };
    server.versions = {
      home: "home@0",
      promo: "promo@1",
      experiments: "experiments@0",
    };
    let outcome: unknown;
    await act(async () => {
      const change = await result.current.planStored((stored) =>
        planNamedRuleRename(stored, "experiments", "hero", "launch"),
      );
      outcome = change ? await result.current.apply(change) : null;
    });
    expect(outcome).toEqual({ ok: true });
    // Nothing is left naming "hero".
    expect(server.blocks.experiments).toEqual({
      __resolveType: "split-traffic",
      launch: 0,
    });
    expect(server.blocks.promo).toEqual(
      page({ __resolveType: "experiment", name: "launch" }),
    );
    expect(server.applied.at(-1)?.ifMatch).toMatchObject({
      experiments: "experiments@0",
      promo: "promo@1",
    });
  });

  it("plans nothing when the draft can't be read", async () => {
    const { result } = setup();
    server.unreachable = true;
    const plan = mock(() => ({ writes: {} }));
    let change: unknown = "unset";
    await act(async () => {
      change = await result.current.planStored(plan);
    });
    expect(change).toBeNull();
    expect(plan).not.toHaveBeenCalled();
    expect(server.applied).toEqual([]);
  });
});

describe("two views of one draft (tabs or windows)", () => {
  it("a test created in one view right after another view saved the tests lands, keeping that save", async () => {
    server.blocks = { home, experiments };
    server.versions = { home: "home@0", experiments: "experiments@0" };
    server.applied = [];
    server.unreachable = false;
    server.gate = null;
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), { home, experiments });
    queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
      home: "home@0",
      experiments: "experiments@0",
    });
    const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        useRereadOnWriteElsewhere(backend, params, CACHE_KEY);
        return useApplyNamedRule(params);
      },
      { wrapper },
    );
    // The other view moves the share slider and saves; it tells the others.
    server.blocks.experiments = { ...experiments, hero: 30 };
    server.versions.experiments = "experiments@other";
    const otherView = new BroadcastChannel("decocms:content-writes");
    otherView.postMessage({ cacheKey: CACHE_KEY });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    otherView.close();
    // This view then creates a test from what it holds.
    const held = cached(queryClient)?.experiments as Record<string, unknown>;
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { experiments: { ...held, promo: 50 } },
      });
    });
    expect(outcome).toEqual({ ok: true });
    expect(server.blocks.experiments).toEqual({
      __resolveType: "split-traffic",
      hero: 30,
      promo: 50,
    });
  });
});

describe("useApplyNamedRule: reconcile (someone else saved first)", () => {
  it("guards a block the hosted draft doesn't hold with null, whatever main has", async () => {
    const { queryClient, result } = setup();
    // The editor read `home` from main: the draft holds nothing yet.
    server.versions = {};
    queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), listedChanges());
    await act(async () => {
      await result.current.apply({ writes: { home: homeWithTest } });
    });
    expect(server.applied.map((p) => p.ifMatch)).toEqual([{ home: null }]);
  });

  it("merges a change to other values on its own and saves it, guarded by what was read", async () => {
    const { queryClient, result } = setup();
    conflictHost.answer = () => ({});
    const theirs = { ...home, path: "/theirs" };
    server.blocks.home = theirs;
    server.versions.home = "home@9";
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { home: homeWithTest } });
    });
    expect(outcome).toEqual({ ok: true });
    expect(conflictHost.asked).toEqual([]);
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { home: "home@0" },
      { home: "home@9" },
    ]);
    // Their path and this change's rule, both.
    expect(server.blocks.home).toEqual({ ...homeWithTest, path: "/theirs" });
    expect(cached(queryClient)?.home).toEqual({
      ...homeWithTest,
      path: "/theirs",
    });
  });

  it("asks about a test both changed, and saves the version picked", async () => {
    const { result } = setup();
    server.blocks.experiments = { __resolveType: "split-traffic", hero: 10 };
    server.versions.experiments = "theirs@1";
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "mine" as const]));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { experiments } });
    });
    expect(outcome).toEqual({ ok: true });
    expect(conflictHost.asked.map((plan) => plan.pointers)).toEqual([
      ["/experiments/hero"],
    ]);
    expect(server.blocks.experiments).toEqual(experiments);
    expect(server.applied.at(-1)?.ifMatch).toEqual({
      experiments: "theirs@1",
    });
  });

  it("names the test by its name and asks who changed the tests, never a path", async () => {
    const { result } = setup();
    server.blocks.experiments = { __resolveType: "split-traffic", hero: 10 };
    server.versions.experiments = "theirs@1";
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "mine" as const]));
    await act(async () => {
      await result.current.apply({ writes: { experiments } });
    });
    const [shown] = conflictHost.shown;
    expect(shown?.fields.map((f) => [f.label, f.phrase])).toEqual([
      ['A/B test "hero"', 'the A/B test "hero"'],
    ]);
    expect(shown?.about?.author?.blockKey).toBe("experiments");
  });

  it("on the hosted draft, asks from the copy the refusal carries: nothing is read", async () => {
    const { result } = setup();
    server.draftInRefusal = true;
    server.blocks.experiments = { __resolveType: "split-traffic", hero: 10 };
    server.versions.experiments = "theirs@1";
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "mine" as const]));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { experiments } });
    });
    expect(outcome).toEqual({ ok: true });
    expect(conflictHost.asked.map((plan) => plan.pointers)).toEqual([
      ["/experiments/hero"],
    ]);
    expect(server.reads).toBe(0);
    expect(server.blocks.experiments).toEqual(experiments);
    expect(server.applied.at(-1)?.ifMatch).toEqual({
      experiments: "theirs@1",
    });
  });

  it("on the hosted draft, a test deleted in the draft is a whole-block choice, guarded by its tombstone", async () => {
    const { result } = setup();
    server.draftInRefusal = true;
    // The draft holds the deletion: "must not exist" no longer holds.
    server.versions.experiments = "tombstone";
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "mine" as const]));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { experiments } });
    });
    expect(outcome).toEqual({ ok: true });
    expect(server.reads).toBe(0);
    expect(server.applied.map((p) => p.ifMatch)).toEqual([
      { experiments: null },
      { experiments: "tombstone" },
    ]);
    expect(server.blocks.experiments).toEqual(experiments);
  });

  it("keeps theirs when picked: their test stays as they saved it", async () => {
    const { result } = setup();
    const theirs = { __resolveType: "split-traffic", hero: 10 };
    server.blocks.experiments = theirs;
    server.versions.experiments = "theirs@1";
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "theirs" as const]));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { experiments } });
    });
    expect(server.blocks.experiments).toEqual(theirs);
    // Nothing more is written, and the outcome says their version was kept.
    expect(server.applied).toHaveLength(1);
    expect(outcome).toEqual({ ok: true, keptTheirs: true });
  });

  it('a block they removed while it was changed here asks "Keep my version" / "Leave it deleted"', async () => {
    const { result } = setup();
    delete server.blocks.home;
    delete server.versions.home;
    conflictHost.deletedPointer = "/home";
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "theirs" as const]));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { home: homeWithTest } });
    });
    expect(conflictHost.asked.map((plan) => plan.pointers)).toEqual([
      ["/home"],
    ]);
    expect(conflictHost.deleted.map((q) => q.kind)).toEqual(["theyDeleted"]);
    // Theirs: the page stays removed, nothing more is written.
    expect(outcome).toEqual({ ok: true, keptTheirs: true });
    expect(server.blocks.home).toBeUndefined();
  });
});

describe("useApplyNamedRule: a change built on the copy an editor shows (hosted v8)", () => {
  const seed = {
    __resolveType: "calendar",
    bf: {
      start: "2026-11-27T00:00:00-03:00",
      end: "2026-12-01T00:00:00-03:00",
    },
  };
  const bruno = {
    __resolveType: "calendar",
    bf: { ...seed.bf, end: "2026-12-16T18:00:00-03:00" },
  };
  const ana = {
    __resolveType: "calendar",
    bf: { ...seed.bf, end: "2026-12-10T18:00:00-03:00" },
  };

  /** A poll already brought Bruno's dates; the form still shows the seed. */
  function setupPolled() {
    const setup$ = setup();
    server.blocks.campaigns = bruno;
    server.versions.campaigns = "campaigns@bruno";
    setup$.queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      home,
      campaigns: bruno,
    });
    setup$.queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
      home: "home@0",
      campaigns: "campaigns@bruno",
    });
    setup$.queryClient.setQueryData(
      KEYS.contentChanges(CACHE_KEY),
      listedChanges(),
    );
    return setup$;
  }

  it("asks about a value the draft changed since the copy was shown, never writes over it", async () => {
    const { result } = setupPolled();
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "theirs" as const]));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { campaigns: ana },
        basis: { campaigns: seed },
      });
    });
    expect(conflictHost.asked.map((plan) => plan.pointers)).toEqual([
      ["/campaigns/bf/end"],
    ]);
    expect(server.applied).toHaveLength(0);
    expect(server.blocks.campaigns).toEqual(bruno);
    expect(outcome).toEqual({ ok: true, keptTheirs: true });
  });

  it("saves as before when the draft still holds the copy shown", async () => {
    const { result } = setupPolled();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { campaigns: ana },
        basis: { campaigns: bruno },
      });
    });
    expect(outcome).toEqual({ ok: true });
    expect(conflictHost.asked).toHaveLength(0);
    expect(server.blocks.campaigns).toEqual(ana);
    expect(server.applied.at(-1)?.ifMatch).toEqual({
      campaigns: "campaigns@bruno",
    });
  });

  it("after any reconcile, the editors of the blocks it touched show the draft's copy again", async () => {
    const { result, queryClient } = setupPolled();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const epochs = renderHook(
      () =>
        useCopyEpochs(
          copyScope({ orgSlug: ORG, virtualMcpId: VM, branch: BRANCH }),
        ),
      { wrapper },
    );
    const before = epochs.result.current("campaigns");
    conflictHost.answer = (plan) =>
      Object.fromEntries(plan.pointers.map((p) => [p, "theirs" as const]));
    await act(async () => {
      await result.current.apply({
        writes: { campaigns: ana },
        basis: { campaigns: seed },
      });
      // Bumped once the cache's readers rendered (the next tick).
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(epochs.result.current("campaigns")).toBe(before + 1);
  });

  for (const language of ["en", "pt-BR"] as const) {
    it(`shows the campaign's dates as dates, never raw ISO (${language})`, async () => {
      localStorage.setItem(
        "studio:user:preferences",
        JSON.stringify({ language }),
      );
      try {
        const { result } = setupPolled();
        conflictHost.answer = (plan) =>
          Object.fromEntries(plan.pointers.map((p) => [p, "theirs" as const]));
        await act(async () => {
          await result.current.apply({
            writes: { campaigns: ana },
            basis: { campaigns: seed },
          });
        });
        const format = new Intl.DateTimeFormat(language, {
          dateStyle: "medium",
          timeStyle: "short",
        });
        const [field] = conflictHost.shown[0]!.fields;
        expect(field?.mine).toBe(format.format(new Date(ana.bf.end)));
        expect(field?.theirs).toBe(format.format(new Date(bruno.bf.end)));
        expect(String(field?.theirs)).not.toContain("T18:00");
      } finally {
        localStorage.removeItem("studio:user:preferences");
      }
    });
  }
});
