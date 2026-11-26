/** Test evidence with the GA4 funnel on both devices and the PDP funnel on mobile. */
import type {
  DevicePdpBehaviour,
  DiagnosisEvidence,
  FunnelSegment,
} from "../types.ts";

const behaviour = (
  device: "mobile" | "desktop",
  visitors: number,
  carted: number,
): DevicePdpBehaviour => ({
  device,
  views: visitors,
  avg_depth_pct: 40,
  avg_fold_pct: 20,
  active_seconds: 30,
  clicks: 0,
  dead_clicks: 0,
  reach: { p25: 80, p50: 50, p75: 20 },
  funnel: { visitors, viewed: visitors, carted },
  sections: [],
});

export const evidence = (
  over: Partial<DiagnosisEvidence> = {},
): DiagnosisEvidence => ({
  window_days: 7,
  platform_funnel: [
    {
      platform: "web_mobile",
      steps: [
        { event: "session_start", count: 100_000 },
        { event: "view_item", count: 50_000 },
        { event: "add_to_cart", count: 5_000 },
        { event: "begin_checkout", count: 2_000 },
        { event: "purchase", count: 1_000 },
      ],
    },
    {
      platform: "web_desktop",
      steps: [
        { event: "session_start", count: 20_000 },
        { event: "view_item", count: 10_000 },
        { event: "add_to_cart", count: 2_000 },
        { event: "begin_checkout", count: 800 },
        { event: "purchase", count: 500 },
      ],
    },
  ],
  pdp_behaviour: [behaviour("mobile", 40_000, 3_000)],
  revenue: null,
  products: [],
  captures: [],
  benchmark: [],
  gaps: [],
  ...over,
});

/** Synthetic slices of a fashion store (GA4, one week), viewed product → cart on the site. */
const SAMPLE_CUTS: Array<[string, string, number, number, number, number]> = [
  // dim, key, mobile viewed, mobile cart, desktop viewed, desktop cart
  ["canal", "busca_organica", 10_382, 1_640, 3_056, 823],
  ["canal", "crm", 6_801, 922, 3_990, 739],
  ["canal", "direto", 39_378, 4_119, 4_631, 1_252],
  ["canal", "midia_paga", 48_480, 5_876, 16_250, 4_139],
  ["canal", "outros", 40_879, 10_096, 2_279, 490],
  ["canal", "referencia", 418, 66, 204, 43],
  ["canal", "social", 13_866, 2_824, 420, 24],
  ["canal", "social_pago", 164_995, 8_354, 1_974, 165],
  ["visitante", "nova", 212_635, 17_460, 17_120, 3_134],
  ["visitante", "recorrente", 106_870, 16_224, 15_495, 4_510],
  ["visitante", "sem_dado", 6_241, 214, 205, 32],
];

export const sampleSegments: FunnelSegment[] = SAMPLE_CUTS.flatMap(
  ([dim, key, mv, ma, dv, da]) => [
    {
      dim: dim as FunnelSegment["dim"],
      key,
      platform: "web_mobile",
      steps: [
        { event: "view_item", count: mv },
        { event: "add_to_cart", count: ma },
      ],
    },
    {
      dim: dim as FunnelSegment["dim"],
      key,
      platform: "web_desktop",
      steps: [
        { event: "view_item", count: dv },
        { event: "add_to_cart", count: da },
      ],
    },
  ],
);

/** The unsliced funnel of the same week. */
export const sampleFunnel = [
  {
    platform: "web_mobile",
    steps: [
      { event: "view_item", count: 325_198 },
      { event: "add_to_cart", count: 33_897 },
    ],
  },
  {
    platform: "web_desktop",
    steps: [
      { event: "view_item", count: 32_805 },
      { event: "add_to_cart", count: 7_676 },
    ],
  },
];
