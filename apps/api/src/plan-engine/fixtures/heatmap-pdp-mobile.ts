import type { HeatmapPayload } from "../ports.ts";

const REACH = [
  100, 99, 96, 90, 80, 70.2, 62, 55, 48, 43, 39.7, 35, 31, 27, 23, 20, 16, 12,
  8, 5, 2,
];

const DETAILS = "site/sections/Product/ProductDetails.tsx#0";
const GALLERY = "site/sections/Product/Gallery.tsx#0";

/** A synthetic mobile PDP heatmap, shaped like the analytics `view=heatmap` payload. */
export const heatmapPdpMobile: HeatmapPayload = {
  registered: true,
  siteId: "s1",
  data: {
    hmSummary: [
      {
        views: 120_000,
        clicks: 200_000,
        rage: 3_000,
        dead: 25_000,
        avg_depth: 47.4,
        avg_fold: 17.1,
        active_s: 15,
      },
    ],
    hmScroll: REACH.map((reach_pct, i) => ({
      depth: i * 5,
      views: 1_000,
      reach_pct,
    })),
    hmSections: [
      {
        root: DETAILS,
        seen_views: 110_000,
        reach_pct: 92,
        avg_s: 12,
        ctr_pct: 30,
        clicks: 60_000,
      },
      {
        root: GALLERY,
        seen_views: 115_000,
        reach_pct: 96,
        avg_s: 8,
        ctr_pct: 20,
        clicks: 40_000,
      },
      {
        root: "site/sections/Product/Reviews.tsx#0",
        seen_views: 20_000,
        reach_pct: 17,
        avg_s: 3,
        ctr_pct: 0,
        clicks: 0,
      },
      {
        root: "site/sections/Theme/Theme.tsx#0",
        seen_views: 120_000,
        reach_pct: 100,
        avg_s: 15,
        ctr_pct: 1,
        clicks: 12,
      },
      {
        root: "site/sections/Tracking/Pixel.tsx#0",
        seen_views: 120_000,
        reach_pct: 100,
        avg_s: 15,
        ctr_pct: 1,
        clicks: 3,
      },
      {
        root: "site/sections/VWO.tsx#0",
        seen_views: 120_000,
        reach_pct: 100,
        avg_s: 15,
        ctr_pct: 1,
        clicks: 2,
      },
    ],
    hmElements: [
      { root: DETAILS, el: "11", clicks: 30_000, dead: 900, dead_int: 400 },
      { root: DETAILS, el: "12", clicks: 18_000, dead: 50, dead_int: 10 },
      { root: GALLERY, el: "21", clicks: 25_000, dead: 8_000, dead_int: 0 },
      { root: "site/sections/VWO.tsx#0", el: "99", clicks: 50_000, dead: 0 },
    ],
    hmFunnel: [
      { root: "", el: "0", visitors: 56_000, viewed: 21_000, carted: 3_000 },
      {
        root: DETAILS,
        el: "11",
        visitors: 9_000,
        viewed: 6_000,
        carted: 1_500,
      },
    ],
  },
};
