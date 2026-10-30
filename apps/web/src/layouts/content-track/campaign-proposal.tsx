/**
 * A developed campaign, read-only: why now, when, for what, aimed at which
 * slices of the store and products, with what words and what to avoid. Changes
 * go through the campaign's chat. Shared by the campaign page and a card's
 * Campaign phase.
 */

import {
  Calendar,
  LinkExternal01,
  SlashCircle01,
  Target04,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import {
  CAMPAIGN_OBJECTIVE_LABEL,
  CAMPAIGN_TARGET_KIND_LABEL,
  CAMPAIGN_TRIGGER_LABEL,
} from "@/components/sandbox/content/blog/campaign-labels";
import { useT } from "@/i18n/use-t.ts";
import { FrameLine, KeywordChips, Pending, Section } from "./detail-parts";
import { RoleAtWork } from "./newsroom";
import { ProductShelf } from "./product-shelf";

export function CampaignProposal({
  campaign,
  working,
}: {
  campaign: CampaignEntry;
  working: boolean;
}) {
  const t = useT();
  const developed =
    campaign.name.trim() !== "" && campaign.trigger.note.trim() !== "";

  if (!developed) {
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
      <section className="flex flex-col gap-2.5 rounded-[11px] border border-border bg-card p-4 text-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          {t("contentTrack.campaign.whyNow")} ·{" "}
          {t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type])}
        </span>
        <p className="text-[15px] leading-[1.5] text-foreground">
          {campaign.trigger.note}
        </p>
        <FrameLine
          icon={<Calendar size={13} />}
          label={t("contentTrack.campaign.period")}
        >
          {period || t("contentTrack.campaign.noPeriod")}
        </FrameLine>
        <FrameLine
          icon={<Target04 size={13} />}
          label={t("contentTrack.campaign.objective")}
        >
          {t(CAMPAIGN_OBJECTIVE_LABEL[campaign.intent.objective])}
        </FrameLine>
      </section>

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
