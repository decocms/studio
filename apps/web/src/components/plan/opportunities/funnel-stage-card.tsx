/**
 * One funnel stage on the store tab: how many people reach the page a week,
 * how many move on, and the biggest loss measured there. Picking it opens the
 * page below.
 */

import { Trophy01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { ADVANCE_LABEL, PAGE_LABEL } from "./labels.ts";
import {
  formatMoney,
  formatPercent,
  type StageCard,
} from "./opportunity-view.ts";

function StageBadge({ card }: { card: StageCard }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const value =
    card.at_stake !== null ? formatMoney(card.at_stake, language) : null;
  switch (card.badge) {
    case "running":
      return (
        <Badge variant="muted">
          <Spinner size="2xs" />
          {t("plan.opportunities.store.badge.running")}
        </Badge>
      );
    case "top":
      return (
        <Badge variant="lime">
          <Trophy01 />
          {value
            ? t("plan.opportunities.store.badge.top", { value })
            : t("plan.opportunities.store.badge.topPlain")}
        </Badge>
      );
    case "second":
      return (
        <Badge variant="muted">
          {value
            ? t("plan.opportunities.store.badge.second", { value })
            : t("plan.opportunities.store.badge.secondPlain")}
        </Badge>
      );
    case "at_stake":
      return value ? (
        <Badge variant="muted">
          {t("plan.opportunities.store.badge.atStake", { value })}
        </Badge>
      ) : null;
    case null:
      return null;
  }
}

export function FunnelStageCard({
  card,
  selected,
  onSelect,
}: {
  card: StageCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const people =
    card.people_week !== null
      ? new Intl.NumberFormat(language, {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(card.people_week)
      : null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-40 flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-ring",
        selected && "border-foreground ring-1 ring-foreground",
      )}
    >
      <span className="text-sm font-medium text-foreground">
        {t(PAGE_LABEL[card.page_type])}
      </span>
      {!card.analysed ? (
        <span className="text-sm text-muted-foreground">
          {t("plan.opportunities.store.notAnalysed")}
        </span>
      ) : people === null ? (
        <span className="text-sm text-muted-foreground">
          {t("plan.opportunities.store.noFunnel")}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">
          {t("plan.opportunities.store.people", { count: people })}
        </span>
      )}
      {card.advance_rate !== null && (
        <>
          <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-brand-purple"
              style={{
                width: `${Math.min(100, Math.max(0, card.advance_rate * 100))}%`,
              }}
            />
          </span>
          <span className="text-sm text-muted-foreground">
            {t(ADVANCE_LABEL[card.page_type], {
              rate: formatPercent(card.advance_rate, language),
            })}
          </span>
        </>
      )}
      <span className="mt-auto pt-2">
        <StageBadge card={card} />
      </span>
    </button>
  );
}
