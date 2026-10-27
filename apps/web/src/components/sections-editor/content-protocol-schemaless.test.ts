import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  type BatchCall,
  type BatchOutcome,
  type ContentClient,
  ContentProtocolError,
  type DescribeResult,
  ErrorCode,
} from "@decocms/blocks/protocol";
import type { ProtocolBackend } from "./content-backend";
import {
  pollProtocolContent,
  protocolMetaQueryKey,
} from "./content-protocol-api";
import type { LiveMeta } from "./resolve-schema";
import { isNoSchemaMeta } from "./schemaless";

const params = {
  orgSlug: "",
  virtualMcpId: "deco-serve",
  branch: "working-tree",
};
const blocks = {
  hero: { __resolveType: "site/sections/Hero.tsx", title: "Hi" },
};
const schema = {
  manifest: { blocks: {} },
  schema: { definitions: {}, root: {} },
};

/** A `deco serve` whose schema the test swaps; it records each batch. */
function fakeServer(initial: "none" | "not-found" | "present") {
  const state = {
    schema: initial as "none" | "not-found" | "present",
    calls: [] as BatchCall[][],
  };
  const schemaOutcome = (call: BatchCall): BatchOutcome => {
    if (state.schema === "not-found") {
      return {
        ok: false,
        error: new ContentProtocolError(ErrorCode.NotFound, "no schema"),
      };
    }
    if (state.schema === "none") {
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
    const ifNoneMatch = (call.params as { ifNoneMatch?: string } | undefined)
      ?.ifNoneMatch;
    return {
      ok: true,
      result:
        ifNoneMatch === "s1"
          ? { notModified: true, version: "s1" }
          : { notModified: false, version: "s1", resolvedRef: null, schema },
    };
  };
  const client = {
    batch: async (calls: BatchCall[]) => {
      state.calls.push(calls);
      return calls.map(
        (call): BatchOutcome =>
          call.method === "schema.get"
            ? schemaOutcome(call)
            : {
                ok: true,
                result: {
                  notModified: false,
                  revision: "r1",
                  resolvedRef: null,
                  blocks,
                  versions: { hero: "v1" },
                  diagnostics: [],
                },
              },
      );
    },
  } as unknown as ContentClient;
  const backend: ProtocolBackend = {
    kind: "protocol",
    source: "local",
    client,
    describe: { pollIntervalMs: 2000 } as DescribeResult,
    cacheKeySuffix: ":serve:test",
    hasSchema: initial === "present",
  };
  return { state, backend };
}

describe("pollProtocolContent without a schema", () => {
  for (const initial of ["none", "not-found"] as const) {
    it(`lists the blocks with an empty, marked schema (${initial}), then picks the schema up`, async () => {
      const queryClient = new QueryClient();
      const { state, backend } = fakeServer(initial);

      const first = await pollProtocolContent(
        queryClient,
        backend,
        params,
        "k",
      );
      expect(first.blocks).toEqual(blocks);
      expect(isNoSchemaMeta(first.meta as LiveMeta)).toBe(true);
      const cached = queryClient.getQueryData<LiveMeta>(
        protocolMetaQueryKey(params, backend),
      );
      expect(isNoSchemaMeta(cached)).toBe(true);

      // The next poll asks for the schema unconditionally: there's no version yet.
      await pollProtocolContent(queryClient, backend, params, "k");
      const second = state.calls[1]!.find((c) => c.method === "schema.get");
      expect(second?.params).toEqual({});

      // `deco schema` ran: the next poll swaps the real schema in.
      state.schema = "present";
      const third = await pollProtocolContent(
        queryClient,
        backend,
        params,
        "k",
      );
      expect(third.meta).toEqual(schema);
      expect(isNoSchemaMeta(third.meta as LiveMeta)).toBe(false);
      expect(
        isNoSchemaMeta(
          queryClient.getQueryData<LiveMeta>(
            protocolMetaQueryKey(params, backend),
          ),
        ),
      ).toBe(false);
    });
  }
});
