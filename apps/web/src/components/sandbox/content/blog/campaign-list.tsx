import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { CampaignEntry } from "./blog-data";
import { GoalLine } from "./campaign-goal";

/** The campaigns on offer, as cards — a name alone does not say what it is for. */
export function CampaignList({
  campaigns,
  chosen,
  onChoose,
}: {
  campaigns: CampaignEntry[];
  chosen: string;
  onChoose: (key: string) => void;
}) {
  const t = useT();
  return (
    <ul className="space-y-1.5">
      {campaigns.map((campaign) => (
        <li key={campaign.key}>
          <button
            type="button"
            onClick={() => onChoose(campaign.key)}
            className={cn(
              "w-full cursor-pointer rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/40",
              chosen === campaign.key && "border-primary",
            )}
          >
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                {campaign.name || t("sandbox.campaigns.untitled")}
              </p>
              <Badge variant="outline" size="sm" className="shrink-0">
                {campaign.intent.products.length > 0
                  ? t("sandbox.generatePost.campaignProducts", {
                      count: String(campaign.intent.products.length),
                    })
                  : t("sandbox.generatePost.campaignNoProducts")}
              </Badge>
            </div>
            <GoalLine goals={campaign.goals} className="mt-1" />
            {campaign.trigger.note && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {campaign.trigger.note}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
