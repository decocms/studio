import { describe, expect, it } from "bun:test";
import {
  frameUrl,
  parseHeatmap,
  rampCss,
  reachAt,
  readViewMessage,
  renderWidth,
  rootName,
  siteOrigin,
  viewData,
} from "./analytics-heatmap-model.ts";

const payload = {
  hmPages: [
    { page_key: "/", device: "mobile", views: "30" },
    { page_key: "/", device: "desktop", views: "20" },
    { page_key: "/:product/p", device: "mobile", views: "40" },
  ],
  hmSummary: [
    {
      views: "50",
      scale: 4,
      clicks: "12",
      rage: "1",
      dead: "2",
      error: "0",
      avg_depth: 32,
      avg_fold: 11,
      active_s: 41,
      small_sample: 1,
    },
  ],
  hmDevices: [
    { device: "desktop", views: "20", mean_vw: 1366 },
    { device: "watch", views: "1" },
  ],
  hmElements: [
    {
      root: "fs:hero#0",
      el: "123",
      clicks: "10",
      views: "8",
      rage: "1",
      dead: "0",
      error: "0",
      first: "4",
      cells: { "9": "6", "10": "4" },
    },
    {
      root: "",
      el: "456",
      clicks: "2",
      views: "2",
      rage: "0",
      dead: "2",
      error: "0",
      first: "0",
      cells: {},
    },
  ],
  hmGrid: [{ fixed: 1, xb: 3, yb: 4, clicks: "5" }],
  hmScroll: [
    { depth: 10, views: "20", reach_pct: 100 },
    { depth: 50, views: "20", reach_pct: 60 },
    { depth: 90, views: "10", reach_pct: 20 },
  ],
};

describe("parseHeatmap", () => {
  const m = parseHeatmap(payload);

  it("reads ClickHouse strings as numbers", () => {
    expect(m.views).toBe(50);
    expect(m.scale).toBe(4);
    expect(m.smallSample).toBe(true);
    expect(m.elements[0]).toMatchObject({
      key: "fs:hero#0|123",
      clicks: 10,
      cells: { "9": 6, "10": 4 },
    });
    expect(m.grid[0]).toEqual({ fixed: true, xb: 3, yb: 4, clicks: 5 });
  });

  it("sums pages over devices, busiest first, and drops unknown devices", () => {
    expect(m.pages).toEqual([
      { page: "/", views: 50 },
      { page: "/:product/p", views: 40 },
    ]);
    expect(m.devices).toEqual([{ device: "desktop", views: 20, meanVw: 1366 }]);
  });

  it("reads absent panels as empty and no views as unknown averages", () => {
    const empty = parseHeatmap({});
    expect(empty.views).toBe(0);
    expect(empty.scale).toBe(1);
    expect(empty.avgDepth).toBeNull();
    expect(empty.elements).toEqual([]);
  });
});

describe("reachAt", () => {
  const { scroll } = parseHeatmap(payload);
  it("is the reach of the next measured depth", () => {
    expect(reachAt(scroll, 0)).toBe(1);
    expect(reachAt(scroll, 30)).toBe(0.6);
    expect(reachAt(scroll, 90)).toBe(0.2);
    expect(reachAt(scroll, 95)).toBe(0);
  });
});

describe("viewData", () => {
  const m = parseHeatmap(payload);
  it("weights by the click type and keeps the grid for 'all' only", () => {
    const all = viewData(m, {
      mode: "clicks",
      type: "all",
      ramp: "thermal",
      opacity: 0.8,
      device: "mobile",
    });
    expect(all.elements.map((e) => e.clicks)).toEqual([10, 2]);
    expect(all.grid).toHaveLength(1);
    expect(all.radius).toBe(36);
    const dead = viewData(m, {
      mode: "clicks",
      type: "dead",
      ramp: "thermal",
      opacity: 0.8,
      device: "desktop",
    });
    expect(dead.elements).toEqual([
      { root: "", el: "456", clicks: 2, cells: {} },
    ]);
    expect(dead.grid).toEqual([]);
    expect(dead.radius).toBe(28);
  });
});

describe("renderWidth", () => {
  it("snaps to the device bucket", () => {
    expect(renderWidth("mobile", 412)).toBe(390);
    expect(renderWidth("tablet", null)).toBe(820);
    expect(renderWidth("tablet", 800)).toBe(800);
    expect(renderWidth("desktop", 1500)).toBe(1536);
    expect(renderWidth("desktop", null)).toBe(1440);
  });
});

describe("siteOrigin / frameUrl", () => {
  it("accepts a bare host or URL, https only", () => {
    expect(siteOrigin("www.example.com")).toBe("https://www.example.com");
    expect(siteOrigin("https://www.example.com/path")).toBe(
      "https://www.example.com",
    );
    expect(siteOrigin("http://www.example.com")).toBeNull();
    expect(siteOrigin("")).toBeNull();
  });

  it("frames a concrete path on the site's origin in view mode", () => {
    expect(frameUrl("https://www.example.com", "/a/p?x=1")).toBe(
      "https://www.example.com/a/p?x=1&dq_view=1",
    );
    expect(frameUrl("https://www.example.com", "/:product/p")).toBeNull();
    expect(frameUrl("https://www.example.com", "//evil.example/")).toBeNull();
    expect(frameUrl("https://www.example.com", "relative")).toBeNull();
  });
});

describe("readViewMessage", () => {
  const frame = {};
  const origin = "https://www.example.com";
  const msg = (data: unknown, o = origin, source: unknown = frame) => ({
    source,
    origin: o,
    data,
  });

  it("accepts the frame's window on the site origin with the protocol tag", () => {
    expect(
      readViewMessage(
        msg({ dq: "hm", v: 1, t: "select", key: "a|1" }),
        frame,
        origin,
      ),
    ).toEqual({ t: "select", key: "a|1" });
    expect(
      readViewMessage(
        msg({ dq: "hm", v: 1, t: "ready", anchors: 3 }),
        frame,
        origin,
      ),
    ).toMatchObject({ t: "ready", anchors: 3 });
  });

  it("refuses another window, another origin, another protocol or a malformed body", () => {
    const ok = { dq: "hm", v: 1, t: "select", key: "a|1" };
    expect(readViewMessage(msg(ok, origin, {}), frame, origin)).toBeNull();
    expect(
      readViewMessage(msg(ok, "https://evil.example"), frame, origin),
    ).toBeNull();
    expect(readViewMessage(msg({ ...ok, v: 2 }), frame, origin)).toBeNull();
    expect(readViewMessage(msg({ ...ok, dq: "x" }), frame, origin)).toBeNull();
    expect(
      readViewMessage(msg({ dq: "hm", v: 1, t: "select" }), frame, origin),
    ).toBeNull();
    expect(
      readViewMessage(
        msg({ dq: "hm", v: 1, t: "placed", items: "x" }),
        frame,
        origin,
      ),
    ).toBeNull();
    expect(readViewMessage(msg(ok), null, origin)).toBeNull();
  });
});

describe("rootName / rampCss", () => {
  it("names roots for the list", () => {
    expect(rootName("fs:hero-slideshow#0")).toBe("Hero slideshow");
    expect(rootName("site/sections/Product/Shelf.tsx#1")).toBe("Shelf 2");
    expect(rootName("#footer")).toBe("#footer");
    expect(rootName("")).toBeNull();
  });

  it("is transparent when cold and red when hot", () => {
    expect(rampCss("thermal", 0)).toBe("rgba(0,40,255,0)");
    expect(rampCss("thermal", 1)).toBe("rgba(225,18,30,0.9)");
    expect(rampCss("inferno", 2, 1)).toBe("rgba(252,255,164,1)");
  });
});
