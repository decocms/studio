import { describe, expect, test } from "bun:test";
import { invalidateVirtualMcpQueries } from "./query-keys.ts";

function capturePredicate(orgId?: string) {
  let predicate: (query: { queryKey: readonly unknown[] }) => boolean = () =>
    false;
  const queryClient = {
    invalidateQueries: (opts: {
      predicate: (query: { queryKey: readonly unknown[] }) => boolean;
    }) => {
      predicate = opts.predicate;
    },
    // biome-ignore lint: minimal fake matching the subset used by the function under test
  } as any;
  invalidateVirtualMcpQueries(queryClient, orgId);
  return predicate;
}

describe("invalidateVirtualMcpQueries", () => {
  test("matches a VIRTUAL_MCP collection key for the given org", () => {
    const predicate = capturePredicate("org_1");
    expect(
      predicate({
        queryKey: ["prefix", "org_1", "scope", "collection", "VIRTUAL_MCP"],
      }),
    ).toBe(true);
  });

  test("rejects a key for a different org when orgId is provided", () => {
    const predicate = capturePredicate("org_1");
    expect(
      predicate({
        queryKey: ["prefix", "org_2", "scope", "collection", "VIRTUAL_MCP"],
      }),
    ).toBe(false);
  });

  test("matches any org when orgId is omitted", () => {
    const predicate = capturePredicate(undefined);
    expect(
      predicate({
        queryKey: ["prefix", "org_2", "scope", "collection", "VIRTUAL_MCP"],
      }),
    ).toBe(true);
  });

  test("rejects non-collection or non-VIRTUAL_MCP keys", () => {
    const predicate = capturePredicate("org_1");
    expect(
      predicate({
        queryKey: ["prefix", "org_1", "scope", "not-collection", "VIRTUAL_MCP"],
      }),
    ).toBe(false);
    expect(
      predicate({
        queryKey: ["prefix", "org_1", "scope", "collection", "OTHER"],
      }),
    ).toBe(false);
  });
});
