import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYTICS_PAYLOAD_KEYS,
  ANALYTICS_VIEWS,
  segmentParams,
  toTenantAnalyticsPayload,
} from "./hosting";

const WEB_SRC = join(import.meta.dir, "../../../../web/src");

/** Every Monitor analytics section's source, where the payload is read. */
function monitorAnalyticsSource(): string {
  const dir = join(WEB_SRC, "components/monitor/analytics");
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

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

  // The allow-list must track the web code: a key Monitor reads but the proxy
  // drops renders as an empty panel with no error anywhere.
  it("allows every payload key Monitor's analytics sections read", () => {
    const sections = monitorAnalyticsSource();
    const model = readFileSync(
      join(WEB_SRC, "layouts/main-panel-tabs/analytics-heatmap-model.ts"),
      "utf8",
    );
    const read = [
      ...[...sections.matchAll(/rowsOf\(\w+, "(\w+)"\)/g)].map((m) => m[1]),
      ...[...sections.matchAll(/\bdata\??\.(\w+)/g)].map((m) => m[1]),
      ...[...model.matchAll(/\bdata\.(\w+)/g)].map((m) => m[1]),
    ];
    expect(read.length).toBeGreaterThan(30);
    // The globe's rows ride on the Realtime payload. An allow-list is silent: a
    // dropped key is a map with no dots on it and no error in any log.
    expect(read).toContain("liveGeo");
    // `data` is the BFF envelope's own field; the rest are handled apart.
    const handledApart = new Set(["data", "sites", "usageScope"]);
    const missing = read.filter(
      (k) => k && !ANALYTICS_PAYLOAD_KEYS.has(k) && !handledApart.has(k),
    );
    expect(missing).toEqual([]);
  });
});

// A view Monitor asks for but the proxy rejects is a 400 the moment someone
// opens the section — the one failure that is invisible until a user finds it.
describe("ANALYTICS_VIEWS", () => {
  it("accepts every view Monitor asks for", () => {
    const sections = monitorAnalyticsSource();
    const heatmap = readFileSync(
      join(WEB_SRC, "layouts/main-panel-tabs/analytics-heatmap-tab.tsx"),
      "utf8",
    );
    const views = [
      ...[...sections.matchAll(/useSectionView\(\w+, "(\w+)"\)/g)].flatMap(
        (m) => m[1] ?? [],
      ),
      ...[...sections.matchAll(/view: "(\w+)"/g)].flatMap((m) => m[1] ?? []),
      ...[...heatmap.matchAll(/analytics\/data\?view=(\w+)/g)].flatMap(
        (m) => m[1] ?? [],
      ),
    ];
    expect(views).toContain("overview");
    expect(views).toContain("live");
    expect(views).toContain("heatmap");
    expect(views.filter((v) => !ANALYTICS_VIEWS.has(v))).toEqual([]);
  });
});

describe("segmentParams", () => {
  it("forwards valid filters, currency and prop", () => {
    expect(
      segmentParams(["path:is:/a:b", "country:not:BR"], "BRL", "sku"),
    ).toEqual([
      ["f", "path:is:/a:b"],
      ["f", "country:not:BR"],
      ["currency", "BRL"],
      ["prop", "sku"],
    ]);
    expect(segmentParams([], undefined, undefined)).toEqual([]);
  });
  it("rejects malformed values", () => {
    expect(segmentParams(["path:eq:/"], undefined, undefined)).toBeNull();
    expect(segmentParams(["path:is:"], undefined, undefined)).toBeNull();
    expect(segmentParams(["path:is:a\nb"], undefined, undefined)).toBeNull();
    expect(
      segmentParams(Array(21).fill("os:is:x"), undefined, undefined),
    ).toBeNull();
    expect(segmentParams([], "R$", undefined)).toBeNull();
    expect(segmentParams([], undefined, "x".repeat(129))).toBeNull();
  });
});
