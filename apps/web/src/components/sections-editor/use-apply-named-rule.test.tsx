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
import { planNamedRuleRename } from "./rule-references";
import { planNamedRulePick } from "./named-rule-picker";
import type { ProtocolBackend } from "./content-backend";
import { resetContentSync } from "./content-sync";
import * as realBackend from "./use-content-backend";
import * as realDecofile from "./use-decofile";
import * as realSessionRuntime from "@/hooks/use-session-runtime";
import * as realLocalPreview from "@/hooks/use-local-preview-url";

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
  /** The content can't be read. */
  unreachable: false,
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
          : {
              ok: true,
              result: {
                notModified: false,
                revision: "c1",
                base: { revision: "main", resolvedRef: "main" },
                changes: {},
              },
            },
    );
  },
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
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEYS.decofile(CACHE_KEY), { home });
  queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
    home: "home@0",
  });
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
        __resolveType: "date-windows",
        "black-friday": { start: "2026-11-27T00:00:00-03:00" },
      },
      home: page({ __resolveType: "date", campaign: "black-friday" }),
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
      page({ __resolveType: "date", campaign: "Black Friday" }),
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

  it("reads first when the editor hasn't seen a block's version", async () => {
    const { queryClient, result } = setup();
    queryClient.removeQueries({ queryKey: KEYS.contentVersions(CACHE_KEY) });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({ writes: { home: homeWithTest } });
    });
    expect(outcome).toEqual({ ok: false, reason: "changed" });
    expect(server.applied).toEqual([]);
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ home: "home@0" });
  });

  it("removes a test a page still uses: the page then shows it no longer exists", async () => {
    const { queryClient, result } = setup();
    const stored = { home: homeWithTest, experiments };
    server.blocks = { ...stored };
    server.versions = { home: "home@0", experiments: "experiments@0" };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), stored);
    queryClient.setQueryData(KEYS.contentVersions(CACHE_KEY), {
      home: "home@0",
      experiments: "experiments@0",
    });
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
