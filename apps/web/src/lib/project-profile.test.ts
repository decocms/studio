import { describe, expect, test } from "bun:test";
import {
  hasRepository,
  hasStorefront,
  normalizeStoreUrl,
  platformFromConnections,
  projectHasSubstance,
  readProjectProfile,
  storeHost,
  wasCreatedAsProject,
  withProjectProfile,
} from "./project-profile.ts";

describe("readProjectProfile", () => {
  test("a legacy production URL stands in for an unset store URL", () => {
    expect(
      readProjectProfile({ metadata: { productionUrl: "https://farm.com.br" } })
        .storeUrl,
    ).toBe("https://farm.com.br");
  });

  test("an explicit store URL wins over the legacy one", () => {
    expect(
      readProjectProfile({
        metadata: {
          productionUrl: "https://preview.farm.com.br",
          project: { storeUrl: "https://farm.com.br" },
        },
      }).storeUrl,
    ).toBe("https://farm.com.br");
  });

  test("a project that names nothing reads as nothing", () => {
    expect(readProjectProfile({ metadata: {} }).storeUrl).toBe(null);
  });
});

describe("withProjectProfile", () => {
  test("keeps every metadata key it was not asked to change", () => {
    const next = withProjectProfile(
      { githubRepo: { owner: "deco" }, instructions: "hi" },
      { storeUrl: "https://farm.com.br" },
    );
    expect(next.githubRepo).toEqual({ owner: "deco" });
    expect(next.instructions).toBe("hi");
    expect(next.project).toEqual({ storeUrl: "https://farm.com.br" });
  });

  test("merges into an existing profile rather than replacing it", () => {
    const next = withProjectProfile(
      { project: { storeUrl: "https://old.com.br" } },
      { storeUrl: "https://farm.com.br" },
    );
    expect(next.project).toEqual({ storeUrl: "https://farm.com.br" });
  });
});

describe("storeHost", () => {
  test("drops the scheme, the www and the path", () => {
    expect(storeHost("https://www.farm.com.br/feminino")).toBe("farm.com.br");
  });

  test("accepts a bare host", () => {
    expect(storeHost("farm.com.br")).toBe("farm.com.br");
  });

  test("is null for nothing and for garbage", () => {
    expect(storeHost(null)).toBe(null);
    expect(storeHost("")).toBe(null);
    expect(storeHost("http://")).toBe(null);
  });
});

describe("normalizeStoreUrl", () => {
  test("adds the scheme a person did not type", () => {
    expect(normalizeStoreUrl("farm.com.br")).toBe("https://farm.com.br");
  });

  test("keeps an explicit scheme and drops the path", () => {
    expect(normalizeStoreUrl("http://farm.com.br/feminino?x=1")).toBe(
      "http://farm.com.br",
    );
  });

  test("trims", () => {
    expect(normalizeStoreUrl("  farm.com.br  ")).toBe("https://farm.com.br");
  });

  test("rejects a host with no dot, so a typed word is not an address", () => {
    expect(normalizeStoreUrl("farm")).toBe(null);
    expect(normalizeStoreUrl("localhost")).toBe(null);
  });

  test("is null for nothing and for garbage", () => {
    expect(normalizeStoreUrl("")).toBe(null);
    expect(normalizeStoreUrl("   ")).toBe(null);
    expect(normalizeStoreUrl("http://")).toBe(null);
  });
});

describe("capabilities are derived, never declared", () => {
  test("a repository counts only when it can actually be cloned", () => {
    expect(
      hasRepository({ metadata: { githubRepo: { url: "https://x/y" } } }),
    ).toBe(true);
    expect(hasRepository({ metadata: { githubRepo: { url: "" } } })).toBe(
      false,
    );
    expect(hasRepository({ metadata: { githubRepo: {} } })).toBe(false);
    expect(hasRepository({ metadata: {} })).toBe(false);
  });

  test("a storefront is an address, including the legacy one", () => {
    expect(
      hasStorefront({ metadata: { project: { storeUrl: "farm.com.br" } } }),
    ).toBe(true);
    expect(hasStorefront({ metadata: { productionUrl: "farm.com.br" } })).toBe(
      true,
    );
    expect(hasStorefront({ metadata: {} })).toBe(false);
  });

  test("substance is a repo, an address or a connection", () => {
    expect(
      projectHasSubstance({ metadata: { githubRepo: { url: "https://x/y" } } }),
    ).toBe(true);
    expect(
      projectHasSubstance({
        metadata: { project: { storeUrl: "farm.com.br" } },
      }),
    ).toBe(true);
    expect(
      projectHasSubstance({ metadata: {}, connections: [{ id: "c" }] }),
    ).toBe(true);
  });

  /** A project made moments ago has nothing on it and still deserves its
   *  destinations. That is PROVENANCE — `metadata.project` existing — and not
   *  the label, so an empty profile counts exactly as much as a chosen kind. */
  test("having been created as a project counts, whatever it holds", () => {
    expect(wasCreatedAsProject({ metadata: { project: {} } })).toBe(true);
    expect(projectHasSubstance({ metadata: { project: {} } })).toBe(true);
    expect(
      projectHasSubstance({ metadata: { project: { storeUrl: null } } }),
    ).toBe(true);
  });

  /** The constraint this module exists to hold: a pre-projects agent with no
   *  repository, no address and no connections is not a place work happens. */
  test("a leftover tool bundle is not substance", () => {
    expect(wasCreatedAsProject({ metadata: {} })).toBe(false);
    expect(projectHasSubstance({ metadata: {}, connections: [] })).toBe(false);
    expect(projectHasSubstance({ metadata: null })).toBe(false);
  });
});

describe("platformFromConnections", () => {
  const conn = (id: string, app_name: string | null, slug?: string) => ({
    id,
    app_name,
    slug,
  });

  test("reads the platform off a connection the project holds", () => {
    expect(
      platformFromConnections({ connections: [{ connection_id: "c1" }] }, [
        conn("c1", "vtex"),
      ]),
    ).toBe("vtex");
  });

  /** Orgs name their instances; the registry id is `deco/vtex`. */
  test("matches inside a named instance and inside a slug", () => {
    expect(
      platformFromConnections({ connections: [{ connection_id: "c1" }] }, [
        conn("c1", "VTEX Farm produção"),
      ]),
    ).toBe("vtex");
    expect(
      platformFromConnections({ connections: [{ connection_id: "c1" }] }, [
        conn("c1", null, "deco-shopify-br"),
      ]),
    ).toBe("shopify");
  });

  test("ignores connections the project does not hold", () => {
    expect(
      platformFromConnections({ connections: [{ connection_id: "c2" }] }, [
        conn("c1", "vtex"),
      ]),
    ).toBe(null);
  });

  test("a project with no connections has no platform", () => {
    expect(
      platformFromConnections({ connections: [] }, [conn("c1", "vtex")]),
    ).toBe(null);
    expect(platformFromConnections({}, [conn("c1", "vtex")])).toBe(null);
  });

  test("a connection to something that is not a storefront reads as none", () => {
    expect(
      platformFromConnections({ connections: [{ connection_id: "c1" }] }, [
        conn("c1", "google-analytics"),
      ]),
    ).toBe(null);
  });
});
