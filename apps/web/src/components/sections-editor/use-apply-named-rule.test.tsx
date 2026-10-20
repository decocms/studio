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
const experiments = { __resolveType: "experiments", hero: 50 };

/** The editor read `home` at `home@0` and no `Experiments`. */
function setup() {
  server.blocks = { home };
  server.versions = { home: "home@0" };
  server.applied = [];
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
      Experiments: null,
      home: "h1",
      old: "o1",
    };
    expect(
      planNamedRuleApply(
        {
          writes: { Experiments: experiments, home: homeWithTest },
          deletes: ["old", "home"],
        },
        (key) => versions[key],
      ),
    ).toEqual({
      kind: "apply",
      patch: {
        set: { Experiments: experiments, home: homeWithTest },
        delete: ["old"],
      },
      ifMatch: { Experiments: null, home: "h1", old: "o1" },
    });
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
        writes: { Experiments: experiments, home: homeWithTest },
      });
    });
    expect(outcome).toEqual({ ok: true });
    expect(server.applied).toEqual([
      {
        set: { Experiments: experiments, home: homeWithTest },
        ifMatch: { Experiments: null, home: "home@0" },
      },
    ]);
    expect(cached(queryClient)).toEqual({
      home: homeWithTest,
      Experiments: experiments,
    });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ Experiments: "Experiments@1", home: "home@1" });
  });

  it("writes nothing over a test created meanwhile, and shows what is stored", async () => {
    const { queryClient, result } = setup();
    const theirs = { __resolveType: "experiments", banner: 10 };
    server.blocks.Experiments = theirs;
    server.versions.Experiments = "theirs@1";
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { Experiments: experiments, home: homeWithTest },
      });
    });
    expect(outcome).toEqual({ ok: false, reason: "changed" });
    // Neither block was written: the page keeps its rule, theirs is intact.
    expect(server.blocks).toEqual({ home, Experiments: theirs });
    expect(cached(queryClient)).toEqual({ home, Experiments: theirs });
    expect(
      queryClient.getQueryData(KEYS.contentVersions(CACHE_KEY)),
    ).toMatchObject({ home: "home@0", Experiments: "theirs@1" });
  });

  it("writes nothing when the page changed meanwhile", async () => {
    const { queryClient, result } = setup();
    const edited = { ...home, path: "/new" };
    server.blocks.home = edited;
    server.versions.home = "home@9";
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.apply({
        writes: { Experiments: experiments, home: homeWithTest },
      });
    });
    expect(outcome).toEqual({ ok: false, reason: "changed" });
    expect(server.blocks.Experiments).toBeUndefined();
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
});
