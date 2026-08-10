import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { interpolate, type InterpolationVars } from "@/i18n/interpolate.ts";
import {
  buildCompanionCards,
  buildRegistryWhere,
  getConfigurationSummaryEntries,
  isCompanionConfigured,
  matchGscSite,
  mergeBindingValue,
  parseBindingRequirements,
  REQUIRED_BINDING_TYPES,
  resolveCandidate,
  shouldAutoOpenCompanionConfig,
  toPropertyOptions,
  unwrapToolResult,
} from "./companions-core.ts";

const bindingSchema = (type: string) => ({
  type: "object",
  properties: {
    __type: { const: type, type: "string" },
    value: { type: "string" },
  },
});

describe("parseBindingRequirements", () => {
  it("extracts fieldKey + bindingType, preserving order, ignoring non-binding props", () => {
    const schema = {
      type: "object",
      properties: {
        VTEX_STORE: bindingSchema("vtex"),
        siteUrl: { type: "string" },
        GA: bindingSchema("google-analytics"),
      },
    };
    expect(parseBindingRequirements(schema)).toEqual([
      { fieldKey: "VTEX_STORE", bindingType: "vtex" },
      { fieldKey: "GA", bindingType: "google-analytics" },
    ]);
  });
  it("returns [] when no properties", () => {
    expect(parseBindingRequirements({ type: "object" })).toEqual([]);
  });
});

describe("buildRegistryWhere", () => {
  it("returns a single comparison when only ids", () => {
    expect(buildRegistryWhere(["deco/vtex"], [])).toEqual({
      field: ["id"],
      operator: "in",
      value: ["deco/vtex"],
    });
  });
  it("ORs id-set and name-set when both present", () => {
    expect(buildRegistryWhere(["deco/vtex"], ["shopify"])).toEqual({
      operator: "or",
      conditions: [
        { field: ["id"], operator: "in", value: ["deco/vtex"] },
        { field: ["name"], operator: "in", value: ["shopify"] },
      ],
    });
  });
  it("returns undefined when both empty", () => {
    expect(buildRegistryWhere([], [])).toBeUndefined();
  });
});

describe("mergeBindingValue", () => {
  it("adds the binding value without dropping existing keys", () => {
    const prev = { GA: { __type: "google-analytics", value: "conn_ga" } };
    expect(mergeBindingValue(prev, "VTEX_STORE", "vtex", "conn_vtex")).toEqual({
      GA: { __type: "google-analytics", value: "conn_ga" },
      VTEX_STORE: { __type: "vtex", value: "conn_vtex" },
    });
  });
  it("treats null state as empty", () => {
    expect(mergeBindingValue(null, "VTEX_STORE", "vtex", "c1")).toEqual({
      VTEX_STORE: { __type: "vtex", value: "c1" },
    });
  });
});

const t = (key: keyof typeof en, vars?: InterpolationVars) =>
  interpolate(en[key], vars);

describe("getConfigurationSummaryEntries", () => {
  it("returns displayable non-empty config entries and hides internal fields", () => {
    expect(
      getConfigurationSummaryEntries(
        {
          __type: "vtex",
          accountName: "electrolux",
          propertyId: null,
          currency: "",
        },
        t,
      ),
    ).toEqual([
      { key: "accountName", label: "Account name", value: "electrolux" },
    ]);
  });

  it("humanizes keys with no curated label (camelCase and snake/kebab-case)", () => {
    expect(
      getConfigurationSummaryEntries(
        {
          storeDomain: "electrolux",
          api_key: "abc",
          "sales-channel": "1",
        },
        t,
      ),
    ).toEqual([
      { key: "storeDomain", label: "Store Domain", value: "electrolux" },
      { key: "api_key", label: "Api Key", value: "abc" },
      { key: "sales-channel", label: "Sales Channel", value: "1" },
    ]);
  });

  it("stringifies non-scalar values as JSON", () => {
    expect(
      getConfigurationSummaryEntries({ scopes: ["read", "write"] }, t),
    ).toEqual([{ key: "scopes", label: "Scopes", value: '["read","write"]' }]);
  });
});

describe("resolveCandidate", () => {
  const conns = [
    {
      id: "c_old",
      app_name: "vtex",
      status: "inactive",
      updated_at: "2026-01-01",
    },
    {
      id: "c_active",
      app_name: "vtex",
      status: "active",
      updated_at: "2026-02-01",
    },
    {
      id: "c_byid",
      app_id: "deco/vtex",
      status: "inactive",
      updated_at: "2026-03-01",
    },
  ];
  it("prefers active, then most recent", () => {
    expect(resolveCandidate(conns, "vtex", "deco/vtex")).toBe("c_active");
  });
  it("matches by app_id too", () => {
    expect(resolveCandidate([conns[2]!], "vtex", "deco/vtex")).toBe("c_byid");
  });
  it("returns null when nothing matches", () => {
    expect(resolveCandidate(conns, "shopify", "deco/shopify")).toBeNull();
  });
  it("skips repo-scoped github children, preferring the org-level connection", () => {
    const github = [
      {
        id: "c_repo_child",
        app_id: "deco/mcp-github",
        status: "active",
        updated_at: "2026-03-01",
        metadata: {
          repoScope: { installationId: 1, owner: "deco", repo: "site" },
        },
      },
      {
        id: "c_org",
        app_id: "deco/mcp-github",
        status: "active",
        updated_at: "2026-02-01",
      },
    ];
    expect(resolveCandidate(github, "github", "deco/mcp-github")).toBe("c_org");
  });
  it("returns null when the only github match is repo-scoped", () => {
    const github = [
      {
        id: "c_repo_child",
        app_id: "deco/mcp-github",
        status: "active",
        updated_at: "2026-03-01",
        metadata: {
          repoScope: { installationId: 1, owner: "deco", repo: "site" },
        },
      },
    ];
    expect(resolveCandidate(github, "github", "deco/mcp-github")).toBeNull();
  });
});

describe("unwrapToolResult", () => {
  it("throws with the content text when isError:true", () => {
    expect(() =>
      unwrapToolResult({
        isError: true,
        content: [{ text: "validateConfiguration failed" }],
      }),
    ).toThrow("validateConfiguration failed");
  });
  it("throws a default message when isError:true with no text", () => {
    expect(() => unwrapToolResult({ isError: true, content: [] })).toThrow(
      "Tool call failed",
    );
  });
  it("returns structuredContent when present and not error", () => {
    expect(
      unwrapToolResult<{ item: { id: string } }>({
        structuredContent: { item: { id: "c1" } },
      }),
    ).toEqual({ item: { id: "c1" } });
  });
  it("returns the raw result when no structuredContent", () => {
    const raw = { item: { id: "c1" } };
    expect(unwrapToolResult<typeof raw>(raw)).toEqual(raw);
  });
});

describe("isCompanionConfigured", () => {
  it("treats an SA-verified binding as always configured", () => {
    expect(
      isCompanionConfigured({
        bindingType: "google-analytics",
        boundVia: "sa",
        companionConfig: null,
        cdConfig: null,
      }),
    ).toBe(true);
  });
  it("requires a VTEX account name (linked ≠ usable)", () => {
    expect(
      isCompanionConfigured({
        bindingType: "vtex",
        boundVia: "oauth",
        companionConfig: null,
        cdConfig: null,
      }),
    ).toBe(false);
    expect(
      isCompanionConfigured({
        bindingType: "vtex",
        boundVia: "oauth",
        companionConfig: { accountName: "electrolux" },
        cdConfig: null,
      }),
    ).toBe(true);
  });
  it("requires a picked property/site for OAuth GA4/GSC", () => {
    expect(
      isCompanionConfigured({
        bindingType: "google-analytics",
        boundVia: "oauth",
        companionConfig: {},
        cdConfig: null,
      }),
    ).toBe(false);
    expect(
      isCompanionConfigured({
        bindingType: "google-search-console",
        boundVia: "oauth",
        companionConfig: { siteUrl: "sc-domain:loja.com" },
        cdConfig: null,
      }),
    ).toBe(true);
  });
  it("reads GitHub's repo from the CD connection state", () => {
    expect(
      isCompanionConfigured({
        bindingType: "github",
        boundVia: "oauth",
        companionConfig: null,
        cdConfig: { github_repo: "deco/site" },
      }),
    ).toBe(true);
    expect(
      isCompanionConfigured({
        bindingType: "github",
        boundVia: "oauth",
        companionConfig: null,
        cdConfig: {},
      }),
    ).toBe(false);
  });
});

describe("REQUIRED_BINDING_TYPES", () => {
  it("requires no source — analytics is optional like the rest", () => {
    expect(REQUIRED_BINDING_TYPES.has("google-analytics")).toBe(false);
    expect(REQUIRED_BINDING_TYPES.size).toBe(0);
  });
});

describe("buildCompanionCards", () => {
  const item = (id: string, name: string) => ({
    id,
    title: name,
    server: { name, title: name, icons: [{ src: `https://x/${name}.png` }] },
    _meta: {
      "mcp.mesh": { friendly_name: name, short_description: `${name} desc` },
    },
  });
  const curated = {
    vtex: {
      registryAppId: "deco/vtex",
      area: "Catálogo",
      headline: "vtex value",
      bullets: ["b1"],
    },
  };
  it("intersects schema ∧ registry, enriches curated, skips missing-in-registry", () => {
    const cards = buildCompanionCards({
      requirements: [
        { fieldKey: "VTEX_STORE", bindingType: "vtex" },
        { fieldKey: "GHOST", bindingType: "not-in-registry" },
      ],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      connections: [],
      configurationState: null,
      curated,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      fieldKey: "VTEX_STORE",
      bindingType: "vtex",
      title: "VTEX",
      icon: "https://x/VTEX.png",
      area: "Catálogo",
      headline: "vtex value",
      bullets: ["b1"],
      satisfied: false,
      candidateConnectionId: null,
    });
  });
  it("uncurated survivor renders plain (registry short_description, no area/bullets)", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "SHOP", bindingType: "shopify" }],
      itemsById: {},
      itemsByName: { shopify: item("deco/shopify", "shopify") },
      connections: [],
      configurationState: null,
      curated,
    });
    expect(cards[0]).toMatchObject({
      title: "shopify",
      headline: "shopify desc",
      area: null,
      bullets: [],
    });
  });
  it("marks satisfied from configuration_state and skips candidate lookup", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "VTEX_STORE", bindingType: "vtex" }],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      connections: [
        {
          id: "c_vtex",
          app_name: "vtex",
          status: "active",
          configuration_state: { accountName: "electrolux" },
        },
      ],
      configurationState: { VTEX_STORE: { __type: "vtex", value: "c_vtex" } },
      curated,
    });
    expect(cards[0]!.satisfied).toBe(true);
    expect(cards[0]!.candidateConnectionId).toBeNull();
    expect(cards[0]!.linkedConnectionId).toBe("c_vtex");
    expect(cards[0]!.configurationState).toEqual({
      accountName: "electrolux",
    });
    // Linked AND has its account → usable.
    expect(cards[0]!.configured).toBe(true);
  });
  it("marks a linked VTEX with no account as satisfied-but-not-configured", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "VTEX_STORE", bindingType: "vtex" }],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      // Linked connection exists but carries no accountName yet.
      connections: [{ id: "c_vtex", app_name: "vtex", status: "active" }],
      configurationState: { VTEX_STORE: { __type: "vtex", value: "c_vtex" } },
      curated,
    });
    expect(cards[0]!.satisfied).toBe(true);
    expect(cards[0]!.configured).toBe(false);
    // VTEX is an enhancement, not the required source.
    expect(cards[0]!.required).toBe(false);
  });
  it("treats configuration_state links to missing org connections as connectable", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "VTEX_STORE", bindingType: "vtex" }],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      connections: [],
      configurationState: {
        VTEX_STORE: { __type: "vtex", value: "deleted_connection" },
      },
      curated,
    });
    expect(cards[0]!.satisfied).toBe(false);
    expect(cards[0]!.candidateConnectionId).toBeNull();
  });
  it("treats configuration_state links to unready org connections as reusable connect cards", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "VTEX_STORE", bindingType: "vtex" }],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      connections: [{ id: "c_vtex", app_name: "vtex", status: "active" }],
      connectionReadiness: { c_vtex: false },
      configurationState: { VTEX_STORE: { __type: "vtex", value: "c_vtex" } },
      curated,
    });
    expect(cards[0]!.satisfied).toBe(false);
    expect(cards[0]!.candidateConnectionId).toBe("c_vtex");
  });
  it("surfaces an unlinked candidate for reuse", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "VTEX_STORE", bindingType: "vtex" }],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      connections: [{ id: "c_vtex", app_name: "vtex", status: "active" }],
      configurationState: null,
      curated,
    });
    expect(cards[0]!.satisfied).toBe(false);
    expect(cards[0]!.candidateConnectionId).toBe("c_vtex");
  });
  it("falls back to a GitHub avatar when the registry item has no icons", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "SHOP", bindingType: "shopify" }],
      itemsById: {},
      itemsByName: {
        shopify: {
          id: "deco/shopify",
          server: { repository: "https://github.com/deco-cx/shopify" },
        },
      },
      connections: [],
      configurationState: null,
      curated,
    });
    expect(cards[0]!.icon).toContain("images.weserv.nl");
  });
  it("has a null icon when the registry item has neither icons nor a repository", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "SHOP", bindingType: "shopify" }],
      itemsById: {},
      itemsByName: { shopify: { id: "deco/shopify" } },
      connections: [],
      configurationState: null,
      curated,
    });
    expect(cards[0]!.icon).toBeNull();
  });
  it("marks a card connected via the shared-SA binding (boundVia='sa')", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "GA", bindingType: "google-analytics" }],
      itemsById: {},
      itemsByName: {
        "google-analytics": item("deco/google-analytics", "google-analytics"),
      },
      connections: [],
      configurationState: null,
      curated,
      saBindings: { "google-analytics": { resource: "123456789" } },
    });
    expect(cards[0]!.satisfied).toBe(true);
    expect(cards[0]!.boundVia).toBe("sa");
    expect(cards[0]!.boundResource).toBe("123456789");
    expect(cards[0]!.linkedConnectionId).toBeNull();
  });
  it("OAuth linkage wins over an SA binding (run-time precedence)", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "GA", bindingType: "google-analytics" }],
      itemsById: {},
      itemsByName: {
        "google-analytics": item("deco/google-analytics", "google-analytics"),
      },
      connections: [
        { id: "c_ga", app_name: "google-analytics", status: "active" },
      ],
      configurationState: {
        GA: { __type: "google-analytics", value: "c_ga" },
      },
      curated,
      saBindings: { "google-analytics": { resource: "123" } },
    });
    expect(cards[0]!.satisfied).toBe(true);
    expect(cards[0]!.boundVia).toBe("oauth");
    expect(cards[0]!.boundResource).toBeNull();
    expect(cards[0]!.linkedConnectionId).toBe("c_ga");
  });
});

describe("matchGscSite", () => {
  it("matches normalized domain (context=raw host, site=https://www.host/)", () => {
    const site = matchGscSite("example.com", [
      { siteUrl: "https://www.example.com/" },
      { siteUrl: "https://other.com/" },
    ]);
    expect(site).toBe("https://www.example.com/");
  });
  it("matches sc-domain: format", () => {
    const site = matchGscSite("example.com", [
      { siteUrl: "sc-domain:example.com" },
      { siteUrl: "https://other.com/" },
    ]);
    expect(site).toBe("sc-domain:example.com");
  });
  it("returns null when no match found", () => {
    const site = matchGscSite("nomatch.com", [
      { siteUrl: "https://example.com/" },
      { siteUrl: "sc-domain:other.com" },
    ]);
    expect(site).toBeNull();
  });
  it("returns null when contextSiteUrl is undefined", () => {
    const site = matchGscSite(undefined, [{ siteUrl: "https://example.com/" }]);
    expect(site).toBeNull();
  });
  it("returns null when sites is empty", () => {
    expect(matchGscSite("example.com", [])).toBeNull();
  });
  it("matches a www sc-domain site against a non-www https site (www stripping must apply to both formats)", () => {
    const site = matchGscSite("sc-domain:www.example.com", [
      { siteUrl: "https://example.com/" },
      { siteUrl: "https://other.com/" },
    ]);
    expect(site).toBe("https://example.com/");
  });
  it("falls back to the raw string instead of throwing on an unparseable siteUrl", () => {
    const site = matchGscSite("not a valid url", [
      { siteUrl: "not a valid url" },
      { siteUrl: "https://example.com/" },
    ]);
    expect(site).toBe("not a valid url");
  });
});

describe("shouldAutoOpenCompanionConfig", () => {
  it("opens only for the just-connected satisfied card", () => {
    expect(
      shouldAutoOpenCompanionConfig({
        autoOpenFieldKey: "VTEX_STORE",
        card: {
          fieldKey: "VTEX_STORE",
          satisfied: true,
          linkedConnectionId: "c_vtex",
        },
      }),
    ).toBe(true);
  });

  it("does not open for already-connected cards without a transition signal", () => {
    expect(
      shouldAutoOpenCompanionConfig({
        autoOpenFieldKey: null,
        card: {
          fieldKey: "VTEX_STORE",
          satisfied: true,
          linkedConnectionId: "c_vtex",
        },
      }),
    ).toBe(false);
  });

  it("does not open for a stale signal after the card is no longer connectable", () => {
    expect(
      shouldAutoOpenCompanionConfig({
        autoOpenFieldKey: "VTEX_STORE",
        card: {
          fieldKey: "VTEX_STORE",
          satisfied: false,
          linkedConnectionId: null,
        },
      }),
    ).toBe(false);
  });
});

describe("toPropertyOptions", () => {
  it("flattens GA accountSummaries to grouped options by account", () => {
    const options = toPropertyOptions({
      response: {
        accountSummaries: [
          {
            account: "accounts/123",
            displayName: "Account One",
            propertySummaries: [
              { property: "properties/456", displayName: "Property A" },
              { property: "properties/789", displayName: "Property B" },
            ],
          },
          {
            account: "accounts/999",
            displayName: "Account Two",
            propertySummaries: [
              { property: "properties/111", displayName: "Property C" },
            ],
          },
        ],
      },
    });
    expect(options).toHaveLength(2);
    expect(options[0]!.account).toBe("accounts/123");
    expect(options[0]!.options).toHaveLength(2);
    expect(options[0]!.options[0]).toEqual({
      value: "properties/456",
      label: "Property A (Account One)",
    });
    expect(options[1]!.account).toBe("accounts/999");
    expect(options[1]!.options).toHaveLength(1);
  });
  it("disambiguates same-named properties across different accounts", () => {
    const options = toPropertyOptions({
      response: {
        accountSummaries: [
          {
            account: "accounts/123",
            displayName: "Client A",
            propertySummaries: [
              { property: "properties/456", displayName: "example.com" },
            ],
          },
          {
            account: "accounts/999",
            displayName: "Client B",
            propertySummaries: [
              { property: "properties/789", displayName: "example.com" },
            ],
          },
        ],
      },
    });
    const labels = options.flatMap((g) => g.options).map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("handles missing or empty propertySummaries", () => {
    const options = toPropertyOptions({
      response: {
        accountSummaries: [
          {
            account: "accounts/123",
            displayName: "Account One",
            propertySummaries: [],
          },
        ],
      },
    });
    expect(options).toHaveLength(1);
    expect(options[0]!.options).toHaveLength(0);
  });
  it("returns empty array when response has no accountSummaries", () => {
    const options = toPropertyOptions({ response: {} });
    expect(options).toEqual([]);
  });
});
