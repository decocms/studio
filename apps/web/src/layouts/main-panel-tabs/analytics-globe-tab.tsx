/**
 * Deco Analytics → the live map, drawn on a globe on the Analytics home.
 *
 * Studio does NOT draw the map. The renderer is a bundle built and shipped by
 * the analytics read surface (`decocms/analytics dashboard/globe`), proxied to
 * the browser through our BFF because the read surface keeps every route behind
 * its gate — including this script. It paints into a canvas and owns one piece
 * of text, its hover card, which it takes from us as options rather than
 * guessing a language. Studio owns the frame: the mode toggle, the caption, and
 * the stylesheet the renderer reads its palette from.
 *
 * `rows` is the live poll's `liveGeo`; `history` replays the range under it.
 *
 * The split matters for debugging: an empty map with live numbers above it is
 * a RENDERER problem (bundle, canvas, CSS); a caption that stays at zero is a
 * DATA problem (`liveGeo`, the BFF allowlist, the warehouse).
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import "./analytics-globe.css";

const P = "mainPanelTabs.analyticsTab.globe";
type GlobeKey = TranslationKey extends infer K
  ? K extends `${typeof P}.${infer R}`
    ? R
    : never
  : never;
const k = (s: GlobeKey): TranslationKey => `${P}.${s}`;

/** How long the renderer spreads each frame's pulses over: the live poll's
 *  interval, so one frame's rings finish as the next frame arrives. */
const FRAME_MS = 5_000;

/** Replay cadence, and how many of the range's places each replayed frame
 *  carries. Shorter than a live frame because a replay has no fetch to wait
 *  for, and a handful of places at a time so the map reads as traffic arriving
 *  rather than as one static constellation blinking in place. */
const REPLAY_MS = 2_000;
const REPLAY_PLACES = 3;

/** Shared empty arrays: a fresh `[]` from the caller on every render would
 *  restart the replay interval (and its position) on every parent re-render. */
const NO_ROWS: readonly LiveGeoRow[] = [];

type ViewMode = "globe" | "map";

/** One row of the read surface's `liveGeo` panel. An aggregated place, never a
 *  person: the finest resolution is a city centroid. */
export interface LiveGeoRow {
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

const EMPTY_STATS: GlobeStats = {
  places: 0,
  placed: 0,
  approximate: 0,
  unplaced: 0,
};

const SEG =
  "inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors";
const SEG_ON = "bg-background text-foreground shadow-xs";
const SEG_OFF = "text-muted-foreground hover:text-foreground";

/** The three kinds the map plots at once, in the order the CSS declares them. */
type MarkKind = "visit" | "cart" | "goal";

const LEGEND = [
  { kind: "visit", label: "legendVisits" },
  { kind: "cart", label: "legendCarts" },
  { kind: "goal", label: "legendConversions" },
] as const satisfies readonly { kind: MarkKind; label: GlobeKey }[];

/**
 * One legend mark, drawn to the shape the renderer paints: a dot, a diamond, a
 * dot inside a ring. Shape is the map's second encoding — three colours plotted
 * at once cannot separate under every colour-vision deficiency — so a legend of
 * three swatches would key the wrong half of the mark.
 */
function LegendMark({ kind }: { kind: MarkKind }) {
  const fill = `var(--globe-${kind})`;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5 shrink-0">
      {kind === "visit" && <circle cx="8" cy="8" r="3.6" fill={fill} />}
      {kind === "cart" && <path d="M8 3.4 12.6 8 8 12.6 3.4 8Z" fill={fill} />}
      {kind === "goal" && (
        <>
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke={fill}
            strokeWidth="1.4"
          />
          <circle cx="8" cy="8" r="2.8" fill={fill} />
        </>
      )}
    </svg>
  );
}

export function LiveGlobe({
  base,
  orgSlug,
  site,
  rows,
  history = NO_ROWS,
  rangeLabel,
}: {
  base: string;
  orgSlug: string;
  site: string;
  /** The `liveGeo` rows of the home view's current live poll. */
  rows: readonly LiveGeoRow[];
  /** The same rows over the selected range, replayed while nobody is on the
   *  site right now. */
  history?: readonly LiveGeoRow[];
  /** The selected range, named in the replay caption. */
  rangeLabel?: string;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<GlobeController | null>(null);
  /** Where the replay is in `history`; a ref so a re-render that restarts the
   *  interval resumes instead of jumping back to the first place. */
  const replayAt = useRef(0);
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
  const api = bundle.data ?? null;

  // Normalised to the shared empty array: the sync effect is keyed on these.
  const live = rows.length ? rows : NO_ROWS;
  const past = history.length ? history : NO_ROWS;
  const replaying = live.length === 0 && past.length > 0;
  const drawn = replaying ? past : live;

  // Counted during render, from the same pure grouping the renderer uses, so
  // the caption never has to come back out of the canvas.
  const stats = api && drawn.length ? api.buildPoints(drawn) : EMPTY_STATS;
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
    // The rows already in hand: the poll that brought them resolved before the
    // bundle did, and the sync effect below will not fire again until the next.
    controller.update(live, FRAME_MS);
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

  // Each poll, or — with nobody on the site — the range, a few places a frame.

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs the canvas (an external system) with the latest geo rows; the renderer owns the animation between frames
  useEffect(() => {
    if (!replaying) {
      controllerRef.current?.update(live, FRAME_MS);
      return;
    }
    const frame = () => {
      const slice: LiveGeoRow[] = [];
      for (let i = 0; i < Math.min(REPLAY_PLACES, past.length); i++) {
        const row = past[(replayAt.current + i) % past.length];
        if (row) slice.push(row);
      }
      replayAt.current = (replayAt.current + 1) % past.length;
      controllerRef.current?.update(slice, REPLAY_MS);
    };
    frame();
    const timer = setInterval(frame, REPLAY_MS);
    return () => clearInterval(timer);
  }, [api, live, past, replaying]);

  const show = (next: ViewMode) => {
    setMode(next);
    controllerRef.current?.setMode(next);
  };
  const current = mode ?? api?.defaultMode() ?? "globe";

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        {/* The host the renderer draws into and appends its hover card to. Kept
            mounted even when the bundle failed, so the failure reads as "no
            map" rather than "no data". */}
        <div ref={hostRef} className="globe-wrap" />
        <div className="absolute top-3 right-3 flex items-center gap-0.5 rounded-lg border border-border bg-background/80 p-0.5 backdrop-blur">
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
      {bundle.error ? (
        <p className="text-xs text-muted-foreground">{t(k("loadError"))}</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ul
            aria-label={t(k("legend"))}
            className="flex flex-wrap items-center gap-x-4 gap-y-1"
          >
            {LEGEND.map(({ kind, label }) => (
              <li key={kind} className="flex items-center gap-1.5 text-xs">
                <LegendMark kind={kind} />
                {t(k(label))}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {replaying && (
              <p className="text-xs text-muted-foreground">
                {t(k("replaying"), { range: rangeLabel ?? "" })}
              </p>
            )}
            <p className="text-xs text-muted-foreground tabular-nums">
              {t(k("caption"), {
                places: nf.format(stats.places),
                approximate: nf.format(stats.approximate),
                unplaced: nf.format(stats.unplaced),
              })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
