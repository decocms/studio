import { describe, expect, test } from "bun:test";
import {
  ensureManagedSiteFileConfig,
  isManagedConfigFor,
} from "./managed-site-config";

describe("isManagedConfigFor", () => {
  test("already the managed config for the slug — nothing to do", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "managed", siteSlug: "als-storefront" },
        "als-storefront",
      ),
    ).toBe(true);
  });

  test("legacy pre-tenancy config on the old bucket must be upgraded", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "sts-session", siteSlug: null },
        "als-storefront",
      ),
    ).toBe(false);
    expect(
      isManagedConfigFor(
        { credentialType: "static", siteSlug: null },
        "als-storefront",
      ),
    ).toBe(false);
  });

  test("managed but pointing at another slug must be re-pointed", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "managed", siteSlug: "other-site" },
        "als-storefront",
      ),
    ).toBe(false);
  });

  test("siteSlug casing does not force a pointless rewrite", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "managed", siteSlug: "ALS-Storefront" },
        "als-storefront",
      ),
    ).toBe(true);
  });
});

describe("ensureManagedSiteFileConfig", () => {
  type Row = {
    id: string;
    name: string;
    credentialType: string;
    siteSlug: string | null;
    bucket?: string;
  };
  function store(rows: Row[]) {
    const calls: string[] = [];
    const fileConfigs = {
      list: async () => rows,
      create: async (p: { name: string; siteSlug?: string | null }) => {
        calls.push(`create ${p.name} ${p.siteSlug}`);
        return {} as never;
      },
      update: async (p: { id: string; siteSlug?: string | null }) => {
        calls.push(`update ${p.id} ${p.siteSlug}`);
        return {} as never;
      },
    } as unknown as Parameters<
      typeof ensureManagedSiteFileConfig
    >[0]["fileConfigs"];
    return { fileConfigs, calls };
  }
  const base = { organizationId: "org", slug: "acme", by: "user" };

  test("creates the site's managed config (Studio's S3, by site slug)", async () => {
    const { fileConfigs, calls } = store([]);
    expect(await ensureManagedSiteFileConfig({ ...base, fileConfigs })).toBe(
      "created",
    );
    expect(calls).toEqual(["create deco-assets-acme acme"]);
  });

  test("leaves an existing managed config alone", async () => {
    const { fileConfigs, calls } = store([
      {
        id: "c1",
        name: "deco-assets-acme",
        credentialType: "managed",
        siteSlug: "acme",
      },
    ]);
    expect(await ensureManagedSiteFileConfig({ ...base, fileConfigs })).toBe(
      "exists",
    );
    expect(calls).toEqual([]);
  });

  test("upgrades a legacy same-named config in place", async () => {
    const { fileConfigs, calls } = store([
      {
        id: "c1",
        name: "Deco-Assets-Acme",
        credentialType: "vended",
        siteSlug: null,
      },
    ]);
    expect(await ensureManagedSiteFileConfig({ ...base, fileConfigs })).toBe(
      "upgraded",
    );
    expect(calls).toEqual(["update c1 acme"]);
  });
});
