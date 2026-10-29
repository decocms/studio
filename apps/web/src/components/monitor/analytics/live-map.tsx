/**
 * The Live map: Deco Analytics' globe renderer (`window.DQGlobe`), loaded from
 * the read surface through the BFF and drawn over the `liveGeo` rows of the
 * realtime payload. The bundle is optional — when it cannot load, the card
 * does not render and the rest of Realtime stands on its own.
 */

import { useState, useSyncExternalStore } from "react";
import { Target04 } from "@untitledui/icons";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import type { Locale } from "@/i18n/locale.ts";
import { translate, useT } from "@/i18n/use-t.ts";

/** The `liveGeo` row the renderer takes, as queries.mjs selects it. */
export interface LiveGeoRow {
  kind: string;
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lng: number | null;
  visitors: number;
}

/** The read surface caps `liveGeo` at this many (kind, place) rows. */
const LIVE_GEO_LIMIT = 500;
/** The realtime window the pulses are spread across. */
const WINDOW_MS = 5 * 60 * 1000;

type ViewMode = "globe" | "map";

interface Snapshot {
  places: number;
  placed: number;
  approximate: number;
  unplaced: number;
}

interface Controller {
  update(rows: readonly LiveGeoRow[], windowMs: number): Snapshot;
  setMode(mode: ViewMode): void;
  center(): void;
  destroy(): void;
}

interface GlobeApi {
  mount(
    host: HTMLElement,
    opts: {
      mode?: ViewMode;
      onDegrade?: () => void;
      locale?: string;
      labels?: {
        visitor: string;
        cart: string;
        conversion: string;
        countryLevel: string;
      };
      plural?: (n: number, one: string) => string;
    },
  ): Controller;
  defaultMode(): ViewMode;
}

function isGlobeApi(value: unknown): value is GlobeApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "mount" in value &&
    typeof value.mount === "function" &&
    "defaultMode" in value &&
    typeof value.defaultMode === "function"
  );
}

const readGlobal = (): GlobeApi | null => {
  const api: unknown = Reflect.get(globalThis, "DQGlobe");
  return isGlobeApi(api) ? api : null;
};

export type GlobeLoad =
  | { state: "loading" }
  | { state: "ready"; api: GlobeApi }
  | { state: "failed" };

interface GlobeStore {
  subscribe: (listener: () => void) => () => void;
  get: () => GlobeLoad;
}

const LOADING: GlobeLoad = { state: "loading" };
const stores = new Map<string, GlobeStore>();

/**
 * One store per bundle URL, loading its `<script>` on first subscribe. The
 * bundle sets one global whichever site served it, so once any copy is in
 * the page every other mount reads it without another request. A failed load
 * stays failed until the page reloads, rather than retrying on every render.
 */
function globeStore(src: string): GlobeStore {
  const existing = stores.get(src);
  if (existing) return existing;

  let snapshot: GlobeLoad = LOADING;
  let started = false;
  const listeners = new Set<() => void>();
  const settle = (next: GlobeLoad) => {
    snapshot = next;
    for (const l of listeners) l();
  };
  const start = () => {
    started = true;
    const ready = readGlobal();
    if (ready) {
      snapshot = { state: "ready", api: ready };
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      const api = readGlobal();
      settle(api ? { state: "ready", api } : { state: "failed" });
    };
    script.onerror = () => {
      script.remove();
      settle({ state: "failed" });
    };
    document.head.appendChild(script);
  };

  const store: GlobeStore = {
    subscribe: (listener) => {
      listeners.add(listener);
      if (!started) {
        start();
        if (snapshot.state !== "loading") listener();
      }
      return () => listeners.delete(listener);
    },
    get: () => snapshot,
  };
  stores.set(src, store);
  return store;
}

/** The renderer bundle for a site's map: loading, ready, or unavailable. */
export function useGlobeBundle(orgSlug: string, site: string): GlobeLoad {
  const store = globeStore(
    `/api/${orgSlug}/hosting/${encodeURIComponent(site)}/analytics/globe.js`,
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const LOCALE_TAG: Record<Locale, string> = { en: "en-US", "pt-BR": "pt-BR" };

/** The renderer's tooltip nouns, with their plurals, in the current language. */
function globeStrings() {
  const pairs = [
    [
      translate("monitor.analytics.live.tipVisitor"),
      translate("monitor.analytics.live.tipVisitors"),
    ],
    [
      translate("monitor.analytics.live.tipCart"),
      translate("monitor.analytics.live.tipCarts"),
    ],
    [
      translate("monitor.analytics.live.tipConversion"),
      translate("monitor.analytics.live.tipConversions"),
    ],
  ] as const;
  const plurals = new Map<string, string>(pairs);
  return {
    labels: {
      visitor: pairs[0][0],
      cart: pairs[1][0],
      conversion: pairs[2][0],
      countryLevel: translate("monitor.analytics.live.tipCountryLevel"),
    },
    plural: (n: number, one: string) =>
      n === 1 ? one : (plurals.get(one) ?? one),
  };
}

/**
 * The palette the renderer reads off its host. Kinds use the chart slots the
 * dashboard picked (violet / green / yellow separate by lightness as well as
 * hue); the ocean is darker than the card in dark mode so the planet reads
 * as a hole in the page rather than a sticker on it.
 */
const GLOBE_THEME = cn(
  "[--globe-visit:var(--chart-2)] [--globe-cart:var(--chart-4)] [--globe-goal:var(--chart-1)]",
  "[--globe-ocean:oklch(0.965_0.004_80)] [--globe-land:oklch(0.9_0.008_80)] [--globe-line:oklch(0.87_0.005_80)] [--globe-edge:oklch(0.72_0.05_80)] [--globe-dark:0]",
  "dark:[--globe-ocean:oklch(0.145_0.006_60)] dark:[--globe-land:oklch(0.245_0.006_60)] dark:[--globe-line:oklch(0.3_0.005_60)] dark:[--globe-edge:oklch(0.52_0.09_150)] dark:[--globe-dark:1]",
);

/** The renderer's hover card, which it builds as `.globe-tip` inside the host. */
const GLOBE_TIP = cn(
  "[&_.globe-tip]:pointer-events-none [&_.globe-tip]:absolute [&_.globe-tip]:z-10 [&_.globe-tip]:flex [&_.globe-tip]:flex-col [&_.globe-tip]:gap-0.5",
  "[&_.globe-tip]:whitespace-nowrap [&_.globe-tip]:rounded-lg [&_.globe-tip]:border [&_.globe-tip]:border-border [&_.globe-tip]:bg-popover [&_.globe-tip]:px-2.5 [&_.globe-tip]:py-1.5",
  "[&_.globe-tip]:text-xs [&_.globe-tip]:text-popover-foreground [&_.globe-tip]:shadow-md",
  "[&_.globe-tip_strong]:font-medium [&_.globe-tip-sub]:text-muted-foreground",
  "[&_.globe-tip-line]:flex [&_.globe-tip-line]:items-center [&_.globe-tip-line]:gap-1.5 [&_.globe-tip-line]:tabular-nums",
  "[&_.globe-tip-line_i]:size-2 [&_.globe-tip-line_i]:flex-none [&_.globe-tip-line_i]:rounded-full",
);

export function LiveMap({
  load,
  rows,
  stamp,
}: {
  /** From `useGlobeBundle`; never `failed` — the caller drops the card then. */
  load: GlobeLoad;
  rows: readonly LiveGeoRow[];
  /** When the rows were fetched; a new stamp is a new snapshot to draw. */
  stamp: number;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language;
  const [mode, setMode] = useState<ViewMode | null>(null);
  const [counts, setCounts] = useState<Snapshot | null>(null);
  const [degraded, setDegraded] = useState(false);
  // Canvas handles: written by ref callbacks and handlers, never read in render.
  const [live] = useState(() => ({
    ctl: null as Controller | null,
    mode: null as ViewMode | null,
    rows: null as readonly LiveGeoRow[] | null,
    stamp: -1,
  }));

  const api = load.state === "ready" ? load.api : null;
  const shownMode = mode ?? api?.defaultMode() ?? "globe";

  const draw = (ctl: Controller, next: readonly LiveGeoRow[]) => {
    const s = ctl.update(next, WINDOW_MS);
    setCounts((prev) =>
      prev &&
      prev.places === s.places &&
      prev.placed === s.placed &&
      prev.approximate === s.approximate &&
      prev.unplaced === s.unplaced
        ? prev
        : s,
    );
  };

  // The tooltip language is fixed at mount, so the host is keyed on locale.
  const mountHost = (host: HTMLDivElement | null) => {
    if (!host || !api) return;
    const strings = globeStrings();
    const ctl = api.mount(host, {
      mode: live.mode ?? api.defaultMode(),
      locale: LOCALE_TAG[locale],
      labels: strings.labels,
      plural: strings.plural,
      onDegrade: () => setDegraded(true),
    });
    live.ctl = ctl;
    if (live.rows) draw(ctl, live.rows);
    return () => {
      ctl.destroy();
      if (live.ctl === ctl) live.ctl = null;
    };
  };

  // A new callback per poll's rows, so each snapshot reaches the live canvas.
  const feed = (node: HTMLDivElement | null) => {
    if (!node || live.stamp === stamp) return;
    live.stamp = stamp;
    live.rows = rows;
    if (live.ctl) draw(live.ctl, rows);
  };

  const changeMode = (value: string) => {
    if (value !== "globe" && value !== "map") return;
    live.mode = value;
    live.ctl?.setMode(value);
    setMode(value);
  };

  const notes = [
    rows.length >= LIVE_GEO_LIMIT
      ? t("monitor.analytics.live.capped", { count: LIVE_GEO_LIMIT })
      : null,
    degraded ? t("monitor.analytics.live.simplified") : null,
  ].filter((n): n is string => n !== null);
  const nf = new Intl.NumberFormat(LOCALE_TAG[locale]);
  const stats: ReadonlyArray<[string, number | undefined]> = [
    [t("monitor.analytics.live.places"), counts?.places],
    [t("monitor.analytics.live.placed"), counts?.placed],
    [t("monitor.analytics.live.countryLevel"), counts?.approximate],
    [t("monitor.analytics.live.unplaced"), counts?.unplaced],
  ];

  return (
    <section
      className={cn(
        "surface flex h-full flex-col overflow-hidden",
        GLOBE_THEME,
      )}
    >
      <header className="flex items-center gap-2 px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("monitor.analytics.live.title")}
        </h3>
        <div className="ml-auto flex items-center gap-1.5">
          <IconButton
            label={t("monitor.analytics.live.center")}
            disabled={!api}
            onClick={() => live.ctl?.center()}
          >
            <Target04 />
          </IconButton>
          <ToggleGroup
            type="single"
            variant="segmented"
            size="sm"
            value={shownMode}
            onValueChange={changeMode}
            aria-label={t("monitor.analytics.live.projection")}
          >
            <ToggleGroupItem value="globe" className="px-2.5 text-xs">
              {t("monitor.analytics.live.globe")}
            </ToggleGroupItem>
            <ToggleGroupItem value="map" className="px-2.5 text-xs">
              {t("monitor.analytics.live.map")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </header>
      <div
        ref={feed}
        className={cn(
          "relative min-h-80 flex-1 overflow-hidden border-y border-border bg-[var(--globe-ocean)]",
          GLOBE_TIP,
        )}
      >
        {api ? (
          <div key={locale} ref={mountHost} className="absolute inset-0" />
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
      </div>
      <footer className="flex flex-wrap items-end gap-x-6 gap-y-3 px-4 py-3">
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {stats.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-meta">{label}</dt>
              <dd className="tnum text-sm font-medium text-foreground">
                {value === undefined ? "—" : nf.format(value)}
              </dd>
            </div>
          ))}
        </dl>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-meta">
          <LegendMark
            kind="visit"
            label={t("monitor.analytics.live.legendVisits")}
          />
          <LegendMark
            kind="cart"
            label={t("monitor.analytics.live.legendCarts")}
          />
          <LegendMark
            kind="goal"
            label={t("monitor.analytics.live.legendConversions")}
          />
          {notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      </footer>
    </section>
  );
}

/** The legend repeats each mark's shape, not only its colour. */
function LegendMark({
  kind,
  label,
}: {
  kind: "visit" | "cart" | "goal";
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        className={cn(
          "size-2 flex-none",
          kind === "visit" && "rounded-full bg-[var(--globe-visit)]",
          kind === "cart" && "rotate-45 bg-[var(--globe-cart)]",
          kind === "goal" &&
            "rounded-full bg-[var(--globe-goal)] outline-[1.5px] outline-offset-[1.5px] outline-[var(--globe-goal)] outline-solid",
        )}
      />
      {label}
    </span>
  );
}
