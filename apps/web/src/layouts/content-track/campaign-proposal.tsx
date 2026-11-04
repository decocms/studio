/**
 * A developed campaign, read-only: why now, when, for what, aimed at which
 * slices of the store and products, with what words and what to avoid. Changes
 * go through the campaign's chat. Shared by the campaign page and a card's
 * Campaign phase.
 */

import {
  Calendar,
  LinkExternal01,
  Plus,
  SlashCircle01,
} from "@untitledui/icons";
import { MAX_CAMPAIGN_GOALS } from "@decocms/shared/blog-campaign";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import { campaignIsDeveloped } from "@/components/sandbox/content/blog/campaign-model";
import {
  CAMPAIGN_OBJECTIVE_LABEL,
  CAMPAIGN_TARGET_KIND_LABEL,
  CAMPAIGN_TRIGGER_LABEL,
} from "@/components/sandbox/content/blog/campaign-labels";
import { useT } from "@/i18n/use-t.ts";
import { FrameLine, KeywordChips, Pending, Section } from "./detail-parts";
import { ExpandableGrid } from "./expandable-grid";
import { RoleAtWork } from "./newsroom";
import { ProductShelf } from "./product-shelf";
import { goalNodes, goalsHint, WhereItSits } from "./where-it-sits";

/** A brief longer than this can be cut at three lines, so the card opens to show it whole. */
const SHORT_NOTE = 140;

export function CampaignProposal({
  campaign,
  working,
  onGoal,
}: {
  campaign: CampaignEntry;
  working: boolean;
  /** Opens one of its goals, or "new" to add one, in the goal's dialog. Without it, as inside a blog card, the goals are only shown. */
  onGoal?: (goal: number | "new") => void;
}) {
  const t = useT();
  if (campaign.status === "draft" && !campaignIsDeveloped(campaign)) {
    return working ? (
      <Pending>
        <RoleAtWork
          role="strategist"
          activity={t("contentTrack.campaign.progress.developing")}
        />
      </Pending>
    ) : (
      <p className="text-sm text-muted-foreground">
        {t("contentTrack.campaign.notDeveloped")}
      </p>
    );
  }

  const period = [campaign.period.start, campaign.period.end]
    .filter(Boolean)
    .join(" → ");
  const { targets, products, keywords } = campaign.intent;
  const { avoidComplements, toneOverrides } = campaign.guardrails;

  return (
    <div className="flex flex-col gap-6">
      <ExpandableGrid
        columns={1}
        items={[
          {
            id: "why-now",
            detail: null,
            opens: campaign.trigger.note.length > SHORT_NOTE,
            summary: (open) => (
              <div className="flex flex-col gap-2.5 text-[13px]">
                <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                  {t("contentTrack.campaign.whyNow")} ·{" "}
                  {t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type])}
                </span>
                {campaign.trigger.note && (
                  <p
                    className={cn(
                      "text-[13.5px] leading-[1.55] text-foreground",
                      !open && "line-clamp-3",
                    )}
                  >
                    {campaign.trigger.note}
                  </p>
                )}
                <FrameLine
                  icon={<Calendar size={13} />}
                  label={t("contentTrack.campaign.period")}
                >
                  {period || t("contentTrack.campaign.noPeriod")}
                </FrameLine>
              </div>
            ),
          },
        ]}
      />

      <WhereItSits
        title={t("contentTrack.sits.campaignTitle")}
        hint={goalsHint(campaign.goals.length, t)}
        nodes={goalNodes(campaign.goals, t, onGoal, {
          title: t("contentTrack.sits.noGoals"),
          onOpen: onGoal && (() => onGoal("new")),
        })}
        action={
          onGoal &&
          campaign.goals.length > 0 &&
          campaign.goals.length < MAX_CAMPAIGN_GOALS ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-1"
              onClick={() => onGoal("new")}
            >
              <Plus size={14} />
              {t("contentTrack.campaign.addGoal")}
            </Button>
          ) : undefined
        }
        here={{
          kind: "campaign",
          label: t("contentTrack.sits.thisCampaign"),
          meta: [
            t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type]),
            t(CAMPAIGN_OBJECTIVE_LABEL[campaign.intent.objective]),
          ],
        }}
      />

      {targets.length > 0 && (
        <Section title={t("contentTrack.campaign.targets")}>
          <ul className="flex flex-col gap-[9px]">
            {targets.map((target) => (
              <li
                key={`${target.kind}:${target.id || target.name}`}
                className="flex items-start gap-[9px] text-[13px]"
              >
                <Badge variant="outline" size="sm" className="shrink-0">
                  {t(CAMPAIGN_TARGET_KIND_LABEL[target.kind])}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">
                    {target.name}
                  </span>
                  {target.description && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {target.description}
                    </span>
                  )}
                </span>
                {target.url && (
                  <a
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <LinkExternal01 size={13} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {products.length > 0 && (
        <ProductShelf
          title={t("contentTrack.campaign.products")}
          products={products}
        />
      )}

      {keywords.length > 0 && (
        <Section title={t("contentTrack.campaign.keywords")}>
          <KeywordChips keywords={keywords.map((term) => ({ term }))} />
        </Section>
      )}

      {(avoidComplements.length > 0 || toneOverrides.trim() !== "") && (
        <Section title={t("contentTrack.campaign.guardrails")}>
          <ul className="flex flex-col gap-[9px]">
            {avoidComplements.map((rule) => (
              <li
                key={rule.name}
                className="flex items-start gap-[9px] text-[13px] text-foreground"
              >
                <SlashCircle01
                  size={14}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{rule.name}</span>
                  {rule.value && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {rule.value}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {toneOverrides.trim() !== "" && (
            <p className="text-[13px] text-muted-foreground">
              <span className="font-semibold text-foreground">
                {t("contentTrack.campaign.tone")}
              </span>{" "}
              {toneOverrides}
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
