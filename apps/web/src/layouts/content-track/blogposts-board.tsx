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
    <div className="flex min-h-[28rem] gap-3.5 overflow-x-auto pb-2">
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
              "flex w-[236px] shrink-0 flex-col rounded-xl transition-colors",
              dragOverLane === status &&
                "bg-primary/5 outline-dashed outline-1 outline-primary/40",
            )}
          >
            <header className="flex items-center gap-2 px-1 pb-2.5 text-[12.5px] font-semibold text-muted-foreground">
              <span className="truncate">{t(CARD_STATUS_LABEL[status])}</span>
              <span className="rounded-md bg-muted px-1.5 text-[11px] tabular-nums">
                {lane.length}
              </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pb-2">
              {lane.map((card) => (
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
              ))}
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
        "block w-full rounded-[11px] border border-border bg-card px-3 py-[11px] text-left shadow-[0_1px_1px_rgba(20,23,26,0.03)] transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-[0_2px_10px_rgba(20,23,26,0.07)]",
        working
          ? "cursor-pointer border-success shadow-[0_2px_10px_rgba(22,128,61,0.16)] ring-1 ring-success"
          : "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="mb-[7px] flex items-center gap-[7px]">
        <span className="size-[7px] shrink-0 rounded-full bg-success" />
        <span className="text-[11px] font-semibold tracking-[0.02em] text-muted-foreground">
          {t("contentTrack.card.kind")}
        </span>
      </div>
      <p
        className={cn(
          "mb-[9px] line-clamp-2 text-[13.5px] font-semibold leading-[1.35]",
          !title && "text-muted-foreground",
        )}
      >
        {title || t("contentTrack.card.untitled")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {format && (
          <span className="max-w-full truncate rounded-md border border-border bg-muted px-[7px] py-0.5 text-[11px] text-muted-foreground">
            {format}
          </span>
        )}
        {campaignName && (
          <span className="max-w-full truncate rounded-md border border-border bg-card px-[7px] py-0.5 text-[11px] text-muted-foreground">
            {campaignName}
          </span>
        )}
        {card.error && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-[7px] py-0.5 text-[11px] font-medium text-destructive">
            <AlertCircle size={12} />
            {t("contentTrack.card.stopped")}
          </span>
        )}
        <SuperAgentIcon
          size={18}
          className={cn("ml-auto shrink-0", working && "animate-pulse")}
        />
      </div>
    </button>
  );
}
