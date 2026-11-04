/**
 * A blogpost card's Campaign phase: the campaign the post is written for. The
 * person links a ready one, or the card's agent shapes a new one in the card's
 * chat — briefings first, then the campaign — which the person approves here.
 */

import { useState } from "react";
import { LinkExternal01, Stars02, SwitchHorizontal01 } from "@untitledui/icons";
import type { BlogCard } from "@decocms/shared/blog-card";
import type { CampaignBriefing } from "@decocms/shared/blog-campaign";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import { CampaignList } from "@/components/sandbox/content/blog/campaign-list";
import { campaignIsDeveloped } from "@/components/sandbox/content/blog/campaign-model";
import { useT } from "@/i18n/use-t.ts";
import { BriefingPicker } from "./campaign-briefing";
import { CampaignProposal } from "./campaign-proposal";
import { cardCampaignState } from "./card-model";
import { Section } from "./detail-parts";

export function CampaignPhase({
  card,
  campaign,
  ready,
  working,
  pending,
  onLink,
  onShape,
  onOpenCampaign,
}: {
  card: BlogCard;
  /** The card's campaign, when it links one that exists. */
  campaign: CampaignEntry | undefined;
  /** The approved campaigns a post can be written for. */
  ready: CampaignEntry[];
  /** The card's agent is shaping its campaign now. */
  working: boolean;
  /** A run start or a link is in flight. */
  pending: boolean;
  onLink: (campaignId: string) => void;
  /** Start the card's agent on its campaign, developing a briefing when one is given. */
  onShape: (briefing?: CampaignBriefing) => void;
  onOpenCampaign: (campaignId: string) => void;
}) {
  const t = useT();
  const state = cardCampaignState(card, campaign);
  const [switching, setSwitching] = useState(false);
  /** A campaign picked over the draft this card shapes, waiting for the discard to be confirmed. */
  const [replacing, setReplacing] = useState<string | null>(null);
  const editable =
    card.status === "ideas" && !card.hypothesis?.statement?.trim();

  const link = (key: string) => {
    const picked = ready.find((entry) => entry.key === key);
    if (!picked) return;
    if (state === "shaping") {
      setReplacing(picked.id);
      return;
    }
    setSwitching(false);
    onLink(picked.id);
  };

  if (!campaign || state === "none" || switching) {
    const others = ready.filter((entry) => entry.id !== campaign?.id);
    return (
      <div className="flex flex-col gap-6">
        <Section title={t("contentTrack.card.campaignPhase.chooseTitle")}>
          <p className="text-xs text-muted-foreground">
            {t("contentTrack.card.campaignPhase.chooseHint")}
          </p>
          {others.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              {t("contentTrack.card.campaignPhase.noReady")}
            </p>
          ) : (
            <CampaignList campaigns={others} chosen="" onChoose={link} />
          )}
        </Section>
        {state === "none" && (
          <div className="flex flex-col gap-2 rounded-[11px] border border-dashed border-border p-4">
            <span className="text-[13.5px] font-semibold text-foreground">
              {t("contentTrack.card.campaignPhase.createWithAgent")}
            </span>
            <p className="text-xs text-muted-foreground">
              {t("contentTrack.card.campaignPhase.createWithAgentHint")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              disabled={pending || card.status !== "ideas"}
              onClick={() => onShape()}
            >
              <Stars02 size={14} />
              {t("contentTrack.card.campaignPhase.createWithAgent")}
            </Button>
          </div>
        )}
        {switching && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => setSwitching(false)}
          >
            {t("contentTrack.new.cancel")}
          </Button>
        )}
        <AlertDialog
          open={!!replacing}
          onOpenChange={(open) => {
            if (!open) setReplacing(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("contentTrack.card.campaignPhase.switchTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("contentTrack.card.campaignPhase.switchDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("contentTrack.new.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (replacing) onLink(replacing);
                  setReplacing(null);
                  setSwitching(false);
                }}
              >
                {t("contentTrack.card.campaignPhase.switchConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {state === "shaping" && !campaignIsDeveloped(campaign) ? (
        <BriefingPicker
          campaign={campaign}
          working={working}
          disabled={working || pending}
          onChoose={onShape}
        />
      ) : (
        <CampaignProposal campaign={campaign} working={working} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onOpenCampaign(campaign.id)}
        >
          <LinkExternal01 size={14} />
          {t("contentTrack.card.campaignPhase.openCampaign")}
        </Button>
        {editable && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={working || pending}
            onClick={() => setSwitching(true)}
          >
            <SwitchHorizontal01 size={14} />
            {t("contentTrack.card.campaignPhase.switch")}
          </Button>
        )}
      </div>
    </div>
  );
}
