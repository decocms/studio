/**
 * Deco Analytics → Heatmap: the LIVE site in an iframe at the device width,
 * with the heat drawn inside it by the site's own analytics runtime in view
 * mode (`?dq_view=1` + a postMessage handshake from this origin). Studio owns
 * the filters, the modes and the lists; the framed page owns matching and
 * painting, because only it can read its own DOM.
 *
 * Trust: messages are accepted only from the frame's window AND the site's
 * registered origin, and every message to the frame is addressed to that
 * origin — a frame that navigated away gets nothing.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CursorClick01,
  Lock01,
  Monitor04,
  Phone02,
  Settings01,
  Tablet01,
} from "@untitledui/icons";
import { Badge as DsBadge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Slider } from "@decocms/ui/components/slider.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Tabs, TabsList, TabsTrigger } from "@decocms/ui/components/tabs.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { fetchJson, isNotConfigured } from "./analytics-tab.tsx";
import {
  CLICK_TYPES,
  CTR_MIN_SEEN,
  FUNNEL_STEPS,
  HEAT_DEVICES,
  HEAT_MODES,
  HEAT_RANGES,
  VIEW_PROTOCOL,
  elementCtr,
  frameUrl,
  parseHeatmap,
  rampCss,
  reachAt,
  readViewMessage,
  renderWidth,
  rootName,
  siteOrigin,
  viewData,
  weightOf,
  type ClickType,
  type HeatDevice,
  type HeatElement,
  type HeatFunnel,
  type HeatMode,
  type HeatRamp,
  type HeatRange,
  type HeatmapModel,
  type PlacedBlock,
  type PlacedItem,
} from "./analytics-heatmap-model.ts";

const P = "mainPanelTabs.analyticsTab.heatmap";
type HeatKey = TranslationKey extends infer K
  ? K extends `${typeof P}.${infer R}`
    ? R
    : never
  : never;
const k = (s: HeatKey): TranslationKey => `${P}.${s}`;

const DEVICE_ICON = { desktop: Monitor04, tablet: Tablet01, mobile: Phone02 };
/** The site answers `init` once its lazy view-mode chunk has loaded; give up after this. */
const HANDSHAKE_MS = 20_000;

type Placed = {
  items: PlacedItem[];
  blocks: PlacedBlock[];
  legend: number[];
  stats: { matched: number; total: number };
};
type Hover = {
  key: string | null;
  label: string | null;
  x: number;
  y: number;
  pct?: number;
};

export function HeatmapView({
  base,
  orgSlug,
  site,
  modules,
  domain,
  onConfigure,
}: {
  base: string;
  orgSlug: string;
  site: string;
  modules: string[];
  /** The site's registered domain: the only origin the frame may load and talk to. */
  domain: string | null;
  onConfigure: () => void;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language;
  const [page, setPage] = useState("/");
  const [device, setDevice] = useState<HeatDevice>("desktop");
  const [range, setRange] = useState<HeatRange>("7d");
  const [mode, setMode] = useState<HeatMode>("clicks");
  const [clickType, setClickType] = useState<ClickType>("all");
  const [sample, setSample] = useState("");
  const enabled = modules.includes("heatmap");
  const origin = siteOrigin(domain);

  const query = useQuery({
    queryKey: KEYS.analyticsHeatmap(orgSlug, site, range, page, device),
    queryFn: () =>
      fetchJson(
        `${base}/analytics/data?view=heatmap&range=${range}&page=${encodeURIComponent(
          page,
        )}&device=${device}`,
      ),
    enabled: enabled && Boolean(origin),
    retry: false,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  if (!enabled) {
    return (
      <EmptyState
        icon={<CursorClick01 />}
        title={t(k("offTitle"))}
        description={t(k("offDescription"))}
        buttonComponent={
          <Button size="sm" variant="outline" onClick={onConfigure}>
            <Settings01 className="size-4" />
            {t(k("openConfig"))}
          </Button>
        }
      />
    );
  }
  if (!origin) {
    return (
      <EmptyState
        icon={<CursorClick01 />}
        title={t(k("noDomainTitle"))}
        description={t(k("noDomainDescription"))}
      />
    );
  }

  const data = (query.data ?? null) as {
    data?: Record<string, unknown>;
  } | null;
  const model = data?.data ? parseHeatmap(data.data) : null;
  const template = page.includes(":");
  const framePath = template ? sample : page;
  const src = framePath ? frameUrl(origin, framePath) : null;
  const meanVw = model?.devices.find((d) => d.device === device)?.meanVw;
  const width = renderWidth(device, meanVw);
  const counts = { all: 0, rage: 0, dead: 0, error: 0, first: 0 };
  for (const e of model?.elements ?? []) {
    for (const c of CLICK_TYPES) counts[c] += weightOf(e, c);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <PageInput
          value={page}
          pages={model?.pages ?? []}
          label={t(k("page"))}
          onChange={(p) => {
            setPage(p);
            setSample("");
          }}
        />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label={t(k("device"))}
          value={device}
          onValueChange={(v) => {
            const next = HEAT_DEVICES.find((d) => d === v);
            if (next) setDevice(next);
          }}
        >
          {HEAT_DEVICES.map((d) => {
            const Icon = DEVICE_ICON[d];
            const views =
              model?.devices.find((x) => x.device === d)?.views ?? 0;
            return (
              <ToggleGroupItem
                key={d}
                value={d}
                title={t(k("deviceViews"), {
                  device: t(k(d)),
                  views: fmtInt(views, locale),
                })}
                className="flex-none gap-1.5 px-2.5 text-xs font-normal"
              >
                <Icon className="size-3.5" />
                <span className="max-sm:hidden">{t(k(d))}</span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label={t(k("range"))}
          value={range}
          onValueChange={(v) => {
            const next = HEAT_RANGES.find((r) => r === v);
            if (next) setRange(next);
          }}
        >
          {HEAT_RANGES.map((r) => (
            <ToggleGroupItem
              key={r}
              value={r}
              className="flex-none px-2.5 text-xs font-normal"
            >
              {t(k(`range${r}`))}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {query.isFetching && model && <Spinner size="xs" />}
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-[520px] w-full" />
        </div>
      ) : query.error ? (
        <p className="text-sm text-muted-foreground">
          {isNotConfigured(query.error)
            ? t("mainPanelTabs.analyticsTab.dataNotConfiguredDescription")
            : t("mainPanelTabs.analyticsTab.dataLoadError")}
        </p>
      ) : !model ? (
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.emptyView")}
        </p>
      ) : (
        <Viewer
          // A new page or device is a new document: remount the frame and its handshake.
          key={`${device}|${src ?? page}`}
          t={t}
          locale={locale}
          model={model}
          origin={origin}
          src={src}
          templatePage={template ? page : null}
          onSample={setSample}
          width={width}
          device={device}
          mode={mode}
          onMode={setMode}
          clickType={clickType}
          onClickType={setClickType}
          counts={counts}
        />
      )}
    </div>
  );
}

function PageInput({
  value,
  pages,
  label,
  onChange,
}: {
  value: string;
  pages: { page: string; views: number }[];
  label: string;
  onChange: (p: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = (draft ?? value).trim() || "/";
    setDraft(null);
    if (v.startsWith("/") && v.length <= 512 && v !== value) onChange(v);
  };
  return (
    <form
      className="min-w-0 max-sm:basis-full sm:w-64"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <Input
        aria-label={label}
        list="hm-pages"
        value={draft ?? value}
        spellCheck={false}
        className="h-8 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      <datalist id="hm-pages">
        {pages.map((p) => (
          <option key={p.page} value={p.page} />
        ))}
      </datalist>
    </form>
  );
}

function fmtInt(n: number, locale: string) {
  return Math.round(n).toLocaleString(locale);
}
/** Money is FOR a currency, so it is never printed without one: with no
 *  currency resolved the read surface has nothing to scope revenue to, and a
 *  bare number would invite adding figures that cannot be added. */
function fmtMoney(
  n: number,
  currency: string | null | undefined,
  locale: string,
) {
  return currency
    ? n.toLocaleString(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      })
    : fmtInt(n, locale);
}
function fmtPct(v: number | null, locale: string, digits = 0) {
  return v == null
    ? "—"
    : `${(v * 100).toLocaleString(locale, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })}%`;
}
function fmtSec(s: number | null, locale: string) {
  return s == null
    ? "—"
    : `${s.toLocaleString(locale, { maximumFractionDigits: s < 10 ? 1 : 0 })} s`;
}

/** One framed document (page × device) with its overlay, legend and lists. */
function Viewer({
  t,
  locale,
  model,
  origin,
  src,
  templatePage,
  onSample,
  width,
  device,
  mode,
  onMode,
  clickType,
  onClickType,
  counts,
}: {
  t: TFunction;
  locale: string;
  model: HeatmapModel;
  origin: string;
  src: string | null;
  templatePage: string | null;
  onSample: (path: string) => void;
  width: number;
  device: HeatDevice;
  mode: HeatMode;
  onMode: (m: HeatMode) => void;
  clickType: ClickType;
  onClickType: (c: ClickType) => void;
  counts: Record<ClickType, number>;
}) {
  const [ramp, setRamp] = useState<HeatRamp>("thermal");
  const [opacity, setOpacity] = useState(0.85);
  const [zoom, setZoom] = useState<"fit" | 1>("fit");
  const [status, setStatus] = useState<"loading" | "ready" | "timeout">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [rowHover, setRowHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [rankBy, setRankBy] = useState<"clicks" | "ctr">("clicks");
  const [avail, setAvail] = useState({ w: 1000, h: 640 });

  // The frame bridge lives as long as this document (the Viewer is keyed by
  // it): window listener + handshake retries, attached by the ref callback.
  const [{ frameRef, stageRef, post }] = useState(() => {
    let frame: HTMLIFrameElement | null = null;
    let timer = 0;
    const post = (m: Record<string, unknown>) =>
      frame?.contentWindow?.postMessage(
        { dq: "hm", v: VIEW_PROTOCOL, ...m },
        origin,
      );
    const onMessage = (e: MessageEvent) => {
      const m = readViewMessage(e, frame?.contentWindow, origin);
      if (!m) return;
      if (m.t === "ready") {
        window.clearInterval(timer);
        setStatus("ready");
      } else if (m.t === "placed") {
        setPlaced(m);
      } else if (m.t === "hover") {
        setHover(
          m.x == null
            ? null
            : {
                key: m.key,
                label: m.label ?? null,
                x: m.x,
                y: m.y ?? 0,
                pct: m.pct,
              },
        );
      } else {
        setPinned(m.key);
        setRailOpen(true);
        requestAnimationFrame(() =>
          document
            .querySelector(`[data-hm-key="${CSS.escape(m.key)}"]`)
            ?.scrollIntoView({ block: "nearest" }),
        );
      }
    };
    // React 19 ref callbacks: the returned function runs on detach.
    const frameRef = (el: HTMLIFrameElement) => {
      frame = el;
      window.addEventListener("message", onMessage);
      const started = Date.now();
      // Keeps asking past the timeout: a storefront may load its analytics
      // tag only after the first interaction or a cookie consent, both of
      // which the user can still give inside the frame.
      timer = window.setInterval(() => {
        if (Date.now() - started > HANDSHAKE_MS) {
          setStatus((s) => (s === "ready" ? s : "timeout"));
        }
        post({ t: "init" });
      }, 400);
      return () => {
        frame = null;
        window.clearInterval(timer);
        window.removeEventListener("message", onMessage);
      };
    };
    const stageRef = (el: HTMLDivElement) => {
      const ro = new ResizeObserver(([entry]) => {
        if (entry)
          setAvail({ w: entry.contentRect.width, h: entry.contentRect.height });
      });
      ro.observe(el);
      return () => ro.disconnect();
    };
    return { frameRef, stageRef, post };
  });

  const payload = viewData(model, {
    mode,
    type: clickType,
    ramp,
    opacity,
    device,
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs the cross-origin frame (an external system) with the heat payload; React Compiler keeps `payload` stable across hover renders
  useEffect(() => {
    if (status === "ready") post({ t: "data", d: payload });
  }, [status, payload, post]);

  const highlight = (key: string | null, scroll: boolean) =>
    post({ t: "highlight", key, scroll });
  const pick = (key: string) => {
    const next = pinned === key ? null : key;
    setPinned(next);
    highlight(next, next != null);
  };
  const enter = (key: string) => {
    setRowHover(key);
    highlight(key, false);
  };
  const leave = () => {
    setRowHover(null);
    highlight(pinned, false);
  };
  const changeMode = (m: HeatMode) => {
    onMode(m);
    setPinned(null);
    highlight(null, false);
  };

  const fit = Math.min(1, (avail.w - 2) / width);
  const scale = zoom === "fit" ? fit : 1;
  const frameH = Math.max(320, avail.h / scale);
  const left = Math.max(0, (avail.w - width * scale) / 2);
  const est = model.scale || 1;

  const itemBy = new Map((placed?.items ?? []).map((i) => [i.key, i]));
  const elBy = new Map(model.elements.map((e) => [e.key, e]));
  const totalW = counts[clickType] || 1;
  const ranked = model.elements
    .filter((e) => weightOf(e, clickType) > 0)
    .sort((a, b) => weightOf(b, clickType) - weightOf(a, clickType));
  // CTR ranks only elements whose section enough views SAW: below that one
  // curious visitor moves the rate by whole points, and the top of a ranking of
  // noise is the noisiest element, not the best creative.
  const byCtr = rankBy === "ctr" && clickType === "all";
  const ctrOf = new Map(
    model.elements.map((e) => [e.key, elementCtr(model, e)]),
  );
  const listed = byCtr
    ? ranked
        .filter((e) => (ctrOf.get(e.key)?.seen ?? 0) >= CTR_MIN_SEEN)
        .sort(
          (a, b) => (ctrOf.get(b.key)?.ctr ?? 0) - (ctrOf.get(a.key)?.ctr ?? 0),
        )
    : ranked;
  const topCtr = byCtr ? (ctrOf.get(listed[0]?.key ?? "")?.ctr ?? 0) : 0;
  const onPage = listed.filter((e) => itemBy.get(e.key)?.found !== "none");
  const offPage = ranked.filter((e) => itemBy.get(e.key)?.found === "none");
  const match = placed?.stats.total
    ? placed.stats.matched / placed.stats.total
    : null;
  const activeKey = rowHover ?? pinned;
  // An element without text is named by the section it sits in; the
  // section then leaves its line under the name.
  const textOf = (e: HeatElement) => itemBy.get(e.key)?.label || null;
  const labelOf = (e: HeatElement) =>
    textOf(e) || rootName(e.root) || t(k("noText"));
  const sectionBy = new Map(model.sections.map((s) => [s.root, s]));
  // The funnel follows the pinned element; with nothing pinned the value list
  // shows the page's own, which is what every element is read against.
  const pinnedFunnel = pinned ? model.funnel.get(pinned) : undefined;
  const pinnedEl = pinned ? elBy.get(pinned) : undefined;
  // Ranked by what they brought in, which is the question this mode asks.
  // Deliberately NOT filtered to what the live page still has: an element that
  // sold and has since been removed is the most interesting row on the list.
  const valueRanked = [...model.value.values()]
    .filter((v) => v.revenue > 0 || v.clickVisitors > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 60);
  const hoveredEl = hover?.key ? elBy.get(hover.key) : undefined;
  const hoveredBlock = hover?.key?.startsWith("blk:")
    ? placed?.blocks.find((b) => `blk:${b.key}` === hover.key)
    : undefined;
  const legend =
    mode === "clicks"
      ? [
          t(k("legendFewer")),
          placed?.legend[2]
            ? t(k("legendClicks"), {
                n: fmtInt(placed.legend[2] * est, locale),
              })
            : t(k("legendMore")),
        ]
      : mode === "scroll"
        ? [t(k("legendNobody")), t(k("legendEveryone"))]
        : mode === "attention"
          ? [t(k("legendLittle")), t(k("legendMoreTime"))]
          : [t(k("legendFewer")), t(k("legendMore"))];
  const gradient = `linear-gradient(90deg, ${Array.from(
    { length: 11 },
    (_, i) =>
      rampCss(
        ramp,
        i / 10,
        mode === "clicks" ? undefined : 0.35 + 0.65 * (i / 10),
      ),
  ).join(",")})`;
  const blocks = [...(placed?.blocks ?? [])].sort((a, b) =>
    mode === "sections"
      ? b.clicks - a.clicks
      : (b.seconds ?? 0) - (a.seconds ?? 0),
  );
  const blockMax = Math.max(
    1e-9,
    ...blocks.map((b) => (mode === "sections" ? b.clicks : (b.seconds ?? 0))),
  );

  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Tabs
          value={mode}
          onValueChange={(v) => {
            const next = HEAT_MODES.find((m) => m === v);
            if (next) changeMode(next);
          }}
          variant="underline"
        >
          <TabsList
            variant="underline"
            aria-label={t(k("map"))}
            className="overflow-x-auto"
          >
            {HEAT_MODES.map((m) => (
              <TabsTrigger
                key={m}
                value={m}
                variant="underline"
                title={t(k(`${m}Hint`))}
              >
                {t(k(m))}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {mode === "clicks" && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label={t(k("clickType"))}
            value={clickType}
            onValueChange={(v) => {
              const next = CLICK_TYPES.find((c) => c === v);
              if (!next) return;
              onClickType(next);
              setPinned(null);
            }}
            className="overflow-x-auto"
          >
            {CLICK_TYPES.map((c) => (
              <ToggleGroupItem
                key={c}
                value={c}
                disabled={c !== "all" && !counts[c]}
                className="flex-none gap-1.5 px-2.5 text-xs font-normal"
              >
                {t(k(`type_${c}`))}
                {c !== "all" && (
                  <span className="tnum text-muted-foreground">
                    {fmtInt(counts[c] * est, locale)}
                  </span>
                )}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <div className="text-meta ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 max-sm:ml-0">
          <span title={t(k("viewsHint"))}>
            {t(k("views"), { n: fmtInt(model.views, locale) })}
          </span>
          {est > 1.05 && (
            <span title={t(k("scaleHint"))}>
              {t(k("scale"), { n: fmtInt(est, locale) })}
            </span>
          )}
          {match != null && (
            <span
              title={t(k("matchHint"))}
              className="inline-flex items-center gap-1.5"
            >
              <i
                className={cn(
                  "size-1.5 rounded-full",
                  match < 0.8 ? "bg-warning" : "bg-success",
                )}
              />
              {t(k("match"), { pct: fmtPct(match, locale) })}
            </span>
          )}
          {model.smallSample && model.views > 0 && (
            <DsBadge variant="warning" title={t(k("smallSampleHint"))}>
              {t(k("smallSample"))}
            </DsBadge>
          )}
        </div>
      </div>

      <div className="surface grid grid-cols-1 overflow-hidden @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="surface-inset relative flex h-[clamp(520px,78vh,980px)] min-w-0 flex-col rounded-none px-5 pt-4 max-sm:h-[72vh] max-sm:min-h-[460px] max-sm:px-2 max-sm:pt-2">
          <div
            className="relative mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-t-xl border border-b-0 border-border bg-background"
            style={{ maxWidth: device === "desktop" ? undefined : width + 2 }}
          >
            <div className="text-meta flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1">
                <Lock01 className="size-3 shrink-0" />
                <span className="truncate">
                  {src
                    ? src
                        .replace(/^https?:\/\//, "")
                        .replace(/[?&]dq_view=1/, "")
                    : templatePage}
                </span>
              </div>
              <span className="max-sm:hidden">{width} px</span>
              <div className="inline-flex gap-0.5 max-sm:hidden">
                {(["fit", 1] as const).map((z) => (
                  <button
                    key={z}
                    type="button"
                    aria-pressed={zoom === z}
                    onClick={() => setZoom(z)}
                    className={cn(
                      "focus-ring rounded-md px-1.5 py-0.5",
                      zoom === z
                        ? "bg-muted text-foreground"
                        : "hover:text-foreground",
                    )}
                  >
                    {z === "fit" ? t(k("fit")) : "100%"}
                  </button>
                ))}
              </div>
            </div>
            <div
              ref={stageRef}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-hidden bg-background",
                zoom === "fit" ? "overflow-x-hidden" : "overflow-x-auto",
              )}
            >
              {zoom !== "fit" && <div style={{ width, height: 1 }} />}
              {src ? (
                <iframe
                  key={attempt}
                  ref={frameRef}
                  title={t(k("frameTitle"))}
                  src={src}
                  // oxlint-disable-next-line react/iframe-missing-sandbox -- the site is cross-origin to Studio and keeps its own origin: its runtime draws the overlay and answers from it; the sandbox still blocks top navigation, popups and forms
                  sandbox="allow-scripts allow-same-origin"
                  referrerPolicy="strict-origin-when-cross-origin"
                  className="absolute top-0 border-0 bg-background transition-opacity"
                  style={{
                    width,
                    height: frameH,
                    left,
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                    opacity: status === "ready" ? 1 : 0.35,
                  }}
                />
              ) : (
                <SamplePicker
                  t={t}
                  page={templatePage ?? ""}
                  onPick={onSample}
                />
              )}
              {src && status === "loading" && (
                <Cover>
                  <span className="flex items-center gap-2">
                    <Spinner size="xs" /> {t(k("frameLoading"))}
                  </span>
                </Cover>
              )}
              {src && status === "timeout" && (
                <Cover title={t(k("timeoutTitle"))}>
                  <span className="block">{t(k("timeoutHint"))}</span>
                  <span className="pointer-events-auto mt-3 flex items-center justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setStatus("loading");
                        setAttempt((n) => n + 1);
                      }}
                    >
                      {t(k("timeoutRetry"))}
                    </Button>
                  </span>
                  <details className="pointer-events-auto mt-3 text-left text-xs">
                    <summary className="cursor-pointer text-center">
                      {t(k("timeoutWhy"))}
                    </summary>
                    <p className="mt-2">{t(k("timeoutDescription"))}</p>
                  </details>
                </Cover>
              )}
              {src && status === "ready" && model.views === 0 && (
                <Cover title={t(k("noViewsTitle"))}>
                  {t(k("noViewsDescription"), {
                    device: t(k(device)).toLowerCase(),
                  })}
                </Cover>
              )}
              {hover && (hoveredEl || hoveredBlock || hover.pct != null) && (
                <div
                  className="pointer-events-none absolute z-10 min-w-48 max-w-72 rounded-lg bg-foreground px-3 py-2.5 text-xs leading-relaxed text-background shadow-lg"
                  style={{
                    left: Math.min(left + hover.x * scale + 14, avail.w - 200),
                    top: hover.y * scale + 14,
                  }}
                >
                  {hoveredEl && (
                    <>
                      <strong className="mb-1 block text-sm">
                        {hover.label || labelOf(hoveredEl)}
                      </strong>
                      <TipRow
                        label={t(k("tipClicks"))}
                        value={fmtInt(hoveredEl.clicks * est, locale)}
                      />
                      <TipRow
                        label={t(k("tipShare"))}
                        value={fmtPct(
                          hoveredEl.clicks / Math.max(1, counts.all),
                          locale,
                          1,
                        )}
                      />
                      <TipRow
                        label={t(k("tipVisits"))}
                        value={fmtPct(
                          hoveredEl.views / Math.max(1, model.views),
                          locale,
                          1,
                        )}
                      />
                      {hoveredEl.rage > 0 && (
                        <TipRow
                          label={t(k("type_rage"))}
                          value={fmtInt(hoveredEl.rage * est, locale)}
                        />
                      )}
                      {hoveredEl.dead > 0 && (
                        <TipRow
                          label={t(k("type_dead"))}
                          value={fmtInt(hoveredEl.dead * est, locale)}
                        />
                      )}
                      {hoveredEl.error > 0 && (
                        <TipRow
                          label={t(k("type_error"))}
                          value={fmtInt(hoveredEl.error * est, locale)}
                        />
                      )}
                    </>
                  )}
                  {hoveredBlock && (
                    <>
                      <strong className="mb-1 block text-sm">
                        {hoveredBlock.name}
                      </strong>
                      {hoveredBlock.heading && (
                        <div className="mb-1 opacity-80">
                          {hoveredBlock.heading}
                        </div>
                      )}
                      <TipRow
                        label={t(k("tipClicks"))}
                        value={fmtInt(hoveredBlock.clicks * est, locale)}
                      />
                      <TipRow
                        label={t(k("tipSaw"))}
                        value={fmtPct(hoveredBlock.reach, locale)}
                      />
                      <TipRow
                        label={t(k("tipTime"))}
                        value={fmtSec(hoveredBlock.seconds, locale)}
                      />
                    </>
                  )}
                  {hover.pct != null && mode === "scroll" && (
                    <>
                      <strong className="block text-sm">
                        {t(k("tipReach"), {
                          pct: fmtPct(
                            reachAt(model.scroll, Math.floor(hover.pct * 100)),
                            locale,
                          ),
                        })}
                      </strong>
                      {t(k("tipReachSub"))}
                    </>
                  )}
                  {hover.pct != null && mode === "attention" && (
                    <>
                      <strong className="block text-sm">
                        {t(k("tipAttention"), {
                          s: fmtSec(attentionAt(model, hover.pct), locale),
                        })}
                      </strong>
                      {t(k("tipAttentionSub"))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="surface absolute bottom-4 left-8 z-10 flex max-w-[calc(100%-4rem)] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 max-sm:inset-x-4 max-sm:max-w-none">
            <div className="flex min-w-44 flex-col gap-1 max-sm:min-w-0 max-sm:basis-full">
              <div
                className="h-2 rounded-full border border-border"
                style={{ backgroundImage: gradient }}
              />
              <div className="text-meta flex justify-between gap-3">
                <span>{legend[0]}</span>
                <span>{legend[1]}</span>
              </div>
            </div>
            {mode !== "sections" && (
              <label className="text-meta flex items-center gap-2">
                {t(k("opacity"))}
                <Slider
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={[opacity]}
                  onValueChange={([v]) => v !== undefined && setOpacity(v)}
                  className="w-20"
                />
              </label>
            )}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label={t(k("colors"))}
              value={ramp}
              onValueChange={(v) => {
                if (v === "thermal" || v === "inferno") setRamp(v);
              }}
            >
              {(["thermal", "inferno"] as const).map((r) => (
                <ToggleGroupItem
                  key={r}
                  value={r}
                  title={r === "inferno" ? t(k("infernoHint")) : undefined}
                  className="flex-none px-2.5 text-xs font-normal"
                >
                  {t(k(r))}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>

        <aside className="flex min-h-0 flex-col border-border @max-4xl:border-t @4xl:h-[clamp(520px,78vh,980px)] @4xl:border-l">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-border p-4">
            <Stat
              label={t(k("statClicks"))}
              value={fmtInt(model.clicks * est, locale)}
            />
            <Stat
              label={t(k("statDepth"))}
              value={fmtPct(
                model.avgDepth == null ? null : model.avgDepth / 100,
                locale,
              )}
              sub={
                model.avgFold != null
                  ? t(k("statFold"), {
                      pct: fmtPct(model.avgFold / 100, locale),
                    })
                  : null
              }
            />
            <Stat
              label={t(k("statActive"))}
              value={fmtSec(model.activeS, locale)}
            />
            <Stat
              label={t(k("statRageDead"))}
              value={`${fmtInt(model.rage * est, locale)} / ${fmtInt(model.dead * est, locale)}`}
              sub={
                model.error
                  ? t(k("statErrors"), { n: fmtInt(model.error * est, locale) })
                  : null
              }
            />
          </div>
          <button
            type="button"
            className="focus-ring border-b border-border px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-accent/50 @4xl:hidden"
            onClick={() => setRailOpen((o) => !o)}
          >
            {railOpen
              ? t(k("hideList"))
              : t(
                  k(
                    mode === "sections" || mode === "attention"
                      ? "showSections"
                      : mode === "scroll"
                        ? "showReach"
                        : "showElements",
                  ),
                )}
          </button>
          <div
            className={cn(
              "min-h-0 flex-1 flex-col @max-4xl:max-h-[60vh]",
              railOpen ? "flex" : "hidden @4xl:flex",
            )}
          >
            {mode === "clicks" && (
              <>
                <ListHead
                  title={
                    clickType !== "all"
                      ? t(k("topOfType"), {
                          type: t(k(`type_${clickType}`)).toLowerCase(),
                        })
                      : byCtr
                        ? t(k("topCtr"))
                        : t(k("topElements"))
                  }
                  aside={t(k("nElements"), {
                    n: fmtInt(listed.length, locale),
                  })}
                />
                {clickType === "all" && (
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    aria-label={t(k("rankBy"))}
                    value={rankBy}
                    onValueChange={(v) => {
                      if (v === "clicks" || v === "ctr") setRankBy(v);
                    }}
                    className="mx-4 mb-1 w-fit"
                  >
                    {(["clicks", "ctr"] as const).map((r) => (
                      <ToggleGroupItem
                        key={r}
                        value={r}
                        title={r === "ctr" ? t(k("ctrHint")) : undefined}
                        className="flex-none px-2.5 text-xs font-normal"
                      >
                        {t(k(r === "ctr" ? "rankCtr" : "rankClicks"))}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                )}
                {pinnedFunnel && pinnedEl && (
                  <FunnelCard
                    t={t}
                    locale={locale}
                    title={labelOf(pinnedEl)}
                    f={pinnedFunnel}
                    page={model.pageFunnel}
                  />
                )}
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                  {byCtr && (
                    <p className="px-2 pb-1 text-meta">
                      {t(k("ctrMinNote"), {
                        n: fmtInt(CTR_MIN_SEEN, locale),
                      })}
                    </p>
                  )}
                  {onPage.slice(0, 60).map((e, i) => {
                    const w = weightOf(e, clickType);
                    const share = w / totalW;
                    const c = ctrOf.get(e.key);
                    const meter = byCtr ? (c?.ctr ?? 0) / (topCtr || 1) : share;
                    return (
                      <Row
                        key={e.key}
                        id={e.key}
                        rank={i + 1}
                        label={labelOf(e)}
                        value={
                          byCtr
                            ? fmtPct(c?.ctr ?? 0, locale, 1)
                            : fmtInt(w * est, locale)
                        }
                        meter={Math.max(0.02, meter)}
                        color={rampCss(
                          ramp,
                          0.25 + 0.75 * Math.min(1, byCtr ? meter : share * 4),
                          1,
                        )}
                        active={activeKey === e.key}
                        onEnter={() => enter(e.key)}
                        onLeave={leave}
                        onPick={() => pick(e.key)}
                        sub={[
                          textOf(e) ? rootName(e.root) : null,
                          // CTR before the click share: it is the figure the
                          // row cannot show on its right, and the first to be
                          // cut when the line truncates.
                          byCtr
                            ? t(k("ctrSeen"), {
                                n: fmtInt((c?.seen ?? 0) * est, locale),
                              })
                            : c && c.seen
                              ? t(k("ctrSub"), {
                                  pct: fmtPct(c.ctr, locale, 1),
                                })
                              : "",
                          byCtr
                            ? ""
                            : t(k("ofClicks"), {
                                pct: fmtPct(share, locale, 1),
                              }),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      >
                        {itemBy.get(e.key)?.found === "sec" && (
                          <Badge title={t(k("inSectionHint"))}>
                            {t(k("inSection"))}
                          </Badge>
                        )}
                        {e.rage > 0 && (
                          <Badge tone="destructive">
                            {t(k("badgeRage"), {
                              n: fmtInt(e.rage * est, locale),
                            })}
                          </Badge>
                        )}
                        {e.dead > 0 && (
                          <Badge tone="warning">
                            {t(k("badgeDead"), {
                              n: fmtInt(e.dead * est, locale),
                            })}
                          </Badge>
                        )}
                        {e.error > 0 && (
                          <Badge tone="warning">
                            {t(k("badgeError"), {
                              n: fmtInt(e.error * est, locale),
                            })}
                          </Badge>
                        )}
                      </Row>
                    );
                  })}
                  {!onPage.length && placed && (
                    <p className="px-2 py-3 text-meta">{t(k("noneOfType"))}</p>
                  )}
                  {offPage.length > 0 && (
                    <details className="mx-2 mt-2 border-t border-dashed border-border pt-2">
                      <summary className="cursor-pointer py-1 text-meta">
                        {t(k("offPage"), {
                          n: fmtInt(offPage.length, locale),
                          pct: fmtPct(
                            offPage.reduce(
                              (s, e) => s + weightOf(e, clickType),
                              0,
                            ) / totalW,
                            locale,
                          ),
                        })}
                      </summary>
                      {offPage.slice(0, 40).map((e) => (
                        <div
                          key={e.key}
                          className="flex justify-between gap-2 px-2 py-1.5 text-xs"
                        >
                          <span className="truncate">
                            {rootName(e.root) ?? t(k("outsideSections"))}
                          </span>
                          <span className="tnum text-foreground">
                            {fmtInt(weightOf(e, clickType) * est, locale)}
                          </span>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              </>
            )}
            {mode === "value" && (
              <>
                <ListHead
                  title={t(k("valueTitle"))}
                  aside={model.valueModel?.currency ?? ""}
                />
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                  {model.valueModel && !model.valueModel.supported ? (
                    <p className="px-2 py-3 text-meta">
                      {t(k("valueOtherGoal"))}
                    </p>
                  ) : !model.valueSummary ? (
                    <p className="px-2 py-3 text-meta">{t(k("valueNone"))}</p>
                  ) : (
                    <>
                      {(pinnedFunnel && pinnedEl) || model.pageFunnel ? (
                        <FunnelCard
                          t={t}
                          locale={locale}
                          title={
                            pinnedFunnel && pinnedEl
                              ? labelOf(pinnedEl)
                              : t(k("funnelPage"))
                          }
                          f={
                            (pinnedFunnel && pinnedEl
                              ? pinnedFunnel
                              : model.pageFunnel)!
                          }
                          page={
                            pinnedFunnel && pinnedEl ? model.pageFunnel : null
                          }
                        />
                      ) : null}
                      <p className="px-2 pb-2 text-meta">
                        {t(k("valueBaseline"), {
                          cvr: fmtPct(
                            model.valueSummary.cvrPct / 100,
                            locale,
                            1,
                          ),
                          people: fmtInt(model.valueSummary.visitors, locale),
                        })}
                      </p>
                      {valueRanked.map((v, i) => {
                        const el = elBy.get(v.key);
                        const top = valueRanked[0]?.revenue || 1;
                        return (
                          <Row
                            key={v.key}
                            id={v.key}
                            rank={i + 1}
                            label={el ? labelOf(el) : t(k("noText"))}
                            value={fmtMoney(
                              v.revenue,
                              model.valueModel?.currency,
                              locale,
                            )}
                            meter={Math.max(0.02, v.revenue / top)}
                            color={rampCss(
                              ramp,
                              0.25 + 0.75 * (v.revenue / top),
                              1,
                            )}
                            active={activeKey === v.key}
                            onEnter={() => enter(v.key)}
                            onLeave={leave}
                            onPick={() => pick(v.key)}
                            sub={t(k("valueRowSub"), {
                              conv: fmtInt(v.convVisitors, locale),
                              people: fmtInt(v.clickVisitors, locale),
                              cvr: fmtPct(v.cvrPct / 100, locale, 1),
                            })}
                          >
                            {/* The index, not the rate, is what a reader can
                                act on: 1.0 is "exactly like its page". */}
                            {!v.smallSample && v.rpvIndex > 0 && (
                              <Badge
                                tone={v.rpvIndex >= 1 ? "success" : "warning"}
                                title={t(k("valueIndexHint"))}
                              >
                                {t(k("valueIndex"), {
                                  x: v.rpvIndex.toLocaleString(locale, {
                                    maximumFractionDigits: 2,
                                  }),
                                })}
                              </Badge>
                            )}
                            {v.smallSample && (
                              <Badge title={t(k("valueSmallHint"))}>
                                {t(k("valueSmall"))}
                              </Badge>
                            )}
                          </Row>
                        );
                      })}
                      {model.valueLeaks.length > 0 && (
                        <>
                          <ListHead
                            title={t(k("valueLeaksTitle"))}
                            aside={t(k("valueLeaksAside"))}
                          />
                          {model.valueLeaks.map((v, i) => {
                            const el = elBy.get(v.key);
                            return (
                              <Row
                                key={`leak:${v.key}`}
                                id={v.key}
                                rank={i + 1}
                                label={el ? labelOf(el) : t(k("noText"))}
                                value={fmtInt(v.clickVisitors, locale)}
                                meter={0.02}
                                color="var(--chart-1)"
                                active={activeKey === v.key}
                                onEnter={() => enter(v.key)}
                                onLeave={leave}
                                onPick={() => pick(v.key)}
                                sub={t(k("valueLeakSub"), {
                                  people: fmtInt(v.clickVisitors, locale),
                                  conv: fmtInt(v.convVisitors, locale),
                                })}
                              />
                            );
                          })}
                        </>
                      )}
                      {/* NOT optional. These numbers are associative, sampled
                          and not summable; a reader who is not told will add
                          them up and call the result a total. */}
                      <p className="px-2 pt-3 text-meta">
                        {t(k("valueCaveat"), {
                          minutes: model.valueModel?.windowMinutes ?? 30,
                        })}
                      </p>
                    </>
                  )}
                </div>
              </>
            )}
            {mode === "scroll" && (
              <>
                <ListHead
                  title={t(k("reachTitle"))}
                  aside={t(k("reachAside"))}
                />
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
                  <table className="tnum w-full text-sm">
                    <tbody>
                      {[10, 25, 50, 75, 90, 100].map((d) => {
                        const r = reachAt(model.scroll, d);
                        return (
                          <tr key={d} className="border-b border-border">
                            <td className="py-2">
                              <i
                                className="mr-2 inline-block size-2.5 rounded-sm align-[-1px]"
                                style={{ background: rampCss(ramp, r, 0.9) }}
                              />
                              {t(k("reachRow"), { d: String(d) })}
                            </td>
                            <td className="py-2 text-right text-foreground">
                              {fmtPct(r, locale)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="mt-3 text-meta">{t(k("foldNote"))}</p>
                </div>
              </>
            )}
            {(mode === "sections" || mode === "attention") && (
              <>
                <ListHead
                  title={t(
                    k(
                      mode === "sections"
                        ? "sectionsByClicks"
                        : "sectionsByTime",
                    ),
                  )}
                  aside={t(k("nSections"), {
                    n: fmtInt(blocks.length, locale),
                  })}
                />
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                  {blocks.map((b, i) => {
                    const key = `blk:${b.key}`;
                    const v = mode === "sections" ? b.clicks : (b.seconds ?? 0);
                    return (
                      <Row
                        key={key}
                        id={key}
                        rank={i + 1}
                        label={b.name}
                        value={
                          mode === "sections"
                            ? fmtInt(b.clicks * est, locale)
                            : fmtSec(b.seconds, locale)
                        }
                        meter={v / blockMax}
                        color={rampCss(ramp, 0.2 + 0.8 * (v / blockMax), 1)}
                        active={activeKey === key}
                        onEnter={() => enter(key)}
                        onLeave={leave}
                        onPick={() => pick(key)}
                        sub={[
                          b.heading,
                          b.reach != null
                            ? t(k("saw"), { pct: fmtPct(b.reach, locale) })
                            : "",
                          sectionBy.get(b.key)?.seenViews
                            ? t(k("ctrSub"), {
                                pct: fmtPct(
                                  (sectionBy.get(b.key)?.ctrPct ?? 0) / 100,
                                  locale,
                                  1,
                                ),
                              })
                            : "",
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Mean seconds per view in the attention band at `pct` of the page. */
function attentionAt(model: HeatmapModel, pct: number): number | null {
  if (!model.views) return null;
  const band = Math.min(39, Math.floor(pct * 40));
  return (
    (model.attention.find((a) => a.band === band)?.ds ?? 0) / 10 / model.views
  );
}

/** The DS badge at count size, in the tones a row's flags use. */
function Badge({
  title,
  tone,
  children,
}: {
  title?: string;
  tone?: "destructive" | "warning" | "success";
  children: ReactNode;
}) {
  return (
    <DsBadge variant={tone ?? "muted"} size="sm" title={title}>
      {children}
    </DsBadge>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-meta">{label}</span>
      <span className="font-display tnum text-2xl text-foreground">
        {value}
      </span>
      {sub && <span className="text-meta">{sub}</span>}
    </div>
  );
}

/** Where the people who clicked went next: each step as a share of them, with
 *  the page's own share beside it when there is one to compare against. */
function FunnelCard({
  t,
  locale,
  title,
  f,
  page,
}: {
  t: TFunction;
  locale: string;
  title: string;
  f: HeatFunnel;
  page: HeatFunnel | null;
}) {
  const of = (n: number, d: number) => (d ? n / d : 0);
  return (
    <div className="surface-inset mx-3 mb-2 rounded-xl p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {t(k("funnelTitle"))}
        </span>
        <span className="truncate text-meta" title={title}>
          {title}
        </span>
      </div>
      <p className="mt-0.5 text-meta">
        {t(k("funnelPeople"), { n: fmtInt(f.visitors, locale) })}
        {f.visitors < 30 ? ` · ${t(k("valueSmall"))}` : ""}
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        {FUNNEL_STEPS.map((step) => {
          const share = of(f[step], f.visitors);
          const base = page ? of(page[step], page.visitors) : null;
          return (
            <div
              key={step}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 text-xs"
            >
              <span className="truncate">{t(k(`funnel_${step}`))}</span>
              <span className="tnum text-foreground">
                {fmtPct(share, locale, 1)}
                {base != null && (
                  <span
                    className={cn(
                      "ml-1.5 font-normal",
                      share >= base ? "text-success" : "text-warning",
                    )}
                  >
                    {t(k("funnelVsPage"), { pct: fmtPct(base, locale, 1) })}
                  </span>
                )}
              </span>
              <span className="col-span-2 h-1 overflow-hidden rounded-full bg-muted">
                <i
                  className="block h-full rounded-full bg-[var(--chart-1)]"
                  style={{ width: `${Math.min(100, share * 100)}%` }}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListHead({ title, aside }: { title: string; aside: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-4 pt-4 pb-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <span className="text-meta">{aside}</span>
    </div>
  );
}

function Row(p: {
  id: string;
  rank: number;
  label: string;
  value: string;
  meter: number;
  color: string;
  sub: string;
  active: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onPick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-hm-key={p.id}
      aria-current={p.active}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
      onFocus={p.onEnter}
      onBlur={p.onLeave}
      onClick={p.onPick}
      className={cn(
        "focus-ring grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent/50",
        p.active && "bg-accent/50",
      )}
    >
      <span className="text-meta text-right">{p.rank}</span>
      <span className="truncate text-foreground" title={p.label}>
        {p.label}
      </span>
      <span className="tnum text-right text-foreground">{p.value}</span>
      <span className="col-start-2 col-end-4 h-1 overflow-hidden rounded-full bg-muted">
        <i
          className="block h-full rounded-full"
          style={{
            width: `${Math.min(100, p.meter * 100)}%`,
            background: p.color,
          }}
        />
      </span>
      <span className="text-meta col-start-2 col-end-4 flex min-w-0 items-center gap-1.5">
        <span className="truncate">{p.sub}</span>
        {p.children}
      </span>
    </button>
  );
}

function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3.5 tabular-nums opacity-90">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Cover({ title, children }: { title?: string; children: ReactNode }) {
  // Pointer events pass through to the frame, so the page can still be
  // hovered or have its cookie banner accepted while this is shown.
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-6 text-center">
      <div className="surface max-w-sm px-5 py-4 text-sm text-muted-foreground">
        {title && <h3 className="mb-1 font-medium text-foreground">{title}</h3>}
        {children}
      </div>
    </div>
  );
}

function SamplePicker({
  t,
  page,
  onPick,
}: {
  t: TFunction;
  page: string;
  onPick: (p: string) => void;
}) {
  const [v, setV] = useState("");
  return (
    <Cover title={t(k("sampleTitle"))}>
      {t(k("sampleDescription"), { page })}
      <form
        className="mt-2.5 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim().startsWith("/") && !v.includes(":")) onPick(v.trim());
        }}
      >
        <Input
          value={v}
          placeholder={t(k("samplePlaceholder"))}
          onChange={(e) => setV(e.target.value)}
          className="h-8 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm">
          {t(k("sampleShow"))}
        </Button>
      </form>
    </Cover>
  );
}
