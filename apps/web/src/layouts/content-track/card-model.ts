/**
 * What the board and the card detail read off a blogpost card, apart from
 * how they draw it.
 */

import {
  BLOG_CARD_STAGES,
  type BlogCard,
  type BlogCardStage,
  type BlogCardStatus,
} from "@decocms/shared/blog-card";
import type { CampaignProduct } from "@/components/sandbox/content/blog/blog-data";
import { IMAGE_SENTINEL } from "@decocms/shared/blog-image-sentinel";

/**
 * Past this, a run the card still reads as running is taken for one that
 * died without saying so: an execution takes minutes, not half an hour.
 */
const RUN_STALE_MS = 30 * 60_000;

/** Lanes a person may drop a card on. Only starting a run makes it generate. */
export function canDropOn(status: BlogCardStatus): boolean {
  return status !== "generating";
}

/**
 * Whether the card's agent is at work on it now: an execution that has not
 * reached `done`, or a hypothesis not saved yet, and neither stopped by an
 * error nor gone quiet for too long.
 */
export function cardAgentWorking(card: BlogCard, now: number): boolean {
  if (card.error || !card.run) return false;
  const requested = Date.parse(card.run.requestedAt);
  if (!Number.isFinite(requested) || now - requested > RUN_STALE_MS) {
    return false;
  }
  if (card.run.phase === "execute") {
    return card.status === "generating" && card.stage !== "done";
  }
  return card.status === "ideas" && !card.hypothesis?.statement;
}

/**
 * The cards with one written card merged in, newest change first. A pushed
 * card older than the one held is a late echo and is dropped.
 */
export function upsertCard(cards: BlogCard[], card: BlogCard): BlogCard[] {
  const held = cards.find((entry) => entry.id === card.id);
  if (held && held.updatedAt > card.updatedAt) return cards;
  return [card, ...cards.filter((entry) => entry.id !== card.id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export type CardPhase = "hypothesis" | "execute" | "monitor";

/** The phase a card opens on: its hypothesis until execution has begun. */
export function defaultPhase(card: Pick<BlogCard, "status">): CardPhase {
  return card.status === "ideas" ? "hypothesis" : "execute";
}

/** What a card is called on the board: its hypothesis, then its post, then the ask. */
export function cardTitle(card: BlogCard): string {
  return (
    card.hypothesis?.title?.trim() ||
    card.post?.title?.trim() ||
    card.prompt?.trim().split("\n")[0]?.trim() ||
    ""
  );
}

/** Whether a stage of the execution is behind the card already. */
export function stageDone(card: BlogCard, stage: BlogCardStage): boolean {
  if (card.status !== "generating" && card.status !== "ideas") return true;
  if (!card.stage) return false;
  return BLOG_CARD_STAGES.indexOf(card.stage) > BLOG_CARD_STAGES.indexOf(stage);
}

/** An image address worth showing: set, and not a note left for the illustrator. */
export function imageReady(url: string | undefined): url is string {
  return !!url?.trim() && !url.startsWith(IMAGE_SENTINEL);
}

/** A product block's campaign products, in its order; an id the campaign lacks has nothing to show. */
export function shelfProducts(
  ids: readonly string[],
  products: readonly CampaignProduct[],
): CampaignProduct[] {
  const byId = new Map(products.map((product) => [product.id, product]));
  const shown = new Map<string, CampaignProduct>();
  for (const id of ids) {
    const product = byId.get(id);
    if (product && !shown.has(id)) shown.set(id, product);
  }
  return [...shown.values()];
}
