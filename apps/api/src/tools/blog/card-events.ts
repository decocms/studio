import {
  BLOG_CARD_DELETED_EVENT,
  BLOG_CARD_UPDATED_EVENT,
  type BlogCard,
} from "@decocms/shared/blog-card";
import { sseHub } from "@/event-bus/sse-hub";

/** Push a written card to every SSE listener on its org. */
export function emitBlogCardUpdated(orgId: string, card: BlogCard): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: BLOG_CARD_UPDATED_EVENT,
    source: "blog",
    subject: card.id,
    data: card,
    time: new Date().toISOString(),
  });
}

/** Push a card deletion to every SSE listener on its org. */
export function emitBlogCardDeleted(orgId: string, id: string): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: BLOG_CARD_DELETED_EVENT,
    source: "blog",
    subject: id,
    data: { id },
    time: new Date().toISOString(),
  });
}
