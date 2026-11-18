/**
 * The full analysis as a radial map of the store: drag to pan, pinch or
 * Ctrl + scroll to zoom, click a topic to move into it.
 */

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  ChevronRight,
  Expand06,
  Minus,
  Plus,
  RefreshCw01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  MOCK_SITE_MAP,
  type CheckStatus,
  type MapNode,
} from "./site-map-mock.ts";
import {
  STATUS_BADGE,
  STATUS_DOT,
  STATUS_LABEL,
  STATUS_RING,
  STATUSES,
  StatusDot,
} from "./status.tsx";
import { FunnelView } from "./funnel-view.tsx";
import { StageCard } from "./stage-card.tsx";

/** Distance from the center, per depth, in world pixels. */
const RADIUS = [0, 400, 680, 900];
const BRANCH_SIZE = [240, 136, 124];
const LEAF_SIZE = 30;
/** Room under a leaf for its label. */
const LEAF_LABEL = 44;
/** The first area sits up and to the left, as in a hand-drawn map. */
const FIRST_ANGLE = -110;
const PANEL_WIDTH = 320;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

interface Placed {
  node: MapNode;
  depth: number;
  x: number;
  y: number;
  size: number;
  parent: Placed | null;
}

interface Camera {
  x: number;
  y: number;
  k: number;
}

type Counts = Record<CheckStatus, number>;

function weight(node: MapNode): number {
  if (node.soon || node.opportunities) return 3;
  if (!node.children?.length) return 1;
  return node.children.reduce((sum, child) => sum + weight(child), 0);
}

/** Type sizes per depth, matching the classes in `MapNodeView`. */
const BRANCH_TYPE = [
  { label: 30, value: 48, caption: 12, captionWidth: 150 },
  { label: 24, value: 18, caption: 12, captionWidth: 150 },
  { label: 13, value: 14, caption: 10, captionWidth: 96 },
];
/** Ring plus inner padding, on each side. */
const BRANCH_INSET = 18;

function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.56;
}

/** A circle wide enough to hold its label and result: the content box's diagonal. */
function branchSize(node: MapNode, depth: number): number {
  const base = BRANCH_SIZE[depth] ?? LEAF_SIZE;
  const type = BRANCH_TYPE[depth];
  if (!type || node.soon || depth === 0) return base;
  let width = textWidth(node.label, type.label);
  let height = type.label * 1.25;
  if (node.metric) {
    const caption = textWidth(node.metric.label, type.caption);
    const lines = Math.ceil(caption / type.captionWidth);
    width = Math.max(
      width,
      textWidth(node.metric.value, type.value),
      Math.min(caption, type.captionWidth),
    );
    height += 4 + type.value * 1.25 + lines * type.caption * 1.25;
  } else {
    height += 4 + type.value * 1.25;
  }
  return Math.max(
    base,
    Math.ceil(Math.hypot(width, height) + BRANCH_INSET * 2),
  );
}

function layout(root: MapNode): Placed[] {
  const placed: Placed[] = [];
  const visit = (
    node: MapNode,
    depth: number,
    from: number,
    to: number,
    parent: Placed | null,
  ) => {
    const angle = ((from + to) / 2) * (Math.PI / 180);
    const radius = RADIUS[depth] ?? 0;
    const isLeaf = node.status !== undefined;
    const item: Placed = {
      node,
      depth,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: isLeaf ? LEAF_SIZE : branchSize(node, depth),
      parent,
    };
    placed.push(item);
    const children = node.children ?? [];
    const total = children.reduce((sum, child) => sum + weight(child), 0);
    let start = from;
    for (const child of children) {
      const span = ((to - from) * weight(child)) / total;
      visit(child, depth + 1, start, start + span, item);
      start += span;
    }
  };
  const first = root.children?.[0];
  const firstSpan = first ? (360 * weight(first)) / weight(root) : 0;
  const from = FIRST_ANGLE - firstSpan / 2;
  visit(root, 0, from, from + 360, null);
  return placed;
}

const PLACED = layout(MOCK_SITE_MAP);
const BY_ID = new Map(PLACED.map((item) => [item.node.id, item]));

function countLeaves(node: MapNode): Counts {
  const counts: Counts = { missing: 0, partial: 0, done: 0 };
  const visit = (current: MapNode) => {
    if (current.status) counts[current.status] += 1;
    for (const child of current.children ?? []) visit(child);
    for (const opportunity of current.opportunities ?? []) visit(opportunity);
  };
  visit(node);
  return counts;
}

/** Done counts fully, partial counts half. */
function score(counts: Counts): number | null {
  const total = counts.missing + counts.partial + counts.done;
  if (total === 0) return null;
  return Math.round(((counts.done + counts.partial / 2) / total) * 100);
}

/** The status mix as a ring: green, then yellow, then red. */
function ringGradient(counts: Counts): string {
  const total = counts.missing + counts.partial + counts.done;
  if (total === 0) return "var(--border)";
  const done = (counts.done / total) * 100;
  const partial = done + (counts.partial / total) * 100;
  return `conic-gradient(var(--success) 0 ${done}%, var(--warning) ${done}% ${partial}%, var(--destructive) ${partial}% 100%)`;
}

function isDescendant(item: Placed, ancestor: Placed): boolean {
  for (let current: Placed | null = item; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function pathTo(item: Placed): Placed[] {
  const path: Placed[] = [];
  for (let current: Placed | null = item; current; current = current.parent) {
    path.unshift(current);
  }
  return path;
}

const TECHNICAL = BY_ID.get("technical");
const FUNNEL = BY_ID.get("cro");

/** Only the technical checklist gets a grade; the other areas are read by their results. */
function isGraded(item: Placed): boolean {
  return TECHNICAL ? isDescendant(item, TECHNICAL) : false;
}

function isLeaf(item: Placed): boolean {
  return item.node.status !== undefined;
}

/** Fit a topic and everything under it; a single check is shown with its siblings. */
/** A check shows once its topic is open, so the overview stays at the topics. */
function isShown(item: Placed, focus: Placed): boolean {
  if (!isLeaf(item)) return true;
  return (
    item.parent === focus || (isLeaf(focus) && item.parent === focus.parent)
  );
}

function fitCamera(
  focus: Placed,
  width: number,
  height: number,
  panelOpen: boolean,
): Camera {
  const target = isLeaf(focus) && focus.parent ? focus.parent : focus;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const item of PLACED) {
    if (!isDescendant(item, target) || !isShown(item, focus)) continue;
    const half = item.size / 2;
    const below = isLeaf(item) ? LEAF_LABEL : 0;
    minX = Math.min(minX, item.x - half - 40);
    maxX = Math.max(maxX, item.x + half + 40);
    minY = Math.min(minY, item.y - half);
    maxY = Math.max(maxY, item.y + half + below);
  }
  const usable = panelOpen ? Math.max(width - PANEL_WIDTH, width / 2) : width;
  const k = clamp(
    Math.min(usable / (maxX - minX), height / (maxY - minY)) * 0.88,
  );
  return {
    k,
    x: usable / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}

function clamp(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

function zoomAround(camera: Camera, factor: number, px: number, py: number) {
  const k = clamp(camera.k * factor);
  const ratio = k / camera.k;
  return {
    k,
    x: px - (px - camera.x) * ratio,
    y: py - (py - camera.y) * ratio,
  };
}

/** A mouse click must not focus the topic: focusing scrolls it into view and shifts the canvas. */
function keepCanvasStill(event: { preventDefault: () => void }) {
  event.preventDefault();
}

function MapNodeView({
  item,
  store,
  zoom,
  shown,
  focused,
  onSelect,
}: {
  item: Placed;
  store: MapStore;
  zoom: number;
  /** False hides a check until its topic is open. */
  shown: boolean;
  focused: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  // A logo that does not load gives way to the name.
  const [logoFailed, setLogoFailed] = useState(false);
  const { node, size, depth } = item;
  const position = {
    left: item.x - size / 2,
    top: item.y - size / 2,
    width: size,
    height: size,
  };

  if (isLeaf(item) && node.status) {
    return (
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        onMouseDown={keepCanvasStill}
        style={position}
        tabIndex={shown ? undefined : -1}
        aria-hidden={shown ? undefined : true}
        className={cn(
          "group absolute flex flex-col items-center outline-none transition-opacity duration-300",
          !shown && "pointer-events-none opacity-0",
        )}
      >
        <span
          className={cn(
            "size-full rounded-full ring-[6px] transition-transform group-hover:scale-110",
            STATUS_DOT[node.status],
            STATUS_RING[node.status],
            focused && "outline-3 outline-offset-6 outline-foreground",
          )}
        />
        <span
          className={cn(
            "absolute top-full mt-3 w-24 text-center text-[13px] leading-tight text-foreground transition-opacity",
            zoom < 0.5 && "opacity-0",
          )}
        >
          {node.label}
        </span>
      </button>
    );
  }

  if (node.soon) {
    return (
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        onMouseDown={keepCanvasStill}
        style={position}
        className={cn(
          "absolute flex flex-col items-center justify-center gap-2 rounded-full border-2 border-dashed border-border bg-muted/60 p-4 text-center outline-none transition-colors hover:bg-muted",
          focused && "outline-3 outline-offset-6 outline-foreground",
        )}
      >
        <span className="text-xl leading-tight font-medium text-muted-foreground">
          {node.label}
        </span>
        <span className="rounded-full bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-edge">
          {t("plan.map.soon")}
        </span>
      </button>
    );
  }

  const counts = countLeaves(node);
  const graded = isGraded(item);
  const value = graded ? score(counts) : null;
  const metric = graded ? undefined : node.metric;
  const logo = depth === 0 && !logoFailed ? store.logo : null;
  return (
    <button
      type="button"
      aria-label={logo ? labelOf(node, store) : undefined}
      onClick={() => onSelect(node.id)}
      onMouseDown={keepCanvasStill}
      style={{
        ...position,
        background: graded ? ringGradient(counts) : "var(--border)",
      }}
      className={cn(
        "absolute rounded-full shadow-edge outline-none transition-transform hover:scale-[1.03]",
        depth === 0 ? "p-2" : "p-1.5",
        focused && "outline-3 outline-offset-6 outline-foreground",
      )}
    >
      <span className="flex size-full flex-col items-center justify-center gap-1 rounded-full bg-card p-3 text-center">
        {logo ? (
          <img
            src={logo}
            alt=""
            draggable={false}
            onError={() => setLogoFailed(true)}
            className="max-h-20 max-w-[62%] object-contain"
          />
        ) : (
          <span
            className={cn(
              "leading-tight font-medium text-foreground",
              depth === 0 && "text-3xl",
              depth === 1 && "text-2xl",
              depth === 2 && "text-[13px]",
              depth === 2 && zoom < 0.42 && "opacity-0",
            )}
          >
            {labelOf(node, store)}
          </span>
        )}
        {value !== null && (
          <span
            className={cn(
              "font-medium tabular-nums text-muted-foreground",
              depth === 0 ? "text-5xl text-foreground" : "text-lg",
              depth === 2 && "text-xs",
              depth === 2 && zoom < 0.42 && "opacity-0",
            )}
          >
            {value}%
          </span>
        )}
        {metric && (
          <span
            className={cn(
              "flex flex-col items-center leading-tight transition-opacity",
              depth === 2 && zoom < 0.42 && "opacity-0",
            )}
          >
            <span
              className={cn(
                "font-medium tabular-nums text-foreground",
                depth === 1 ? "text-lg" : "text-sm",
              )}
            >
              {metric.value}
            </span>
            <span
              className={cn(
                "text-balance text-muted-foreground",
                depth === 1 ? "text-xs" : "text-[10px]",
              )}
              style={{ maxWidth: BRANCH_TYPE[depth]?.captionWidth }}
            >
              {metric.label}
            </span>
          </span>
        )}
      </span>
    </button>
  );
}

function DetailPanel({
  item,
  store,
  onSelect,
}: {
  item: Placed;
  store: MapStore;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const { node } = item;
  const [{ language }] = usePreferences();
  const counts = countLeaves(node);
  const value = isGraded(item) ? score(counts) : null;
  const metric = isGraded(item) ? undefined : node.metric;
  const children = item.node.children ?? [];
  const summaryOf = (child: MapNode): string | null => {
    const placed = BY_ID.get(child.id);
    if (child.soon) return t("plan.map.soon");
    if (placed && isGraded(placed) && !child.status) {
      return `${score(countLeaves(child)) ?? 0}%`;
    }
    return null;
  };
  /** A number always travels with what it counts and over which period. */
  const resultOf = (child: MapNode): string | null => {
    if (child.metric) return `${child.metric.value} ${child.metric.label}`;
    if (child.sessions !== undefined) {
      return t("plan.funnel.sessionsPeriod", {
        count: new Intl.NumberFormat(language).format(child.sessions),
      });
    }
    return null;
  };
  return (
    <aside
      className="absolute top-3 right-3 bottom-3 z-10 flex flex-col gap-4 overflow-y-auto surface p-4"
      style={{ width: PANEL_WIDTH - 24 }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium text-foreground">
            {labelOf(node, store)}
          </h2>
          {node.status && (
            <Badge variant={STATUS_BADGE[node.status]}>
              {t(STATUS_LABEL[node.status])}
            </Badge>
          )}
          {!node.status && value !== null && (
            <span className="text-sm font-medium tabular-nums text-muted-foreground">
              {value}%
            </span>
          )}
        </div>
        {metric && (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">
              {metric.value}
            </span>{" "}
            {metric.label}
          </p>
        )}
        {node.soon && (
          <p className="text-sm text-muted-foreground">
            {t("plan.map.soonDescription")}
          </p>
        )}
        {node.note && (
          <p className="text-sm text-pretty text-muted-foreground">
            {node.note}
          </p>
        )}
        {node.status === "done" && !node.note && (
          <p className="text-sm text-muted-foreground">
            {t("plan.map.doneDescription")}
          </p>
        )}
      </div>
      {node.status && node.status !== "done" && (
        <Button size="sm" className="w-fit">
          {t("plan.map.createTask")}
        </Button>
      )}
      {node.status === "done" && (
        <Button variant="outline" size="sm" className="w-fit">
          <RefreshCw01 />
          {t("plan.map.revalidate")}
        </Button>
      )}
      {children.length > 0 && (
        <ul className="-mx-2 flex flex-col">
          {children.map((child) => {
            const childCounts = countLeaves(child);
            const childPlaced = BY_ID.get(child.id);
            const childGraded = childPlaced ? isGraded(childPlaced) : false;
            return (
              <li key={child.id}>
                <Button
                  variant="menu"
                  size="sm"
                  className="h-auto min-h-7 gap-2.5 py-1.5"
                  onClick={() => onSelect(child.id)}
                >
                  {child.status ? (
                    <StatusDot status={child.status} />
                  ) : (
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        background: childGraded
                          ? ringGradient(childCounts)
                          : "var(--border)",
                      }}
                    />
                  )}
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="max-w-full truncate">{child.label}</span>
                    {resultOf(child) && (
                      <span className="text-left text-xs whitespace-normal text-muted-foreground">
                        {resultOf(child)}
                      </span>
                    )}
                  </span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {summaryOf(child)}
                  </span>
                  {!child.status && !child.soon && (
                    <ChevronRight className="text-muted-foreground" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/** The store at the center of the map: the organization. */
export interface MapStore {
  name: string;
  logo: string | null;
}

function labelOf(node: MapNode, store: MapStore): string {
  return node.id === MOCK_SITE_MAP.id ? store.name : node.label;
}

interface Drag {
  x: number;
  y: number;
  camera: Camera;
  moved: boolean;
}

export function SiteMap({
  store,
  origin,
  leading,
}: {
  store: MapStore;
  /** The store's live origin, for framing a funnel stage's page. */
  origin: string | null;
  /** Controls before the breadcrumb, over the map's top-left corner. */
  leading?: ReactNode;
}) {
  const t = useT();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [focusId, setFocusId] = useState("root");
  const [manual, setManual] = useState<Camera | null>(null);
  const [smooth, setSmooth] = useState(true);
  const drag = useRef<Drag | null>(null);

  const focus = BY_ID.get(focusId) ?? PLACED[0]!;
  const panelOpen = size.width >= 900;
  const camera = manual ?? fitCamera(focus, size.width, size.height, panelOpen);

  const viewport = (element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  };

  const canvas = (element: HTMLDivElement | null) => {
    if (!element) return;
    // React's wheel listener is passive; without this, Ctrl + scroll zooms the browser.
    const block = (event: WheelEvent) => event.preventDefault();
    element.addEventListener("wheel", block, { passive: false });
    return () => element.removeEventListener("wheel", block);
  };

  const select = (id: string) => {
    setSmooth(true);
    setManual(null);
    setFocusId(id);
  };

  const zoomBy = (factor: number) => {
    setSmooth(true);
    setManual((current) =>
      zoomAround(current ?? camera, factor, size.width / 2, size.height / 2),
    );
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setSmooth(false);
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.01);
      const px = event.clientX - bounds.left;
      const py = event.clientY - bounds.top;
      setManual((current) => zoomAround(current ?? camera, factor, px, py));
      return;
    }
    setManual((current) => {
      const base = current ?? camera;
      return { ...base, x: base.x - event.deltaX, y: base.y - event.deltaY };
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      camera,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      current.moved = true;
      // Captured only once it is a drag, so a plain click still reaches the topic.
      event.currentTarget.setPointerCapture(event.pointerId);
      setSmooth(false);
    }
    setManual({
      ...current.camera,
      x: current.camera.x + dx,
      y: current.camera.y + dy,
    });
  };

  const endDrag = () => {
    drag.current = null;
  };

  const path = pathTo(focus);
  const inFunnel = FUNNEL ? isDescendant(focus, FUNNEL) : false;
  /** A funnel stage opens as a card with its page instead of the side panel. */
  const stage = focus.node.opportunities ? focus.node : null;
  const ready = size.width > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        {leading}
        <nav
          aria-label={t("plan.map.breadcrumb")}
          className="flex min-w-0 items-center gap-1 text-sm"
        >
          {path.map((item, index) => {
            const last = index === path.length - 1;
            return (
              <span key={item.node.id} className="flex items-center gap-1">
                {index > 0 && (
                  <ChevronRight size={14} className="text-subtle-foreground" />
                )}
                <button
                  type="button"
                  onClick={() => select(item.node.id)}
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "rounded-md px-1.5 py-0.5 hover:bg-accent",
                    last
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {labelOf(item.node, store)}
                </button>
              </span>
            );
          })}
        </nav>
        {!inFunnel && (
          <span className="ml-auto hidden text-xs text-muted-foreground md:block">
            {t("plan.map.hint")}
          </span>
        )}
      </div>
      <div
        ref={viewport}
        className="relative min-h-0 flex-1 overflow-clip border-t border-border"
      >
        {inFunnel && FUNNEL && stage ? (
          <div className="grid h-full grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <FunnelView
              funnel={FUNNEL.node}
              selectedId={stage.id}
              compact
              onSelect={select}
            />
            <div className="min-h-0 py-3 pr-3">
              <StageCard
                key={stage.id}
                stage={stage}
                origin={origin}
                onClose={() => select(FUNNEL.node.id)}
              />
            </div>
          </div>
        ) : inFunnel && FUNNEL ? (
          <div
            className="h-full"
            style={{ paddingRight: panelOpen ? PANEL_WIDTH : 0 }}
          >
            <FunnelView
              funnel={FUNNEL.node}
              selectedId={focus.node.id}
              compact={false}
              onSelect={select}
            />
          </div>
        ) : (
          <div
            ref={canvas}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute inset-0 cursor-grab touch-none overflow-clip bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:20px_20px] select-none active:cursor-grabbing"
          >
            {ready && (
              <div
                className={cn(
                  "absolute top-0 left-0 origin-top-left",
                  smooth && "transition-transform duration-500 ease-out",
                )}
                style={{
                  transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})`,
                }}
              >
                <svg
                  aria-hidden
                  className="absolute overflow-visible"
                  width={1}
                  height={1}
                >
                  {PLACED.filter((item) => item.parent).map((item) => (
                    <line
                      key={item.node.id}
                      x1={item.parent?.x}
                      y1={item.parent?.y}
                      x2={item.x}
                      y2={item.y}
                      className={cn(
                        "stroke-muted-foreground/35 transition-opacity duration-300",
                        item.node.soon && "[stroke-dasharray:6_6]",
                        !isShown(item, focus) && "opacity-0",
                      )}
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                {PLACED.map((item) => (
                  <MapNodeView
                    key={item.node.id}
                    item={item}
                    store={store}
                    zoom={camera.k}
                    shown={isShown(item, focus)}
                    focused={item === focus && focus.depth > 0}
                    onSelect={select}
                  />
                ))}
              </div>
            )}
            <div
              className="absolute bottom-3 left-3 flex items-center gap-4 surface px-3 py-2 text-xs text-muted-foreground"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {STATUSES.map((status) => (
                <span key={status} className="flex items-center gap-1.5">
                  <StatusDot status={status} />
                  {t(STATUS_LABEL[status])}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full border border-dashed border-muted-foreground" />
                {t("plan.map.soon")}
              </span>
            </div>
            <div
              className="absolute bottom-3 flex items-center gap-1 surface p-1"
              style={{ right: panelOpen ? PANEL_WIDTH : 12 }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("plan.map.zoomOut")}
                onClick={() => zoomBy(1 / 1.25)}
              >
                <Minus />
              </Button>
              <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
                {Math.round(camera.k * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("plan.map.zoomIn")}
                onClick={() => zoomBy(1.25)}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("plan.map.fit")}
                onClick={() => select("root")}
              >
                <Expand06 />
              </Button>
            </div>
          </div>
        )}
        {panelOpen && !stage && (
          <DetailPanel item={focus} store={store} onSelect={select} />
        )}
      </div>
    </div>
  );
}
