/**
 * Deco Analytics → Live map: visitors, carts and conversions of the last five
 * minutes, drawn on a globe.
 *
 * Studio does NOT draw this one. The renderer is a bundle built and shipped by
 * the analytics read surface (`decocms/analytics dashboard/globe`), proxied to
 * the browser through our BFF because the read surface keeps every route behind
 * its gate — including this script. It paints into a canvas and owns one piece
 * of text, its hover card, which it takes from us as options rather than
 * guessing a language. Studio owns the frame: the tab, the numbers, the mode
 * toggle, and the stylesheet the renderer reads its palette from.
 *
 * The split matters for debugging: an empty map with live numbers above it is
 * a RENDERER problem (bundle, canvas, CSS); numbers that stay at zero are a
 * DATA problem (`liveGeo`, the BFF allowlist, the warehouse).
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { fetchJson, isNotConfigured } from "./analytics-tab.tsx";
import "./analytics-globe.css";

const P = "mainPanelTabs.analyticsTab.globe";
type GlobeKey = TranslationKey extends infer K
  ? K extends `${typeof P}.${infer R}`
    ? R
    : never
  : never;
const k = (s: GlobeKey): TranslationKey => `${P}.${s}`;

/** The window the panel aggregates, and the window the renderer animates over.
 *  Both are five minutes because they are the same five minutes — the dots
 *  pulse across exactly the span the counts were taken from. */
const WINDOW_MS = 5_000;
const POLL_MS = 5_000;

type ViewMode = "globe" | "map";

/** One row of the read surface's `liveGeo` panel. An aggregated place, never a
 *  person: the finest resolution is a city centroid. */
interface LiveGeoRow {
  kind: string;
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lng: number | null;
  /** ClickHouse sends UInt64 as a string. */
  visitors: number | string;
}

interface GlobeStats {
  /** Distinct (kind, place) groups drawn. */
  places: number;
  placed: number;
  /** Visitors on a country label point, because their rows carried no city. */
  approximate: number;
  /** Visitors with no usable location at all — counted, not drawn. */
  unplaced: number;
}

interface GlobeController {
  update(rows: readonly LiveGeoRow[], windowMs: number): GlobeStats;
  setMode(mode: ViewMode): void;
  destroy(): void;
}

/** The bundle's whole surface, as `window.DQGlobe`. */
interface GlobeApi {
  mount(
    host: HTMLElement,
    opts: {
      mode?: ViewMode;
      locale?: string;
      labels?: Partial<
        Record<"visitor" | "cart" | "conversion" | "countryLevel", string>
      >;
      plural?: (n: number, one: string) => string;
    },
  ): GlobeController;
  defaultMode(): ViewMode;
  /** Pure: the same grouping `update` does internally, exposed so a host can
   *  read the counts without driving the canvas. */
  buildPoints(rows: readonly LiveGeoRow[]): GlobeStats;
}

declare global {
  interface Window {
    DQGlobe?: GlobeApi;
  }
}

/**
 * Load the renderer, once per document.
 *
 * A classic `<script>` rather than `import()`: the bundle is an IIFE that
 * assigns `window.DQGlobe` itself (deliberately, so it does not depend on a
 * bundler flag), and it is served from our own origin by the BFF, so the tag
 * carries the session cookie the proxy authorizes against.
 *
 * The `window.DQGlobe` check comes first because React Query may call this
 * again after a cache eviction; re-running the IIFE would be harmless but
 * pointless, and a second tag is a second thing to see in the network panel.
 */
function loadGlobeBundle(src: string): Promise<GlobeApi> {
  if (window.DQGlobe) return Promise.resolve(window.DQGlobe);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => {
      const api = window.DQGlobe;
      // Loaded but no global: a 200 that is not the bundle — an HTML error page
      // served with the wrong content type, most likely. Rejecting here turns a
      // blank map into a reported failure.
      if (api) resolve(api);
      else reject(new Error("globe bundle loaded without DQGlobe"));
    };
    el.onerror = () => reject(new Error("globe bundle failed to load"));
    document.head.appendChild(el);
  });
}

const rowsOf = (payload: unknown): LiveGeoRow[] => {
  const geo = (payload as { liveGeo?: unknown } | null)?.liveGeo;
  return Array.isArray(geo) ? (geo as LiveGeoRow[]) : [];
};

/** The `liveVisitors` panel's single number: uniques in the window. The globe's
 *  own `placed` count is NOT this — a visitor with no coordinate is still a
 *  visitor, which is the whole reason "not located" is shown beside it. */
const visitorsOf = (payload: unknown): number => {
  const live = (payload as { liveVisitors?: unknown } | null)?.liveVisitors;
  const first = Array.isArray(live) ? live[0] : null;
  const n = Number((first as { visitors?: unknown } | null)?.visitors ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const EMPTY_STATS: GlobeStats = {
  places: 0,
  placed: 0,
  approximate: 0,
  unplaced: 0,
};

function Kpi({
  label,
  hint,
  value,
  accent,
}: {
  label: string;
  hint: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <i className={cn("size-2 shrink-0 rounded-full", accent)} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

const SEG =
  "inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors";
const SEG_ON = "bg-background text-foreground shadow-xs";
const SEG_OFF = "text-muted-foreground hover:text-foreground";

export function GlobeView({
  base,
  orgSlug,
  site,
}: {
  base: string;
  orgSlug: string;
  site: string;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<GlobeController | null>(null);
  // `null` means "whatever the renderer picks for this device" — it drops to a
  // flat map on a low-end GPU or under `prefers-reduced-motion`, and overriding
  // that before the user asks would be deciding for them.
  const [mode, setMode] = useState<ViewMode | null>(null);

  const bundle = useQuery({
    queryKey: KEYS.analyticsGlobeBundle(orgSlug, site),
    queryFn: () => loadGlobeBundle(`${base}/analytics/globe.js`),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const data = useQuery({
    queryKey: KEYS.analyticsData(orgSlug, site, "globe", "5m"),
    queryFn: () => fetchJson(`${base}/analytics/data?view=globe&range=5m`),
    retry: false,
    staleTime: 0,
    refetchInterval: POLL_MS,
    // The map should not blink back to a skeleton every five seconds; the dots
    // animate from the previous frame to the next one.
    placeholderData: (prev) => prev,
  });

  const payload = (data.data as { data?: unknown } | undefined)?.data ?? null;
  const rows = rowsOf(payload);
  const api = bundle.data ?? null;

  // Counted during render, from the same pure grouping the renderer uses, so
  // the KPIs never have to come back out of the canvas. The alternative — read
  // `update()`'s return and store it — would be setState from an effect on
  // every poll, which is both banned here and a re-render we do not need.
  const stats = api && rows.length ? api.buildPoints(rows) : EMPTY_STATS;
  const visitors = visitorsOf(payload);
  const nf = new Intl.NumberFormat(locale);

  const labels = {
    visitor: t(k("visitor")),
    cart: t(k("cart")),
    conversion: t(k("conversion")),
    countryLevel: t(k("countryLevel")),
  };
  // The renderer hands back the singular it was given and asks for the phrase.
  // Keyed by that string because it is the only thing the callback receives —
  // and it is always one of the three just above.
  const plurals: Record<string, string> = {
    [labels.visitor]: t(k("visitorPlural")),
    [labels.cart]: t(k("cartPlural")),
    [labels.conversion]: t(k("conversionPlural")),
  };

  // Mount and tear down the canvas. This is the textbook external-system
  // lifecycle useEffect exists for: an imperative renderer that allocates
  // WebGL contexts and listeners, and must release them when the tab closes.
  // Re-runs on locale because the renderer takes its strings AT MOUNT.
  //
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- attaches/detaches a canvas renderer (an external system) to a DOM node; nothing else can free its GL context and listeners
  useEffect(() => {
    const host = hostRef.current;
    if (!api || !host) return;
    const controller = api.mount(host, {
      mode: mode ?? api.defaultMode(),
      locale,
      labels,
      plural: (n, one) => (n === 1 ? one : (plurals[one] ?? one)),
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
    // `mode` is deliberately absent: switching it goes through `setMode` on the
    // live controller, which animates the transition. Listing it here would
    // destroy and rebuild the globe on every toggle instead.
    //
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [api, locale]);

  // Push each poll into the canvas. Separate from the mount effect so new rows
  // redraw rather than rebuild.
  //
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs the canvas (an external system) with the latest liveGeo rows; the renderer owns the animation between frames
  useEffect(() => {
    // Keyed on `payload`, not on the derived array: React Query hands back the
    // same payload object until the next poll resolves, so this redraws once
    // per fetch rather than once per render.
    controllerRef.current?.update(rowsOf(payload), WINDOW_MS);
  }, [payload]);

  const show = (next: ViewMode) => {
    setMode(next);
    controllerRef.current?.setMode(next);
  };

  if (bundle.isLoading || (data.isLoading && !data.data)) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (data.error) {
    return (
      <p className="text-sm text-muted-foreground">
        {isNotConfigured(data.error)
          ? t("mainPanelTabs.analyticsTab.dataNotConfiguredDescription")
          : t("mainPanelTabs.analyticsTab.dataLoadError")}
      </p>
    );
  }

  const current = mode ?? api?.defaultMode() ?? "globe";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-8">
          <Kpi
            label={t(k("kpiVisitors"))}
            hint={t(k("kpiVisitorsHint"))}
            value={nf.format(visitors)}
            accent="bg-chart-2"
          />
          <Kpi
            label={t(k("kpiPlaces"))}
            hint={t(k("kpiPlacesHint"))}
            value={nf.format(stats.places)}
            accent="bg-chart-1"
          />
          <Kpi
            label={t(k("kpiApproximate"))}
            hint={t(k("kpiApproximateHint"))}
            value={nf.format(stats.approximate)}
            accent="bg-chart-4"
          />
          <Kpi
            label={t(k("kpiUnplaced"))}
            hint={t(k("kpiUnplacedHint"))}
            value={nf.format(stats.unplaced)}
            accent="bg-muted-foreground"
          />
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          <button
            type="button"
            onClick={() => show("globe")}
            aria-pressed={current === "globe"}
            className={cn(SEG, current === "globe" ? SEG_ON : SEG_OFF)}
          >
            {t(k("modeGlobe"))}
          </button>
          <button
            type="button"
            onClick={() => show("map")}
            aria-pressed={current === "map"}
            className={cn(SEG, current === "map" ? SEG_ON : SEG_OFF)}
          >
            {t(k("modeMap"))}
          </button>
        </div>
      </div>

      {/* The host the renderer draws into and appends its hover card to. Kept
          mounted even when the bundle failed, so the numbers above stay put and
          the failure reads as "no map" rather than "no data". */}
      <div ref={hostRef} className="globe-wrap" />

      {bundle.error && (
        <p className="text-sm text-muted-foreground">{t(k("loadError"))}</p>
      )}
    </div>
  );
}
