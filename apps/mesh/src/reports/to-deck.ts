// Adapter between the reports engine's public read (`/api/v2/public/diagnostics`)
// and the renderable Signal Deck. The engine builds the deck server-side
// (format_for_view → ordered `sections`); here we parse each section's `props`
// against the shared contract into the strict `DeckSlide` the templates render.
// Ported from decocms-tanstack `src/server/diagnostics.ts`.

import { DeckSlideContract } from "./deck-contract.gen";
import type { DeckScores, DeckSlide, TemplateDeck } from "./deck-types";

/** Raw engine response shape (props is `unknown` until normalized). */
export interface PublicReportResponse {
  url: string;
  scope: "public" | "private";
  scanned_at: string | null;
  meta: TemplateDeck["meta"];
  summary: { scores?: DeckScores } | null;
  sections: { section_type: string; position: number; props: unknown }[];
  results: unknown[];
}

/** A slide the engine persisted that failed the shared contract — surfaced for
 *  telemetry (a drop should be zero in steady state; a non-zero count is a
 *  contract-drift signal, not silent data loss). */
export interface SlideDrop {
  section_type: string;
  position: number;
  reason: string;
}

/** What the report page receives from `GET /api/_reports/site/:domain`. */
export interface ReportState {
  /** ready = a deck with slides · empty = scanned but no slides · not_found = never scanned. */
  status: "ready" | "empty" | "not_found";
  deck: TemplateDeck | null;
  scanned_at: string | null;
  /** Slides dropped by the contract on this read (for `report_slide_dropped`). */
  drops: SlideDrop[];
}

/** Run response from POST /api/v2/diagnostics/run (idempotent + single-flight). */
export interface ScanTrigger {
  /** fresh = recent run reused · running = a durable run (poll `id`) · sync = ran inline · blocked = locked down. */
  state: "fresh" | "running" | "sync" | "blocked";
  id?: string | null;
}

export interface ScanStatus {
  /** running while queued/running/paused; done once terminal. */
  done: boolean;
  status: string;
}

/** What an email link's `d` token resolves to. */
export interface ResolvedLinkToken {
  domain: string;
  run_id: string;
  issued_at: string;
}

export interface DomainSuggestion {
  domain: string;
  /** a published report exists — selecting it lands on an instant result. */
  hasReport: boolean;
}

/**
 * API section.props → a renderable, strictly-shaped DeckSlide. The engine and
 * this app share ONE schema (`deck-contract.gen.ts`, generated from the
 * engine's deck-contract.ts): a valid slide comes back with the contract's
 * repairs applied; a structurally-incomplete slide is dropped and RECORDED.
 */
export function toDeck(resp: PublicReportResponse): {
  deck: TemplateDeck;
  drops: SlideDrop[];
} {
  const drops: SlideDrop[] = [];
  const slides = [...resp.sections]
    .sort((a, b) => a.position - b.position)
    .map((sec): DeckSlide | null => {
      const parsed = DeckSlideContract.safeParse(sec.props);
      if (parsed.success) return parsed.data as unknown as DeckSlide;
      // Include the issue PATH — zod messages alone ("Too small: expected array
      // to have >=1 items") don't say WHICH field failed.
      const issue = parsed.error.issues[0];
      drops.push({
        section_type: sec.section_type,
        position: sec.position,
        reason: issue
          ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
          : "contract violation",
      });
      return null;
    })
    .filter((s): s is DeckSlide => s !== null);
  return {
    deck: { meta: { ...resp.meta, scores: resp.summary?.scores }, slides },
    drops,
  };
}
