/**
 * What a Monitor tab looks like once connected, for the faded picture behind
 * its connect panel: the metric cards, the deploys and the experiments of a
 * made-up store (Site, App and Blog). Never shown as data. Deterministic
 * except for "how long ago", which follows the real clock.
 */

import type { Deploy, ExperimentRow, Kpi, MetricPoint } from "./board";
import { BUCKET_MINUTES, BUCKETS_PER_DAY, type Comparison, sum } from "./board";

/** Orders per hour of a typical day, before a store's own scale. */
const DAY_SHAPE = [
  6, 3, 2, 1, 1, 2, 5, 9, 15, 24, 33, 38, 41, 40, 45, 42, 46, 48, 44, 36, 28,
  22, 15, 9,
];
const HOUR_NOW = 14;
/** One 15-minute bucket into the hour, so the running hour's pace reads right. */
const MINUTE_NOW = 15;
const NOW_MINUTES = HOUR_NOW * 60 + MINUTE_NOW;

/** A time of the preview day, placed that long before the real now. */
function at(hour: number, minute = 0): string {
  const before = NOW_MINUTES - (hour * 60 + minute);
  return new Date(Date.now() - before * 60_000).toISOString();
}
const NOW_BUCKET = Math.floor(NOW_MINUTES / BUCKET_MINUTES);
const LAST_BUCKET = BUCKETS_PER_DAY - 1;
const bucketOf = (hour: number, minute = 0) =>
  Math.floor((hour * 60 + minute) / BUCKET_MINUTES);

/** Deterministic noise in [-1, 1]. */
function noise(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** The day's traffic shape at a 5-minute bucket, 0..1. */
function shapeAt(bucket: number): number {
  const hour = (bucket * BUCKET_MINUTES) / 60;
  const h = Math.floor(hour) % 24;
  const next = DAY_SHAPE[(h + 1) % 24] ?? 0;
  const here = DAY_SHAPE[h] ?? 0;
  return (here + (next - here) * (hour - h)) / 48;
}

/** How each reference day sits against a normal today, per kind of metric. */
const COUNT_LEVELS: Record<Comparison, number> = {
  d1: 1.03,
  w1: 0.97,
  y1: 0.68,
};
const LEVEL_LEVELS: Record<Comparison, number> = { d1: 1.01, w1: 1, y1: 0.94 };
const REF_SEED: Record<Comparison, number> = { d1: 2, w1: 12, y1: 22 };

interface DaySpec {
  /** Last bucket with data: now for today, the whole day for a past one. */
  last: number;
  /** Shifts the noise so another day looks like another day. */
  seed: number;
  /** Today's incidents (the drop, the slow gallery) happen only today. */
  incidents: boolean;
}

/**
 * A metric's day and its three reference days. `base` is the normal shape;
 * `incident` multiplies today's value from the moment something broke.
 */
function metric(
  spec: DaySpec,
  base: (bucket: number, seed: number) => number,
  levels: Record<Comparison, number>,
  incident: (bucket: number) => number,
  digits = 0,
): MetricPoint[] {
  const round = (v: number) => Math.round(v * 10 ** digits) / 10 ** digits;
  const ref = (b: number, c: Comparison) =>
    round(base(b, spec.seed + REF_SEED[c]) * levels[c]);
  return Array.from({ length: spec.last + 1 }, (_, b) => ({
    bucket: b,
    value: round(base(b, spec.seed) * (spec.incidents ? incident(b) : 1)),
    d1: ref(b, "d1"),
    w1: ref(b, "w1"),
    y1: ref(b, "y1"),
  }));
}

const DROP = bucketOf(13, 15);
const GALLERY = bucketOf(11, 45);

type Key = "value" | Comparison;
const totalOf = (pts: readonly MetricPoint[], key: Key) =>
  sum(pts.map((p) => p[key]));

function kpisAt(scale: number, outletShare: number, spec: DaySpec): Kpi[] {
  const drop = (b: number) => (b >= DROP ? 1 - outletShare * 0.6 : 1);
  const orders = metric(
    spec,
    (b, seed) =>
      Math.max(0, shapeAt(b) * 14 * scale * (1 + 0.12 * noise(b, seed + 1))),
    COUNT_LEVELS,
    drop,
  );
  const cancellations = metric(
    spec,
    (b, seed) =>
      Math.max(0, shapeAt(b) * 0.7 * scale * (1 + 0.5 * noise(b, seed + 13))),
    COUNT_LEVELS,
    (b) => (b >= DROP ? 1 + outletShare * 6 : 1),
  );
  const audience = metric(
    spec,
    (b, seed) =>
      Math.max(0, shapeAt(b) * 620 * scale * (1 + 0.06 * noise(b, seed + 3))),
    COUNT_LEVELS,
    () => 1,
  );
  const conversion = metric(
    spec,
    (b, seed) => 1.92 + 0.12 * noise(b, seed + 5),
    LEVEL_LEVELS,
    (b) => (b >= DROP ? 1 - outletShare * 0.45 : 1),
    2,
  );
  const latency = metric(
    spec,
    (b, seed) => 435 + 22 * noise(b, seed + 7),
    LEVEL_LEVELS,
    (b) => (b >= GALLERY ? 1.38 : 1),
  );
  const errors = metric(
    spec,
    (b, seed) => Math.max(0, 1.55 + 0.6 * noise(b, seed + 9)),
    { d1: 1, w1: 0.95, y1: 1.2 },
    (b) => (b >= DROP ? 1 + outletShare * 6 : 1),
  );

  // Orders are projected to the end of the day by how much of a usual day's
  // shape has passed; reference days are whole days, like the order monitor.
  const fullDay = Array.from({ length: BUCKETS_PER_DAY }, (_, b) => shapeAt(b));
  const passed =
    sum(fullDay.slice(0, spec.last + 1)) / Math.max(1e-9, sum(fullDay));
  const soFar = totalOf(orders, "value");
  const wholeDay = (c: Comparison) =>
    Math.round(sum(fullDay) * 14 * scale * COUNT_LEVELS[c]);

  // The rest of the day: the projection spread along a usual day's shape, and
  // the reference days carried on to midnight.
  const projectedDay = Math.round(soFar / Math.max(passed, 0.01));
  const perShape = projectedDay / Math.max(1e-9, sum(fullDay));
  const projection = metric(
    { ...spec, last: BUCKETS_PER_DAY - 1 },
    (b, seed) =>
      Math.max(0, shapeAt(b) * 14 * scale * (1 + 0.12 * noise(b, seed + 1))),
    COUNT_LEVELS,
    drop,
  )
    .slice(spec.last + 1)
    .map((p) => ({ ...p, value: (fullDay[p.bucket] ?? 0) * perShape }));

  const references = (fn: (key: Key) => number) => ({
    d1: fn("d1"),
    w1: fn("w1"),
    y1: fn("y1"),
  });
  const lastHour = (pts: readonly MetricPoint[], key: Key) => {
    const tail = pts.slice(-12);
    return sum(tail.map((p) => p[key])) / Math.max(1, tail.length);
  };
  const mean = (pts: readonly MetricPoint[], key: Key) =>
    totalOf(pts, key) / Math.max(1, pts.length) / 100;

  return [
    {
      id: "orders",
      source: "orders",
      value: projectedDay,
      soFar,
      references: references((k) => (k === "value" ? 0 : wholeDay(k))),
      points: orders,
      projection,
    },
    {
      id: "conversion",
      source: "site",
      value: mean(conversion, "value"),
      references: references((k) => mean(conversion, k)),
      points: conversion,
    },
    {
      id: "audience",
      source: "site",
      value: totalOf(audience, "value"),
      references: references((k) => totalOf(audience, k)),
      points: audience,
    },
    {
      id: "latency",
      source: "site",
      value: lastHour(latency, "value"),
      references: references((k) => lastHour(latency, k)),
      points: latency,
      threshold: 500,
    },
    {
      id: "errors",
      source: "site",
      value: totalOf(errors, "value"),
      references: references((k) => totalOf(errors, k)),
      points: errors,
    },
    {
      id: "cancellations",
      source: "orders",
      value: totalOf(cancellations, "value"),
      references: references((k) => totalOf(cancellations, k)),
      points: cancellations,
    },
  ];
}

/** Orders per 5 minutes around a change: an hour each side. */
function around(level: number, after: number, seed: number): number[] {
  return Array.from({ length: 25 }, (_, i) =>
    Math.max(
      0,
      Math.round(level * (i > 12 ? after : 1) * (1 + 0.2 * noise(i, seed))),
    ),
  );
}

const PAST_CHANGES = [
  "PDP: size guide drawer",
  "Search: synonyms for sneakers",
  "Checkout: Pix copy and paste",
  "Home: new hero carousel",
  "Cart: free shipping bar",
  "Footer: store locator link",
  "PLP: infinite scroll",
  "Header: mega menu cleanup",
  "PDP: reviews summary",
  "Account: order tracking page",
];
const AUTHORS = ["Ana", "Bruno", "Carla", "Diego", "Rafael"];

/**
 * Two weeks of changes, one by one, for the deploy timeline: each project
 * ships a few times a weekday at working hours, rarely on weekends; today's
 * are the board's own deploys, so the timeline and the table agree.
 */
function deployHistory(
  projects: readonly PreviewProject[],
  today: readonly Deploy[],
): Deploy[] {
  const day = 86_400_000;
  const midnight = new Date(at(0, 0)).getTime();
  const past: Deploy[] = [];
  for (let d = 13; d >= 1; d--) {
    const dayStart = midnight - d * day;
    const weekend = [0, 6].includes(new Date(dayStart).getDay());
    projects.forEach((project, pi) => {
      const n = weekend
        ? Math.abs(noise(d, pi + 30)) > 0.7
          ? 1
          : 0
        : 1 + Math.round(Math.abs(noise(d, pi + 40)) * (pi === 0 ? 3 : 2));
      for (let k = 0; k < n; k++) {
        const seed = d * 31 + pi * 7 + k;
        const hour = 9 + Math.abs(noise(seed, 50)) * 9;
        const roll = Math.abs(noise(seed, 60));
        past.push({
          id: `h-${d}-${pi}-${k}`,
          kind: roll > 0.95 ? "rollout" : "deploy",
          projectId: project.id,
          projectTitle: project.title,
          at: new Date(dayStart + hour * 3_600_000).toISOString(),
          message:
            PAST_CHANGES[
              Math.floor(Math.abs(noise(seed, 70)) * PAST_CHANGES.length)
            ] ?? "Site update",
          author:
            AUTHORS[Math.floor(Math.abs(noise(seed, 80)) * AUTHORS.length)] ??
            "Ana",
          impact: [],
          verdict:
            roll > 0.88
              ? "regression"
              : roll > 0.55
                ? "improvement"
                : "neutral",
          task: null,
          around: null,
        });
      }
    });
  }
  return [...past, ...today].sort((a, b) => a.at.localeCompare(b.at));
}

interface PreviewProject {
  id: string;
  title: string;
}

const [main, outlet, blog] = [
  { id: "preview-site", title: "Site" },
  { id: "preview-app", title: "App" },
  { id: "preview-blog", title: "Blog" },
] as [PreviewProject, PreviewProject, PreviewProject];

/** Days between a local `YYYY-MM-DD` and today; 0 for today or no date. */
function daysAgo(date: string | undefined): number {
  if (!date) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const then = new Date(`${date}T00:00:00`);
  return Math.max(
    0,
    Math.round((today.getTime() - then.getTime()) / 86_400_000),
  );
}

export interface MonitorPreview {
  kpis: Kpi[];
  deploys: Deploy[];
  deployHistory: Deploy[];
  experiments: ExperimentRow[];
}

export function monitorPreview(
  scopeId: string | null,
  /** A past local day (`YYYY-MM-DD`) to look at; today when absent. */
  date?: string,
): MonitorPreview {
  const offset = daysAgo(date);
  const spec: DaySpec =
    offset === 0
      ? { last: NOW_BUCKET, seed: 0, incidents: true }
      : { last: LAST_BUCKET, seed: offset * 100, incidents: false };
  const dayStart = new Date(Date.parse(at(0, 0)) - offset * 86_400_000);

  const deploys: Deploy[] = [
    {
      id: "d-blog",
      projectId: blog.id,
      projectTitle: blog.title,
      at: at(14, 5),
      message: "Blog: new article template",
      author: "Diego",
      impact: [],
      verdict: "settling",
      task: null,
      kind: "deploy",
      around: null,
    },
    {
      id: "d-shipping",
      projectId: outlet.id,
      projectTitle: outlet.title,
      at: at(13, 0),
      message: "Checkout: new shipping calculation",
      author: "Ana",
      impact: [
        { metric: "orders", change: -0.58 },
        { metric: "errors", change: 2.4 },
        { metric: "latency", change: 0.04 },
      ],
      verdict: "regression",
      task: { keySeq: 142 },
      kind: "deploy",
      around: around(9, 0.42, 21),
    },
    {
      id: "d-gallery",
      projectId: main.id,
      projectTitle: main.title,
      at: at(11, 45),
      message: "PDP: new image gallery",
      author: "Bruno",
      impact: [
        { metric: "orders", change: 0.02 },
        { metric: "errors", change: 0 },
        { metric: "latency", change: 0.38 },
      ],
      verdict: "regression",
      task: null,
      kind: "deploy",
      around: around(22, 1.02, 22),
    },
    {
      id: "d-rollout",
      projectId: main.id,
      projectTitle: main.title,
      at: at(10, 30),
      message: "Rollout: new storefront from 50% to 100% of traffic",
      author: "Rafael",
      impact: [
        { metric: "orders", change: 0.01 },
        { metric: "errors", change: -0.04 },
        { metric: "latency", change: -0.12 },
      ],
      verdict: "improvement",
      task: null,
      kind: "rollout",
      around: around(20, 1.01, 23),
    },
    {
      id: "d-banner",
      projectId: main.id,
      projectTitle: main.title,
      at: at(9, 30),
      message: "Home: Black Friday banner",
      author: "Carla",
      impact: [
        { metric: "orders", change: 0.06 },
        { metric: "errors", change: 0 },
        { metric: "latency", change: -0.03 },
      ],
      verdict: "improvement",
      task: null,
      kind: "deploy",
      around: around(14, 1.06, 24),
    },
  ];

  const experiments: ExperimentRow[] = [
    {
      id: "e-thumbs",
      projectId: main.id,
      title: "PDP: thumbnails on the left",
      state: "ready",
      participants: 18_400,
      sampleSize: 18_000,
      probability: 0.97,
      lift: 0.082,
    },
    {
      id: "e-cta",
      projectId: main.id,
      title: "Checkout: sticky CTA on mobile",
      state: "running",
      participants: 6_100,
      sampleSize: 16_000,
      probability: 0.64,
      lift: 0.019,
    },
    {
      id: "e-search",
      projectId: outlet.id,
      title: "Search: suggestions with photos",
      state: "low-traffic",
      participants: 900,
      sampleSize: 12_000,
      probability: 0.52,
      lift: 0.004,
    },
  ];

  const kpis = scopeId ? kpisAt(0.8, 0, spec) : kpisAt(1, 0.3, spec);
  const history = deployHistory([main, outlet, blog], deploys);
  const dayEnd = dayStart.getTime() + 86_400_000;
  const onScreen =
    offset === 0
      ? deploys
      : history.filter((d) => {
          const t = Date.parse(d.at);
          return t >= dayStart.getTime() && t < dayEnd;
        });
  return { kpis, deploys: onScreen, deployHistory: history, experiments };
}
