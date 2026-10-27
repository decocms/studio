import { describe, expect, it } from "bun:test";
import {
  createRequestCachedVirtualMcps,
  escapeLikePattern,
  type VirtualMCPStorage,
} from "./virtual";

/**
 * The cross-org search box interpolates a user-typed term into a LIKE pattern.
 * Every case here is a term someone can type into the sidebar.
 */
describe("escapeLikePattern", () => {
  it("leaves an ordinary term alone", () => {
    expect(escapeLikePattern("checkout")).toBe("checkout");
    expect(escapeLikePattern("Storefront BR")).toBe("Storefront BR");
  });

  it("escapes the wildcard that would match every project in every org", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("50% off")).toBe("50\\% off");
  });

  it("escapes the single-character wildcard", () => {
    expect(escapeLikePattern("_")).toBe("\\_");
    expect(escapeLikePattern("my_project")).toBe("my\\_project");
  });

  /** Unescaped, `\%` reaches Postgres as a backslash escaping OUR percent. */
  it("escapes a backslash, so it cannot escape our own escapes", () => {
    expect(escapeLikePattern("\\")).toBe("\\\\");
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  /** `a\_b` → backslash doubled first, then the underscore escaped. */
  it("escapes the backslash first, so no escape is double-processed", () => {
    expect(escapeLikePattern("a\\_b")).toBe("a\\\\\\_b");
  });

  it("handles the empty term", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});

/**
 * createRequestCachedVirtualMcps memoizes `list` for the request. A write
 * that bypasses the memoized method (e.g. a metadata patch issued after an
 * earlier `list()` call in the same request) must still invalidate the
 * cache, or a later `list()` in that same request would replay stale data.
 */
describe("createRequestCachedVirtualMcps cache invalidation", () => {
  const makeBase = () => {
    let listCalls = 0;
    const base = {
      list: async () => {
        listCalls++;
        return [{ id: `call-${listCalls}` }];
      },
      patchMetadata: async () => true,
      clearAnalyticsSiteSlugReferences: async () => 1,
    } as unknown as VirtualMCPStorage;
    return { base, getListCalls: () => listCalls };
  };

  it("invalidates the list cache after patchMetadata", async () => {
    const { base } = makeBase();
    const cached = createRequestCachedVirtualMcps(base);

    const first = await cached.list("org-1");
    await cached.patchMetadata({
      id: "proj-1",
      organizationId: "org-1",
      set: { projectFolderName: "x" },
      unset: [],
      by: "user-1",
    });
    const second = await cached.list("org-1");

    expect(second).not.toBe(first);
  });

  it("invalidates the list cache after clearAnalyticsSiteSlugReferences", async () => {
    const { base } = makeBase();
    const cached = createRequestCachedVirtualMcps(base);

    const first = await cached.list("org-1");
    await cached.clearAnalyticsSiteSlugReferences("org-1", "some-slug");
    const second = await cached.list("org-1");

    expect(second).not.toBe(first);
  });
});
