/**
 * The verdict: what the case is worth in one sentence, and the three numbers
 * behind it. Every number comes from the case's math; a tile with nothing to
 * show waits while the case is building and is gone once it is ready.
 */

import type { BusinessCase } from "@decocms/shared/business-case";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { File06 } from "@untitledui/icons";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { useCaseFormat } from "./case-format.ts";
import type { CaseStory, HeroKey, HeroTile } from "./case-story.ts";

const STATUS: Record<BusinessCase["status"], TranslationKey> = {
  framing: "plan.case.status.framing",
  building: "plan.case.status.building",
  ready: "plan.case.status.ready",
};

const AREA: Record<BusinessCase["request"]["area"], TranslationKey> = {
  pdp: "plan.case.area.pdp",
  search: "plan.case.area.search",
  category: "plan.case.area.category",
  home: "plan.case.area.home",
  cart: "plan.case.area.cart",
  checkout: "plan.case.area.checkout",
  shipping: "plan.case.area.shipping",
  performance: "plan.case.area.performance",
  "paid-media": "plan.case.area.paidMedia",
  other: "plan.case.area.other",
};

const TILE_LABEL: Record<HeroKey, TranslationKey> = {
  money: "plan.case.card.money",
  effort: "plan.case.tile.effort",
  abTest: "plan.case.tile.abTest",
};

function Thesis({ value, story }: { value: BusinessCase; story: CaseStory }) {
  const t = useT();
  const format = useCaseFormat();

  if (story.money) {
    return (
      <p className="text-2xl leading-snug font-medium tracking-tight text-balance text-foreground @2xl:text-[1.75rem]">
        {t("plan.case.thesis.lead", { title: value.title })}{" "}
        <span className="font-semibold whitespace-nowrap shadow-[inset_0_-0.4em_0_0_color-mix(in_oklab,var(--success)_18%,transparent)]">
          {t("plan.case.thesis.money", {
            money: format.money(story.money.monthlyValue),
          })}
        </span>
        {t("plan.case.thesis.tail")}
      </p>
    );
  }
  return (
    <p className="text-2xl leading-snug font-medium tracking-tight text-balance text-foreground @2xl:text-[1.75rem]">
      {value.title}
      {value.status !== "ready" && (
        <span className="text-muted-foreground/70">
          {" "}
          {t("plan.case.thesis.pending")}
        </span>
      )}
    </p>
  );
}

type WaitingTile = Extract<HeroTile, { state: "asking" | "later" }>;

function isWaiting(tile: HeroTile): tile is WaitingTile {
  return tile.state === "asking" || tile.state === "later";
}

function TileValue({ tile }: { tile: HeroTile }) {
  const t = useT();
  const format = useCaseFormat();

  if (isWaiting(tile)) {
    return (
      <>
        <div className="mt-1 text-3xl font-semibold text-muted-foreground/40">
          —
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {tile.state === "asking" && (
            <span className="size-1.5 rounded-full bg-special motion-safe:animate-pulse" />
          )}
          {t(
            tile.state === "asking"
              ? "plan.case.tile.calculating"
              : "plan.case.tile.later",
          )}
        </div>
      </>
    );
  }

  if (tile.key === "money") {
    return (
      <>
        <div className="mt-1 text-3xl font-semibold tracking-tight text-success tabular-nums">
          +{format.money(tile.monthly)}
          <span className="text-base font-medium text-muted-foreground">
            {t("plan.case.tile.perMonth")}
          </span>
        </div>
        {tile.ceiling !== null && tile.ceiling > 0 && (
          <>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("plan.case.tile.ceiling", {
                ceiling: format.money(tile.ceiling),
              })}
            </div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-foreground/5">
              <div
                className="h-full rounded-full bg-success transition-[width] duration-700"
                style={{
                  width: `${Math.max(3, Math.min(100, (tile.monthly / tile.ceiling) * 100))}%`,
                }}
              />
            </div>
          </>
        )}
      </>
    );
  }

  if (tile.key === "effort") {
    return (
      <div className="mt-1 text-3xl font-semibold tracking-tight text-foreground tabular-nums">
        {format.days(tile.days)}
      </div>
    );
  }

  if (tile.state === "unmeasurable") {
    return (
      <>
        <div className="mt-1 text-2xl font-semibold tracking-tight text-warning">
          {t("plan.case.tile.unmeasurable")}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t("plan.case.tile.unmeasurableCaption")}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mt-1 text-3xl font-semibold tracking-tight text-foreground tabular-nums">
        {t(tile.weeks === 1 ? "plan.case.weeks.one" : "plan.case.weeks.other", {
          count: tile.weeks,
        })}
      </div>
      {tile.nPerGroup !== null && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("plan.case.tile.perGroup", {
            count: format.compact(tile.nPerGroup),
          })}
        </div>
      )}
    </>
  );
}

function Tile({ tile }: { tile: HeroTile }) {
  const t = useT();
  const waiting = isWaiting(tile);
  return (
    <div
      className={cn(
        "rounded-xl p-4 transition-colors duration-500",
        waiting ? "border border-dashed" : "bg-muted",
      )}
    >
      <div className="text-xs text-muted-foreground">
        {t(TILE_LABEL[tile.key])}
      </div>
      <TileValue tile={tile} />
    </div>
  );
}

export function CaseHero({
  value,
  story,
  invalid,
  onOpenDocument,
}: {
  value: BusinessCase;
  story: CaseStory;
  invalid?: boolean;
  onOpenDocument?: (documentPath: string) => void;
}) {
  const t = useT();
  const open = story.openQuestions.length;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-6 @2xl:p-8">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <span>{t("page.businessCase")}</span>
        <Badge variant={value.status === "ready" ? "success" : "agent"}>
          {t(STATUS[value.status])}
        </Badge>
        {open > 0 && (
          <Badge variant="warning">
            {t(
              open === 1
                ? "plan.case.openQuestions.one"
                : "plan.case.openQuestions.other",
              { count: open },
            )}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          {value.request.area !== "other" && (
            <Badge variant="muted">{t(AREA[value.request.area])}</Badge>
          )}
          {value.documentPath && onOpenDocument && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenDocument(value.documentPath ?? "")}
            >
              <File06 />
              {t("plan.case.openDocument")}
            </Button>
          )}
        </span>
      </div>

      <Thesis value={value} story={story} />

      {story.tiles.length > 0 && (
        <div className="grid gap-3 @xl:grid-cols-3">
          {story.tiles.map((tile) => (
            <Tile key={tile.key} tile={tile} />
          ))}
        </div>
      )}

      {invalid && (
        <p className="text-xs text-muted-foreground">
          {t("plan.case.invalid")}
        </p>
      )}
    </section>
  );
}
