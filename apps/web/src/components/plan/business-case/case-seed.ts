/**
 * What the Plan page already knows about a case when it opens it: the goal and
 * the request. The case tab draws them before the agent writes the file, so
 * the page never opens blank. Kept in sessionStorage, per case path.
 */

import {
  BUSINESS_CASE_LIMITS,
  emptyBusinessCase,
  type BusinessCase,
} from "@decocms/shared/business-case";
import { z } from "zod";

const PREFIX = "studio:plan-case-seed:";

const CaseSeedSchema = z.object({
  title: z.string().min(1).max(BUSINESS_CASE_LIMITS.title),
  objective: z.string().max(BUSINESS_CASE_LIMITS.text).nullable(),
  request: z.string().min(1).max(BUSINESS_CASE_LIMITS.text),
});

export type CaseSeed = z.infer<typeof CaseSeedSchema>;

type SeedStorage = Pick<Storage, "getItem" | "setItem">;

/** The request in a card-sized title. */
export function seedTitle(request: string): string {
  const line = request.trim().split("\n")[0] ?? "";
  return line.length > BUSINESS_CASE_LIMITS.title
    ? `${line.slice(0, BUSINESS_CASE_LIMITS.title - 1)}…`
    : line;
}

export function writeCaseSeed(
  storage: SeedStorage,
  path: string,
  input: { objective: string | null | undefined; request: string },
): void {
  const request = input.request.trim().slice(0, BUSINESS_CASE_LIMITS.text);
  const seed: CaseSeed = {
    title: seedTitle(request),
    objective:
      input.objective?.trim().slice(0, BUSINESS_CASE_LIMITS.text) || null,
    request,
  };
  try {
    storage.setItem(PREFIX + path, JSON.stringify(seed));
  } catch {
    // Storage full or blocked: the page waits for the agent's file instead.
  }
}

/** The case to draw while the file does not exist yet; null without a seed. */
export function readCaseSeed(
  storage: SeedStorage,
  path: string,
): BusinessCase | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PREFIX + path);
  } catch {
    return null;
  }
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const seed = CaseSeedSchema.safeParse(json);
  return seed.success ? emptyBusinessCase(seed.data) : null;
}
