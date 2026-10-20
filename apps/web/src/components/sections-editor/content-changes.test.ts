import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  type BatchCall,
  type ContentClient,
  ContentProtocolError,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import {
  adoptChangesList,
  discardContentChanges,
  isChangedMeanwhile,
  isOutdatedServerError,
  readChangeSides,
  readContentChanges,
} from "./content-changes";

const BASE = { revision: "m1", resolvedRef: "main" };
const CACHE_KEY = "acme/p1/feat";

describe("readContentChanges", () => {
  it("asks only whether the list moved, and keeps the list it has when it didn't", async () => {
    const queryClient = new QueryClient();
    const sent: unknown[] = [];
    const client = {
      changesList: async (params: { ifNoneMatch?: string }) => {
        sent.push(params);
        return params.ifNoneMatch === "c1"
          ? { notModified: true, revision: "c1", base: BASE }
          : {
              notModified: false,
              revision: "c1",
              base: BASE,
              changes: {
                Home: { kind: "set", version: "v", baseVersion: "b" },
              },
            };
      },
    } as unknown as ContentClient;
    const first = await readContentChanges(queryClient, client, CACHE_KEY);
    queryClient.setQueryData(KEYS.contentChanges(CACHE_KEY), first);
    const again = await readContentChanges(queryClient, client, CACHE_KEY);
    expect(sent).toEqual([{}, { ifNoneMatch: "c1" }]);
    expect(again).toEqual(first);
    expect(Object.keys(again.changes)).toEqual(["Home"]);
  });

  it("a 'not modified' with nothing to keep is folded into nothing", () => {
    expect(
      adoptChangesList(undefined, {
        notModified: true,
        revision: "c1",
        base: BASE,
      }),
    ).toBeNull();
  });
});

describe("readChangeSides", () => {
  it("reads 20 names per call and a few calls per request", async () => {
    const requests: BatchCall[][] = [];
    const client = {
      batch: async (calls: BatchCall[]) => {
        requests.push(calls);
        return calls.map((call) => ({
          ok: true,
          result: {
            base: BASE,
            entries: Object.fromEntries(
              (call.params as { names: string[] }).names.map((name) => [
                name,
                {
                  kind: "set",
                  before: null,
                  after: {},
                  version: "v",
                  baseVersion: null,
                },
              ]),
            ),
            diagnostics: [],
          },
        }));
      },
    } as unknown as ContentClient;
    const names = Array.from({ length: 130 }, (_, i) => `n${i}`);
    const sides = await readChangeSides(client, names);
    expect(Object.keys(sides.entries)).toHaveLength(130);
    expect(requests.map((calls) => calls.length)).toEqual([5, 2]);
    expect(
      requests
        .flat()
        .map((call) => (call.params as { names: string[] }).names.length),
    ).toEqual([20, 20, 20, 20, 20, 20, 10]);
  });
});

describe("discardContentChanges", () => {
  it("guards every entry by its listed version, 500 names per call", async () => {
    const calls: Array<{
      names: string[];
      ifMatch?: Record<string, string | null>;
    }> = [];
    const client = {
      changesDiscard: async (params: (typeof calls)[number]) => {
        calls.push(params);
        return {
          revision: `r${calls.length}`,
          versions: Object.fromEntries(params.names.map((n) => [n, null])),
        };
      },
    } as unknown as ContentClient;
    const entries = Array.from({ length: 501 }, (_, i) => ({
      name: `n${i}`,
      version: i === 0 ? null : `v${i}`,
    }));
    const result = await discardContentChanges(client, entries);
    expect(calls.map((c) => c.names.length)).toEqual([500, 1]);
    expect(calls[0]!.ifMatch?.n0).toBeNull();
    expect(calls[0]!.ifMatch?.n1).toBe("v1");
    expect(result.revision).toBe("r2");
    expect(Object.keys(result.versions)).toHaveLength(501);
  });
});

describe("errors", () => {
  it("tells an older server from any other refusal", () => {
    expect(
      isOutdatedServerError(
        new ContentProtocolError(ErrorCode.Unsupported, "1.0", {
          reason: "outdated",
        }),
      ),
    ).toBe(true);
    expect(
      isOutdatedServerError(
        new ContentProtocolError(ErrorCode.MethodNotFound, "changes.list"),
      ),
    ).toBe(true);
    expect(
      isOutdatedServerError(
        new ContentProtocolError(ErrorCode.Unsupported, "2.x", {
          reason: "major",
        }),
      ),
    ).toBe(false);
    expect(isOutdatedServerError(new Error("network"))).toBe(false);
    expect(
      isChangedMeanwhile(new ContentProtocolError(ErrorCode.Conflict, "moved")),
    ).toBe(true);
  });
});
