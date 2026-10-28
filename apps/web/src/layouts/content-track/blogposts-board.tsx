/**
 * The blogposts board: one lane per card status. A person drags a card
 * between lanes, except into Generating, which only starting a run reaches,
 * and except a card whose agent is at work on it. The lane mechanics are the
 * campaigns board's, so both boards behave the same under the hand.
 */

import { useState } from "react";
import { AlertCircle } from "@untitledui/icons";
import {
  BLOG_CARD_STATUSES,
  type BlogCard,
  type BlogCardStatus,
} from "@decocms/shared/blog-card";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useClockTick } from "@/lib/use-clock-tick";
import { canDropOn, cardAgentWorking, cardTitle } from "./card-model";

/** Drag payload — the dragged card's id. */
const DRAG_KEY = "application/x-blog-card-id";

export const CARD_STATUS_LABEL = {
  ideas: "contentTrack.lane.ideas",
  generating: "contentTrack.lane.generating",
  awaiting_review: "contentTrack.lane.awaitingReview",
  scheduled: "contentTrack.lane.scheduled",
  published: "contentTrack.lane.published",
} as const satisfies Record<BlogCardStatus, TranslationKey>;

export function BlogpostsBoard({
  cards,
  campaignNames,
  onOpen,
  onMove,
}: {
  cards: BlogCard[];
  /** Campaign names by record id. */
  campaignNames: ReadonlyMap<string, string>;
  onOpen: (card: BlogCard) => void;
  onMove: (card: BlogCard, status: BlogCardStatus) => void;
}) {
  const t = useT();
  const [dragOverLane, setDragOverLane] = useState<BlogCardStatus | null>(null);
  const now = useClockTick();

  const drop = (id: string, status: BlogCardStatus) => {
    const card = cards.find((entry) => entry.id === id);
    if (!card || card.status === status || cardAgentWorking(card, now)) return;
    onMove(card, status);
  };

  return (
    <div className="flex min-h-[28rem] gap-3 overflow-x-auto pb-2">
      {BLOG_CARD_STATUSES.map((status) => {
        const lane = cards.filter((card) => card.status === status);
        const droppable = canDropOn(status);
        return (
          <section
            key={status}
            aria-label={t(CARD_STATUS_LABEL[status])}
            onDragOver={(e) => {
              if (!droppable) return;
              e.preventDefault();
              setDragOverLane(status);
            }}
            onDragLeave={() =>
              setDragOverLane((current) =>
                current === status ? null : current,
              )
            }
            onDrop={(e) => {
              e.preventDefault();
              setDragOverLane(null);
              drop(e.dataTransfer.getData(DRAG_KEY), status);
            }}
            className={cn(
              "flex w-72 shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors",
              dragOverLane === status && "border-primary bg-primary/5",
            )}
          >
            <header className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium">
              <span className="truncate">{t(CARD_STATUS_LABEL[status])}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {lane.length}
              </span>
            </header>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {lane.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {t("contentTrack.lane.empty")}
                </p>
              ) : (
                lane.map((card) => (
                  <CardFace
                    key={card.id}
                    card={card}
                    working={cardAgentWorking(card, now)}
                    campaignName={
                      card.campaignId
                        ? campaignNames.get(card.campaignId)
                        : undefined
                    }
                    onOpen={() => onOpen(card)}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CardFace({
  card,
  working,
  campaignName,
  onOpen,
}: {
  card: BlogCard;
  working: boolean;
  campaignName: string | undefined;
  onOpen: () => void;
}) {
  const t = useT();
  const title = cardTitle(card);
  const format = card.hypothesis?.format?.name;
  return (
    <button
      type="button"
      draggable={!working}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_KEY, card.id)}
      onClick={onOpen}
      className={cn(
        "block w-full rounded-lg bg-card p-3 text-left shadow-edge transition-shadow hover:shadow-lift",
        working ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="flex items-start gap-2">
        <p
          className={cn(
            "line-clamp-2 min-w-0 flex-1 text-sm font-medium",
            !title && "text-muted-foreground",
          )}
        >
          {title || t("contentTrack.card.untitled")}
        </p>
        <SuperAgentIcon
          size={18}
          className={cn("shrink-0", working && "animate-pulse")}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {format && (
          <Badge variant="secondary" className="max-w-full truncate">
            {format}
          </Badge>
        )}
        {campaignName && (
          <Badge variant="outline" className="max-w-full truncate">
            {campaignName}
          </Badge>
        )}
        {working && (
          <Badge variant="brand">{t("contentTrack.card.working")}</Badge>
        )}
        {card.error && (
          <Badge variant="destructive">
            <AlertCircle />
            {t("contentTrack.card.stopped")}
          </Badge>
        )}
      </div>
    </button>
  );
}
