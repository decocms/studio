import { describe, expect, it } from "bun:test";
import {
  buildCompanionCards,
  buildRegistryWhere,
  mergeBindingValue,
  parseBindingRequirements,
  resolveCandidate,
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
      checks: 49,
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
      checks: 49,
      headline: "vtex value",
      bullets: ["b1"],
      satisfied: false,
      candidateConnectionId: null,
    });
  });
  it("uncurated survivor renders plain (registry short_description, no checks/bullets)", () => {
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
      checks: null,
      bullets: [],
    });
  });
  it("marks satisfied from configuration_state and skips candidate lookup", () => {
    const cards = buildCompanionCards({
      requirements: [{ fieldKey: "VTEX_STORE", bindingType: "vtex" }],
      itemsById: { "deco/vtex": item("deco/vtex", "VTEX") },
      itemsByName: {},
      connections: [{ id: "c_vtex", app_name: "vtex", status: "active" }],
      configurationState: { VTEX_STORE: { __type: "vtex", value: "linked" } },
      curated,
    });
    expect(cards[0]!.satisfied).toBe(true);
    expect(cards[0]!.candidateConnectionId).toBeNull();
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
});
