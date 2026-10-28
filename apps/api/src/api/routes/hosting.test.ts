import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYTICS_PAYLOAD_KEYS,
  ANALYTICS_VIEWS,
  toTenantAnalyticsPayload,
} from "./hosting";

describe("toTenantAnalyticsPayload", () => {
  const upstream = {
    view: "overview",
    range: "7d",
    kpis: [{ visitors: 3 }],
    kpisPrev: [{ visitors: 2, covered: 0.789 }],
    hmValue: [{ root: "a", el: "b" }],
    heatmapValue: { unit: "visitor", currency: "BRL" },
    sites: [
      { k: "site-a", label: "a.example", n: 10 },
      { k: "site-b", label: "b.example", n: 20 },
    ],
    worker: { limits: {} },
    install: { bundles: {} },
    panelErrors: { kpis: "timeout" },
    meterCheck: [{ ratio: 1 }],
    somethingNew: [{ k: "x" }],
    usageScope: {
      site: "site-a",
      reader: "stats_reader",
      tenantScoped: true,
      enforced: ["raw_events"],
    },
  };

  it("forwards only the keys the tab reads", () => {
    const out = toTenantAnalyticsPayload(upstream, "site-a");
    expect(Object.keys(out).sort()).toEqual(
      [
        "heatmapValue",
        "hmValue",
        "kpis",
        "kpisPrev",
        "range",
        "sites",
        "usageScope",
        "view",
      ].sort(),
    );
    expect(out.kpisPrev).toEqual([{ visitors: 2, covered: 0.789 }]);
  });

  it("narrows sites to the requested site and reduces the scope report", () => {
    const out = toTenantAnalyticsPayload(upstream, "site-a");
    expect(out.sites).toEqual([{ k: "site-a", label: "a.example", n: 10 }]);
    expect(JSON.stringify(out)).not.toContain("site-b");
    expect(out.usageScope).toEqual({ site: "site-a", tenantScoped: true });
  });

  // The allow-list must track the web code: a key the tab reads but the proxy
  // drops renders as an empty panel with no error anywhere.
  it("allows every payload key the web tab reads", () => {
    const dir = join(
      import.meta.dir,
      "../../../../web/src/layouts/main-panel-tabs",
    );
    const tab = readFileSync(join(dir, "analytics-tab.tsx"), "utf8");
    const model = readFileSync(join(dir, "analytics-heatmap-model.ts"), "utf8");
    const meta = tab.match(/const META_KEYS = new Set\(\[([^\]]*)\]/)?.[1];
    const panels = tab.match(/const PANEL_NAMES = \[([^\]]*)\]/)?.[1];
    const read = [
      ...[...(meta ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]),
      ...[...(panels ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]),
      ...[...tab.matchAll(/rowsOf\("(\w+)"\)/g)].map((m) => m[1]),
      ...[...model.matchAll(/\bdata\.(\w+)/g)].map((m) => m[1]),
    ];
    expect(read.length).toBeGreaterThan(40);
    const handledApart = new Set(["sites", "usageScope"]);
    const missing = read.filter(
      (k) => k && !ANALYTICS_PAYLOAD_KEYS.has(k) && !handledApart.has(k),
    );
    expect(missing).toEqual([]);
  });

  // The live map reads its payload through its own typed casts rather than the
  // tab's `rowsOf`, so the scan above cannot see it. Same failure if it drifts:
  // an allow-list is silent, so a dropped key is a map with no dots on it and
  // no error in any log.
  it("allows every payload key the live map reads", () => {
    const dir = join(
      import.meta.dir,
      "../../../../web/src/layouts/main-panel-tabs",
    );
    const globe = readFileSync(join(dir, "analytics-globe-tab.tsx"), "utf8");
    // Anchored on `payload as` so it reads PANEL keys only — the same shape
    // also narrows a row (`first as { visitors?: unknown }`) and the BFF
    // envelope, and neither of those is an allow-list entry.
    // `flatMap` rather than `map`: under `noUncheckedIndexedAccess` a capture
    // group is `string | undefined`, and dropping the empty case here keeps the
    // assertions below reading as plain string work.
    const read = [
      ...globe.matchAll(/payload as \{\s*(\w+)\?:\s*unknown\s*\}/g),
    ].flatMap((m) => m[1] ?? []);
    // Asserted by name first: a regex that silently stops matching would make
    // the filter below trivially empty, and the test would pass forever.
    expect(read).toContain("liveGeo");
    expect(read).toContain("liveVisitors");
    expect(read.filter((k) => !ANALYTICS_PAYLOAD_KEYS.has(k))).toEqual([]);
  });
});

// A view the tab offers but the proxy rejects is a 400 the moment someone
// clicks the tab — the one failure that is invisible until a user finds it.
describe("ANALYTICS_VIEWS", () => {
  it("accepts every view the tab offers", () => {
    const tab = readFileSync(
      join(
        import.meta.dir,
        "../../../../web/src/layouts/main-panel-tabs/analytics-tab.tsx",
      ),
      "utf8",
    );
    const block = tab.match(/const DATA_VIEWS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1];
    const views = [...(block ?? "").matchAll(/view:\s*"(\w+)"/g)].flatMap(
      (m) => m[1] ?? [],
    );
    expect(views).toContain("globe");
    expect(views.filter((v) => !ANALYTICS_VIEWS.has(v))).toEqual([]);
  });
});
