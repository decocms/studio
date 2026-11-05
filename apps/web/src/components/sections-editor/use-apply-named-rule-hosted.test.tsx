import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  BatchOutcome,
  ContentClient,
  DescribeResult,
} from "@decocms/blocks/protocol";
import type { ProtocolBackend } from "./content-backend";
import { resetContentSync } from "./content-sync";
import type { HostedCall } from "./hosted-content";
import { isIndexStub } from "./hosted-content";
import { namedRuleUseCounts } from "./named-rule-uses";
import { planNamedRuleRename } from "./rule-references";
import * as realBackend from "./use-content-backend";
import * as realDecofile from "./use-decofile";
import * as realSessionRuntime from "@/hooks/use-session-runtime";
import * as realLocalPreview from "@/hooks/use-local-preview-url";

/**
 * A rename or delete on Studio's hosted draft reads the index now and loads
 * only the blocks it says use the name (`meta.rules`), with the tests and
 * campaigns blocks: never every body.
 */

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;

const PAGE = "website/pages/Page.tsx";
const usesHero = (path: string) => ({
  __resolveType: PAGE,
  path,
  sections: {
    __resolveType: "multivariate",
    variants: [
      { rule: { __resolveType: "experiment", name: "hero" }, value: [] },
    ],
  },
});

const server = {
  bodies: {} as Record<string, Record<string, unknown>>,
  metas: {} as Record<string, Record<string, unknown>>,
  blocksCalls: [] as string[][],
};

function reset() {
  server.bodies = {
    experiments: { __resolveType: "split-traffic", hero: 0 },
    home: usesHero("/"),
    about: { __resolveType: PAGE, path: "/about" },
    Header: { __resolveType: "site/sections/Header.tsx" },
    // A saved rule naming the test, and a page that uses it.
    "Hero test": { __resolveType: "experiment", name: "hero" },
    promo: {
      __resolveType: PAGE,
      path: "/promo",
      rule: { __resolveType: "Hero test" },
    },
  };
  // The index's meta, as the server's blockMeta writes it.
  server.metas = {
    experiments: { type: "split-traffic" },
    home: { type: PAGE, path: "/", rules: ["hero"] },
    about: { type: PAGE, path: "/about" },
    Header: { type: "site/sections/Header.tsx" },
    "Hero test": { type: "experiment", rules: ["hero"] },
    promo: { type: PAGE, path: "/promo", refs: ["Hero test"] },
  };
  server.blocksCalls = [];
}

const answer = (call: HostedCall): BatchOutcome => {
  switch (call.method) {
    case "cms.index":
      return {
        ok: true,
        result: {
          notModified: false,
          revision: "t1",
          resolvedRef: "rel-1",
          sequence: 1,
          entries: Object.fromEntries(
            Object.keys(server.bodies).map((name) => [
              name,
              { version: `v-${name}`, meta: server.metas[name] },
            ]),
          ),
          draft: {},
        },
      };
    case "cms.blocks": {
      const names = (call.params as { names: string[] }).names;
      server.blocksCalls.push(names);
      return {
        ok: true,
        result: {
          blocks: Object.fromEntries(
            names.map((name) => [name, structuredClone(server.bodies[name])]),
          ),
          versions: Object.fromEntries(
            names.map((name) => [name, `v-${name}`]),
          ),
          missing: [],
        },
      };
    }
    case "changes.list":
      return {
        ok: true,
        result: {
          notModified: false,
          revision: "t1",
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

const backend: ProtocolBackend = {
  kind: "protocol",
  source: "github",
  client: {
    batch: async () => {
      throw new Error("the hosted editor reads through cms.index");
    },
  } as unknown as ContentClient,
  describe: {} as DescribeResult,
  cacheKeySuffix: "",
  hosted: { batch: async (calls: HostedCall[]) => calls.map(answer) },
};

const restore = [
  ["./use-content-backend", { ...realBackend }],
  ["./use-decofile", { ...realDecofile }],
  ["@/hooks/use-session-runtime", { ...realSessionRuntime }],
  ["@/hooks/use-local-preview-url", { ...realLocalPreview }],
] as const;
afterAll(() => {
  for (const [path, real] of restore) mock.module(path, () => real);
});
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

const { useApplyNamedRule } = await import("./use-apply-named-rule");

afterEach(() => resetContentSync());

function setup() {
  reset();
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => useApplyNamedRule({ orgSlug: ORG, virtualMcpId: VM, branch: BRANCH }),
    { wrapper },
  );
  return { result };
}

const loadedNames = () => server.blocksCalls.flat().sort();

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
const meta = {
  manifest: {
    blocks: {
      matchers: { experiment: builtIn, campaign: builtIn },
      content: { "split-traffic": builtIn, calendar: builtIn },
      pages: {},
    },
  },
  schema: {},
} as never;

describe("a rename or delete on the hosted draft", () => {
  it("a rename loads the tests and the name's users only, and rewrites them", async () => {
    const { result } = setup();
    let change: Awaited<ReturnType<typeof result.current.planStored>> = null;
    await act(async () => {
      change = await result.current.planStored(
        (stored) =>
          planNamedRuleRename(stored, "experiments", "hero", "launch", meta),
        { usersOf: ["hero"] },
      );
    });
    expect(loadedNames()).toEqual(["Hero test", "experiments", "home"]);
    expect(Object.keys(change!.writes).sort()).toEqual([
      "Hero test",
      "experiments",
      "home",
    ]);
  });

  it("a delete's read counts every use from the index, loading only the users", async () => {
    const { result } = setup();
    let fresh: Record<string, unknown> | null = null;
    await act(async () => {
      fresh = await result.current.reread({ usersOf: ["hero"] });
    });
    expect(loadedNames()).toEqual(["Hero test", "experiments", "home"]);
    // promo (through the saved rule) is counted from its stub.
    expect(isIndexStub(fresh!.promo)).toBe(true);
    expect(namedRuleUseCounts(fresh!, meta, "experiments", "hero")).toEqual({
      pages: 2,
      sections: 0,
    });
  });

  it("an Undo's read loads only the tests and campaigns blocks", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.reread();
    });
    expect(loadedNames()).toEqual(["experiments"]);
  });
});
