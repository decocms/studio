/**
 * Pure model of the Deco Analytics "Heatmap" tab: the `view=heatmap` panels
 * normalised for the UI, the colour ramps the site's overlay also paints
 * with, and the view-mode protocol the framed site speaks.
 *
 * The heat itself is drawn INSIDE the live site by its analytics runtime in
 * view mode (decocms/analytics `runtime/view/view.ts`): it hashes the live DOM
 * with the same anchor algorithm the clicks were recorded with, so matching
 * never leaves the site's origin. Studio owns the controls and the lists.
 */

export type HeatDevice = "desktop" | "tablet" | "mobile";
export type HeatMode = "clicks" | "scroll" | "attention" | "sections";
export type ClickType = "all" | "rage" | "dead" | "error" | "first";
export type HeatRange = "24h" | "7d" | "30d";
export type HeatRamp = "thermal" | "inferno";

export const HEAT_DEVICES: HeatDevice[] = ["desktop", "tablet", "mobile"];
export const HEAT_RANGES: HeatRange[] = ["24h", "7d", "30d"];
export const HEAT_MODES: HeatMode[] = [
  "clicks",
  "scroll",
  "attention",
  "sections",
];
export const CLICK_TYPES: ClickType[] = [
  "all",
  "rage",
  "dead",
  "error",
  "first",
];

type Row = Record<string, unknown>;

/** ClickHouse JSON sends UInt64 as strings. */
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string =>
  typeof v === "string" ? v : String(v ?? "");
const rows = (v: unknown): Row[] =>
  Array.isArray(v)
    ? v.filter((r): r is Row => !!r && typeof r === "object")
    : [];

export interface HeatElement {
  /** `${root}|${el}` with `el` in decimal — the key the view-mode overlay uses. */
  key: string;
  root: string;
  /** Anchor hash, decimal string (UInt64). */
  el: string;
  clicks: number;
  /** Views with at least one click on it. */
  views: number;
  rage: number;
  dead: number;
  error: number;
  first: number;
  /** 8×8 position cells inside the element: `{ "<row*8+col>": clicks }`. */
  cells: Record<string, number>;
}

interface HeatSection {
  root: string;
  reachPct: number;
  avgS: number;
  ctrPct: number;
  clicks: number;
}

export interface HeatmapModel {
  views: number;
  /** Sampled → estimated counts. */
  scale: number;
  clicks: number;
  rage: number;
  dead: number;
  error: number;
  /** Percent of the document, 0..100. */
  avgDepth: number | null;
  avgFold: number | null;
  activeS: number | null;
  smallSample: boolean;
  pages: { page: string; views: number }[];
  devices: { device: HeatDevice; views: number; meanVw: number | null }[];
  elements: HeatElement[];
  grid: { fixed: boolean; xb: number; yb: number; clicks: number }[];
  /** hmScroll: views by max depth and the share that reached it (percent). */
  scroll: { depth: number; views: number; reachPct: number }[];
  attention: { band: number; ds: number }[];
  sections: HeatSection[];
}

const isDevice = (v: unknown): v is HeatDevice =>
  v === "desktop" || v === "tablet" || v === "mobile";

/** Normalise the `view=heatmap` payload; absent panels read as empty. */
export function parseHeatmap(data: Row): HeatmapModel {
  const s = rows(data.hmSummary)[0] ?? {};
  const views = num(s.views);
  const nullable = (v: unknown) => (v == null || !views ? null : num(v));
  const pages = new Map<string, number>();
  for (const r of rows(data.hmPages)) {
    const page = str(r.page_key);
    pages.set(page, (pages.get(page) ?? 0) + num(r.views));
  }
  return {
    views,
    scale: num(s.scale) || 1,
    clicks: num(s.clicks),
    rage: num(s.rage),
    dead: num(s.dead),
    error: num(s.error),
    avgDepth: nullable(s.avg_depth),
    avgFold: nullable(s.avg_fold),
    activeS: nullable(s.active_s),
    smallSample: num(s.small_sample) === 1,
    pages: [...pages]
      .map(([page, v]) => ({ page, views: v }))
      .sort((a, b) => b.views - a.views),
    devices: rows(data.hmDevices).flatMap((r) =>
      isDevice(r.device)
        ? [
            {
              device: r.device,
              views: num(r.views),
              meanVw: num(r.mean_vw) || null,
            },
          ]
        : [],
    ),
    elements: rows(data.hmElements).map((r) => {
      const root = str(r.root);
      const el = str(r.el);
      const cells: Record<string, number> = {};
      if (r.cells && typeof r.cells === "object") {
        for (const [k, v] of Object.entries(r.cells)) cells[k] = num(v);
      }
      return {
        key: `${root}|${el}`,
        root,
        el,
        clicks: num(r.clicks),
        views: num(r.views),
        rage: num(r.rage),
        dead: num(r.dead),
        error: num(r.error),
        first: num(r.first),
        cells,
      };
    }),
    grid: rows(data.hmGrid).map((r) => ({
      fixed: num(r.fixed) === 1 || r.fixed === true,
      xb: num(r.xb),
      yb: num(r.yb),
      clicks: num(r.clicks),
    })),
    scroll: rows(data.hmScroll).map((r) => ({
      depth: num(r.depth),
      views: num(r.views),
      reachPct: num(r.reach_pct),
    })),
    attention: rows(data.hmAttention).map((r) => ({
      band: num(r.band),
      ds: num(r.ds),
    })),
    sections: rows(data.hmSections).map((r) => ({
      root: str(r.root),
      reachPct: num(r.reach_pct),
      avgS: num(r.avg_s),
      ctrPct: num(r.ctr_pct),
      clicks: num(r.clicks),
    })),
  };
}

export function weightOf(e: HeatElement, type: ClickType): number {
  return type === "all" ? e.clicks : e[type];
}

/** Share of views (0..1) that reached `depth` percent of the page. */
export function reachAt(scroll: HeatmapModel["scroll"], depth: number): number {
  if (depth <= 0) return 1;
  const next = scroll.find((r) => r.depth >= depth);
  return next ? next.reachPct / 100 : 0;
}

const DESKTOP_WIDTHS = [1280, 1366, 1440, 1536, 1920];

/** Frame width: the bucket's mean viewport snapped to a common screen (same rule as the insights viewer). */
export function renderWidth(
  device: HeatDevice,
  meanVw: number | null | undefined,
): number {
  if (device === "mobile") return 390;
  if (device === "tablet") {
    return meanVw && meanVw >= 768 && meanVw < 1024 ? Math.round(meanVw) : 820;
  }
  if (!meanVw || meanVw < 1024) return 1440;
  return DESKTOP_WIDTHS.reduce((a, b) =>
    Math.abs(b - meanVw) < Math.abs(a - meanVw) ? b : a,
  );
}

/** Colour stops [t, r, g, b, alpha] — the overlay's own ramps (runtime/view/heat-core.ts). */
type Stop = [t: number, r: number, g: number, b: number, a: number];
const RAMPS: Record<HeatRamp, Stop[]> = {
  thermal: [
    [0, 0, 40, 255, 0],
    [0.08, 20, 70, 255, 0.28],
    [0.25, 0, 185, 255, 0.5],
    [0.45, 30, 220, 110, 0.62],
    [0.65, 250, 232, 40, 0.74],
    [0.82, 255, 140, 0, 0.82],
    [1, 225, 18, 30, 0.9],
  ],
  inferno: [
    [0, 0, 0, 4, 0],
    [0.1, 40, 11, 84, 0.3],
    [0.3, 101, 21, 110, 0.5],
    [0.5, 159, 42, 99, 0.64],
    [0.7, 212, 72, 66, 0.74],
    [0.85, 245, 125, 21, 0.84],
    [1, 252, 255, 164, 0.92],
  ],
};

/** CSS colour of a ramp at t (0..1), for the legend and the list meters. */
export function rampCss(ramp: HeatRamp, t: number, alpha?: number): string {
  const stops = RAMPS[ramp];
  const x = Math.min(1, Math.max(0, t));
  const i = Math.max(
    1,
    stops.findIndex((s) => s[0] >= x),
  );
  const lo = stops[i - 1];
  const hi = stops[i];
  if (!lo || !hi) return "transparent";
  const f = hi[0] > lo[0] ? (x - lo[0]) / (hi[0] - lo[0]) : 0;
  const mix = (c: 1 | 2 | 3 | 4) => lo[c] + (hi[c] - lo[c]) * f;
  return `rgba(${Math.round(mix(1))},${Math.round(mix(2))},${Math.round(mix(3))},${alpha ?? +mix(4).toFixed(3)})`;
}

// --- the framed site ----------------------------------------------------------

/** Origin of the site's registered domain (bare host or URL), or null. */
export function siteOrigin(domain: string | null | undefined): string | null {
  const raw = domain?.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "https:" || url.hostname === "localhost"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** The live page in view mode. Only a concrete path: a template key (`/:product/p`) cannot be framed. */
export function frameUrl(origin: string, path: string): string | null {
  if (!path.startsWith("/") || path.includes(":")) return null;
  const url = new URL(path, origin);
  if (url.origin !== origin) return null;
  url.searchParams.set("dq_view", "1");
  return url.href;
}

/** View-mode protocol version (decocms/analytics `VIEW_PROTOCOL`). */
export const VIEW_PROTOCOL = 1;

export interface PlacedItem {
  key: string;
  label: string;
  /** el = on its element; sec = on its section's zone; none = not on this page version. */
  found: "el" | "sec" | "none";
  y: number;
}

export interface PlacedBlock {
  key: string;
  name: string;
  heading: string;
  y: number;
  h: number;
  clicks: number;
  reach: number | null;
  seconds: number | null;
}

type ViewMessage =
  | { t: "ready"; url?: string; anchors?: number }
  | {
      t: "placed";
      items: PlacedItem[];
      blocks: PlacedBlock[];
      legend: number[];
      stats: { matched: number; inSection: number; total: number };
    }
  | {
      t: "hover";
      key: string | null;
      label?: string | null;
      x?: number;
      y?: number;
      pct?: number;
    }
  | { t: "select"; key: string };

/**
 * A message from the framed site, or null. Trust is the frame's window AND
 * the site's registered origin AND the protocol tag: a page that navigated
 * the frame elsewhere, or any other window, is ignored.
 */
export function readViewMessage(
  e: { source: unknown; origin: string; data: unknown },
  frame: unknown,
  origin: string,
): ViewMessage | null {
  if (!frame || e.source !== frame || e.origin !== origin) return null;
  const d = e.data as Row | null;
  if (!d || typeof d !== "object" || d.dq !== "hm" || d.v !== VIEW_PROTOCOL)
    return null;
  switch (d.t) {
    case "ready":
      return { t: "ready", url: str(d.url), anchors: num(d.anchors) };
    case "placed":
      return Array.isArray(d.items) && Array.isArray(d.blocks)
        ? (d as unknown as ViewMessage)
        : null;
    case "hover":
      return {
        t: "hover",
        key: typeof d.key === "string" ? d.key : null,
        label: typeof d.label === "string" ? d.label : null,
        x: typeof d.x === "number" ? d.x : undefined,
        y: typeof d.y === "number" ? d.y : undefined,
        pct: typeof d.pct === "number" ? d.pct : undefined,
      };
    case "select":
      return typeof d.key === "string" ? { t: "select", key: d.key } : null;
    default:
      return null;
  }
}

/** What the overlay draws (decocms/analytics `ViewData`): rows as the read surface sends them. */
export function viewData(
  m: HeatmapModel,
  o: {
    mode: HeatMode;
    type: ClickType;
    ramp: HeatRamp;
    opacity: number;
    device: HeatDevice;
  },
) {
  return {
    mode: o.mode,
    elements: m.elements.flatMap((e) => {
      const clicks = weightOf(e, o.type);
      return clicks > 0
        ? [{ root: e.root, el: e.el, clicks, cells: e.cells }]
        : [];
    }),
    // The coordinate grid holds every click, not one type: only the "all" map uses it.
    grid: o.type === "all" ? m.grid : [],
    depth: m.scroll.map((r) => ({ depth: r.depth, views: r.views })),
    attention: m.attention,
    sections: m.sections.map((s) => ({
      root: s.root,
      reach_pct: s.reachPct,
      avg_s: s.avgS,
      clicks: s.clicks,
    })),
    views: m.views,
    avgFold: m.avgFold,
    scale: m.scale,
    ramp: o.ramp,
    opacity: o.opacity,
    radius: o.device === "desktop" ? 28 : 36,
  };
}

/** "site/sections/Product/Shelf.tsx#1" → "Shelf 2"; "fs:hero-slideshow#0" → "Hero slideshow"; "" → null. */
export function rootName(root: string): string | null {
  if (!root) return null;
  if (root.startsWith("#")) return root;
  const i = root.lastIndexOf("#");
  const path = i >= 0 ? root.slice(0, i) : root;
  const ord = i >= 0 ? Number(root.slice(i + 1)) : 0;
  const base = path.startsWith("fs:")
    ? path
        .slice(3)
        .replace(/-/g, " ")
        .replace(/^./, (c) => c.toUpperCase())
    : (path.split("/").pop() ?? path).replace(/\.tsx?$/, "");
  return ord > 0 ? `${base} ${ord + 1}` : base;
}

/** The dashboard tabs a site gets: Heatmap only when its analytics modules
 *  include `heatmap`, so a site that never enabled it sees no tab and fires no
 *  heatmap request. */
export function gateViews<T extends { view: string }>(
  views: readonly T[],
  modules: readonly string[],
): T[] {
  return views.filter(
    (v) => v.view !== "heatmap" || modules.includes("heatmap"),
  );
}

/** The tab to show: the requested one (tab state or a `?view=` deep-link) when
 *  the site is offered it, otherwise Overview. */
export function pickView(
  requested: string | undefined,
  views: readonly { view: string }[],
): string {
  return requested && views.some((v) => v.view === requested)
    ? requested
    : "overview";
}
