/**
 * A business case the Plan page builds with the person, one chat at a time.
 *
 * The agent writes it as JSON in the org `home` volume, at
 * `plans/cases/<threadId>.json`, through the business-case skill's
 * `business-case-canvas.mjs` (which mirrors these limits, checked by
 * `packages/sandbox/business-case-canvas.test.ts`). The web reads the same file
 * and renders one card per key, so the case fills in while the chat goes on.
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

export const BUSINESS_CASE_LIMITS = {
  title: 140,
  text: 600,
  item: 300,
  items: 8,
  url: 2048,
} as const;

const text = z.string().max(BUSINESS_CASE_LIMITS.text);
const item = z.string().min(1).max(BUSINESS_CASE_LIMITS.item);

export const BusinessCaseSourceSchema = z.object({
  label: item,
  url: z.string().url().max(BUSINESS_CASE_LIMITS.url).optional(),
});

export type BusinessCaseSource = z.infer<typeof BusinessCaseSourceSchema>;

export const BusinessCaseCardSchema = z.object({
  /** `asking`: the chat is asking the question this card answers. */
  state: z.enum(["empty", "asking", "filled"]),
  summary: text.optional(),
  bullets: z.array(item).max(BUSINESS_CASE_LIMITS.items),
  sources: z.array(BusinessCaseSourceSchema).max(BUSINESS_CASE_LIMITS.items),
  /** What the agent assumed instead of asking. */
  assumption: text.optional(),
});

export type BusinessCaseCard = z.infer<typeof BusinessCaseCardSchema>;

export const BusinessCaseSchema = z.object({
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
      BUSINESS_CASE_CARD_KEYS.map((key) => [key, BusinessCaseCardSchema]),
    ) as Record<BusinessCaseCardKey, typeof BusinessCaseCardSchema>,
  ),
  /** The markdown document for the team, home-volume relative, once written. */
  documentPath: z.string().max(BUSINESS_CASE_LIMITS.item).optional(),
  updatedAt: z.string().datetime(),
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
  const empty = (): BusinessCaseCard => ({
    state: "empty",
    bullets: [],
    sources: [],
  });
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
      BUSINESS_CASE_CARD_KEYS.map((key) => [key, empty()]),
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
