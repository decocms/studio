/**
 * A campaign before it is developed: what the store's systems said, the
 * briefings its agent suggested as cards to pick, and room to write one's own.
 * Shared by the campaign page and a card's Campaign phase.
 */

import { useState } from "react";
import { Check, Edit05, Stars02 } from "@untitledui/icons";
import type { CampaignBriefing } from "@decocms/shared/blog-campaign";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import { useT } from "@/i18n/use-t.ts";
import { Pending, Section } from "./detail-parts";
import { EvidenceBySource, EvidenceSourceIcon } from "./evidence-grid";
import { ExpandableGrid } from "./expandable-grid";
import { RoleAtWork } from "./newsroom";

export function BriefingPicker({
  campaign,
  working,
  disabled,
  onChoose,
}: {
  campaign: CampaignEntry;
  working: boolean;
  /** Choosing is off: the agent is at work, a choice is being sent, or it is chosen elsewhere. */
  disabled: boolean;
  onChoose: (briefing: CampaignBriefing) => void;
}) {
  const t = useT();
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");

  if (campaign.evidence.length === 0 && campaign.briefings.length === 0) {
    return working ? (
      <Pending>
        <RoleAtWork
          role="researcher"
          activity={t("contentTrack.campaign.progress.researching")}
        />
      </Pending>
    ) : (
      <p className="text-sm text-muted-foreground">
        {t("contentTrack.campaign.noBriefings")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {campaign.evidence.length > 0 && (
        <Section title={t("contentTrack.campaign.evidence")}>
          <EvidenceBySource evidence={campaign.evidence} />
        </Section>
      )}

      <Section title={t("contentTrack.campaign.briefings")}>
        <p className="text-xs text-muted-foreground">
          {t("contentTrack.campaign.briefingsHint")}
        </p>
        {campaign.briefings.length === 0 && working ? (
          <Pending>
            <RoleAtWork
              role="strategist"
              activity={t("contentTrack.campaign.progress.suggesting")}
            />
          </Pending>
        ) : (
          <ExpandableGrid
            columns={3}
            items={campaign.briefings.map((option) => {
              const chosen = campaign.briefing?.optionId === option.id;
              return {
                id: option.id,
                selected: chosen,
                summary: (open: boolean) => (
                  <div className="flex flex-col gap-2">
                    <span
                      className={cn(
                        "text-[13.5px] font-semibold leading-snug text-foreground",
                        !open && "line-clamp-2",
                      )}
                    >
                      {option.title}
                    </span>
                    {!open && (
                      <p className="line-clamp-2 text-xs leading-[1.45] text-muted-foreground">
                        {option.idea}
                      </p>
                    )}
                    {option.figure && (
                      <span className="flex items-center gap-[7px] text-[12.5px] font-semibold text-foreground tabular-nums">
                        {option.source && (
                          <EvidenceSourceIcon source={option.source} />
                        )}
                        {option.figure}
                      </span>
                    )}
                    {chosen && (
                      <Badge variant="brand" className="self-start">
                        <Check size={12} />
                        {t("contentTrack.campaign.chosen")}
                      </Badge>
                    )}
                  </div>
                ),
                detail: (
                  <div className="flex flex-col gap-3">
                    <p className="text-[13px] leading-[1.5] text-foreground">
                      {option.idea}
                    </p>
                    {!chosen && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="self-start"
                        disabled={disabled}
                        onClick={() =>
                          onChoose({
                            text: `${option.title}\n\n${option.idea}`,
                            optionId: option.id,
                          })
                        }
                      >
                        <Stars02 size={14} />
                        {t("contentTrack.campaign.useBriefing")}
                      </Button>
                    )}
                  </div>
                ),
              };
            })}
          />
        )}
      </Section>

      {campaign.briefing && !campaign.briefing.optionId && (
        <Section title={t("contentTrack.campaign.ownBriefing")}>
          <p className="whitespace-pre-line rounded-[11px] border border-primary bg-card p-3 text-[13px] text-foreground">
            {campaign.briefing.text}
          </p>
        </Section>
      )}

      {writing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={own}
            rows={4}
            maxLength={2_000}
            placeholder={t("contentTrack.campaign.writeOwnPlaceholder")}
            onChange={(e) => setOwn(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || own.trim() === ""}
              onClick={() => onChoose({ text: own.trim() })}
            >
              {t("contentTrack.campaign.develop")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setWriting(false)}
            >
              {t("contentTrack.new.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={disabled}
          onClick={() => setWriting(true)}
        >
          <Edit05 size={14} />
          {t("contentTrack.campaign.writeOwn")}
        </Button>
      )}
    </div>
  );
}
