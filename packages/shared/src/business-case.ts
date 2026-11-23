/**
 * A business case the Plan page builds with the person, one chat at a time.
 *
 * The agent writes it as JSON in the org `home` volume, at
 * `plans/cases/<threadId>.json`, through the business-case skill's
 * `business-case-canvas.mjs` (which mirrors these limits, checked by
 * `packages/sandbox/business-case-canvas.test.ts`). The web reads the same file.
 */

import { z } from "zod";
import {
  HOME_MOUNT_PATH,
  SANDBOX_ORG_ROOT,
} from "./organization/home-mount.ts";

/** The cards, in the order the canvas shows them. */
export const BUSINESS_CASE_CARD_KEYS = [
  "problem",
  "scope",
  "money",
  "competitors",
  "approach",
  "measurement",
  "abTest",
  "effort",
  "risks",
  "unknowns",
] as const;

export type BusinessCaseCardKey = (typeof BUSINESS_CASE_CARD_KEYS)[number];

/** Where in the store the change happens. */
export const BUSINESS_CASE_AREAS = [
  "pdp",
  "search",
  "category",
  "home",
  "cart",
  "checkout",
  "shipping",
  "performance",
  "paid-media",
  "other",
] as const;

export type BusinessCaseArea = (typeof BUSINESS_CASE_AREAS)[number];

/** The parts of the store a change can touch: where the approach card says the
 *  problem gets solved, without naming files or fields. */
export const BUSINESS_CASE_LAYERS = [
  "code",
  "component",
  "catalog",
  "content",
  "platform",
  "data",
  "integration",
  "other",
] as const;

export type BusinessCaseLayer = (typeof BUSINESS_CASE_LAYERS)[number];

export const BUSINESS_CASE_LIMITS = {
  title: 140,
  text: 600,
  item: 300,
  items: 8,
  url: 2048,
  label: 60,
  question: 300,
  metrics: 4,
  layers: 4,
} as const;

/** How a card's metric reads: `percent` is 0–100, `brl` is reais. */
export const BUSINESS_CASE_METRIC_UNITS = [
  "percent",
  "seconds",
  "days",
  "brl",
  "count",
] as const;

/** The cards that may carry metrics: the problem compares the store with its
 *  benchmarks; effort adds up its days. */
const BUSINESS_CASE_METRIC_CARDS = ["problem", "effort"] as const;

/** Only the approach names the parts of the store it touches. */
const BUSINESS_CASE_LAYER_CARD = "approach";

const text = z.string().max(BUSINESS_CASE_LIMITS.text);
const item = z.string().min(1).max(BUSINESS_CASE_LIMITS.item);

export const BusinessCaseSourceSchema = z.object({
  label: item,
  url: z.string().url().max(BUSINESS_CASE_LIMITS.url).optional(),
});

export type BusinessCaseSource = z.infer<typeof BusinessCaseSourceSchema>;

const finite = z.number();
const label = z.string().min(1).max(BUSINESS_CASE_LIMITS.label);

const BusinessCaseMetricSchema = z.object({
  label,
  value: finite,
  unit: z.enum(BUSINESS_CASE_METRIC_UNITS),
});

export type BusinessCaseMetric = z.infer<typeof BusinessCaseMetricSchema>;

/** `business-case-math.mjs money`, run by the canvas script on the inputs the
 *  agent gave: `base` × `deltaPp` % × `value` = `monthlyValue` (revenue). */
const BusinessCaseMoneyCalcSchema = z.object({
  kind: z.literal("money"),
  base: finite,
  baseLabel: label.optional(),
  deltaPp: finite,
  value: finite,
  valueLabel: label.optional(),
  gapPp: finite.optional(),
  monthlyValue: finite,
  ceilingMonthly: finite.nullable(),
});

export type BusinessCaseMoneyCalc = z.infer<typeof BusinessCaseMoneyCalcSchema>;

/** `business-case-math.mjs ab-test`, run by the canvas script. */
const BusinessCaseAbTestCalcSchema = z.object({
  kind: z.literal("abTest"),
  baseline: finite,
  mdePp: finite,
  nPerGroup: finite.nullable(),
  weeks: finite.nullable(),
  measurable: z.boolean(),
});

export const BusinessCaseCardSchema = z.object({
  /** `asking`: the chat is asking the question this card answers. */
  state: z.enum(["empty", "asking", "filled"]),
  /** The question as the chat asked it, while the card is asking. */
  question: z.string().min(1).max(BUSINESS_CASE_LIMITS.question).optional(),
  summary: text.optional(),
  bullets: z.array(item).max(BUSINESS_CASE_LIMITS.items),
  sources: z.array(BusinessCaseSourceSchema).max(BUSINESS_CASE_LIMITS.items),
  /** What the agent assumed instead of asking. */
  assumption: text.optional(),
  metrics: z
    .array(BusinessCaseMetricSchema)
    .max(BUSINESS_CASE_LIMITS.metrics)
    .optional(),
  layers: z
    .array(z.enum(BUSINESS_CASE_LAYERS))
    .max(BUSINESS_CASE_LIMITS.layers)
    .optional(),
  calc: z
    .discriminatedUnion("kind", [
      BusinessCaseMoneyCalcSchema,
      BusinessCaseAbTestCalcSchema,
    ])
    .optional(),
});

export type BusinessCaseCard = z.infer<typeof BusinessCaseCardSchema>;

function emptyCard(): BusinessCaseCard {
  return { state: "empty", bullets: [], sources: [] };
}

/** Cards a case written before they existed may lack; they read as empty. */
const LATER_CARDS: readonly BusinessCaseCardKey[] = ["approach"];

export const BusinessCaseSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(BUSINESS_CASE_LIMITS.title),
    status: z.enum(["framing", "building", "ready"]),
    threadId: z.string().max(BUSINESS_CASE_LIMITS.title).optional(),
    /** The store goal when the case started; null when the store has none. */
    objective: text.nullable(),
    request: z.object({
      text: z.string().min(1).max(BUSINESS_CASE_LIMITS.text),
      area: z.enum(BUSINESS_CASE_AREAS),
    }),
    cards: z.object(
      Object.fromEntries(
        BUSINESS_CASE_CARD_KEYS.map((key) => [
          key,
          LATER_CARDS.includes(key)
            ? BusinessCaseCardSchema.default(emptyCard)
            : BusinessCaseCardSchema,
        ]),
      ) as Record<BusinessCaseCardKey, typeof BusinessCaseCardSchema>,
    ),
    updatedAt: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    for (const key of BUSINESS_CASE_CARD_KEYS) {
      const card = value.cards[key];
      const metricCard = (
        BUSINESS_CASE_METRIC_CARDS as readonly string[]
      ).includes(key);
      if (card.metrics && !metricCard) {
        ctx.addIssue({
          code: "custom",
          path: ["cards", key, "metrics"],
          message: `only ${BUSINESS_CASE_METRIC_CARDS.join(" and ")} carry metrics`,
        });
      }
      if (card.layers && key !== BUSINESS_CASE_LAYER_CARD) {
        ctx.addIssue({
          code: "custom",
          path: ["cards", key, "layers"],
          message: `only ${BUSINESS_CASE_LAYER_CARD} carries layers`,
        });
      }
      if (card.calc && card.calc.kind !== key) {
        ctx.addIssue({
          code: "custom",
          path: ["cards", key, "calc"],
          message: `a ${card.calc.kind} calc belongs on the ${card.calc.kind} card`,
        });
      }
    }
  });

export type BusinessCase = z.infer<typeof BusinessCaseSchema>;

/** The folder every case lives in, relative to the `home` volume. */
export const BUSINESS_CASE_DIR = "plans/cases";

const CASE_PATH = /^plans\/cases\/([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;

/** The case of a chat, relative to the `home` volume. */
export function businessCasePath(threadId: string): string {
  return `${BUSINESS_CASE_DIR}/${threadId}.json`;
}

/** The same file as the agent sees it inside the sandbox. */
export function businessCaseMountPath(path: string): string {
  return `${SANDBOX_ORG_ROOT}/${HOME_MOUNT_PATH}/${path}`;
}

/** The chat id a case path names, or null when the path is not a case. */
export function matchBusinessCasePath(path: string): string | null {
  return CASE_PATH.exec(path)?.[1] ?? null;
}

/** A case with only the goal and the request: what the page shows before the
 *  agent writes anything. */
export function emptyBusinessCase(input: {
  title: string;
  objective: string | null;
  request: string;
  area?: BusinessCaseArea;
  threadId?: string;
  now?: Date;
}): BusinessCase {
  return {
    version: 1,
    title: input.title.slice(0, BUSINESS_CASE_LIMITS.title),
    status: "framing",
    ...(input.threadId ? { threadId: input.threadId } : {}),
    objective: input.objective?.slice(0, BUSINESS_CASE_LIMITS.text) ?? null,
    request: {
      text: input.request.slice(0, BUSINESS_CASE_LIMITS.text),
      area: input.area ?? "other",
    },
    cards: Object.fromEntries(
      BUSINESS_CASE_CARD_KEYS.map((key) => [key, emptyCard()]),
    ) as Record<BusinessCaseCardKey, BusinessCaseCard>,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
}

/** Parse a case file's text; null when it is not valid JSON or not a case. */
export function parseBusinessCase(raw: string): BusinessCase | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = BusinessCaseSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
