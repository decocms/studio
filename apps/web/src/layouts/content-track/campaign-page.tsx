/**
 * One campaign over the whole panel, the way a blogpost card opens: its
 * briefing, then the campaign its agent developed, and its properties. Read
 * only: changes go through the campaign's chat, and a person sets only its
 * goal and its status.
 */

import { useState } from "react";
import {
  Calendar,
  CheckCircle,
  Clock,
  File06,
  Flag05,
  MessageChatCircle,
  Stars02,
  Target04,
  Trash01,
} from "@untitledui/icons";
import type { BlogCard } from "@decocms/shared/blog-card";
import type {
  CampaignBriefing,
  CampaignGoal,
  CampaignStatus,
} from "@decocms/shared/blog-campaign";
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
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import { GoalDialog } from "@/components/sandbox/content/blog/campaign-goal";
import {
  CAMPAIGN_OBJECTIVE_LABEL,
  CAMPAIGN_PROGRESS_LABEL,
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_VARIANT,
  CAMPAIGN_TRIGGER_LABEL,
} from "@/components/sandbox/content/blog/campaign-labels";
import {
  type CampaignPagePhase,
  campaignAgentWorking,
  campaignIsDeveloped,
  campaignOwnerCard,
  campaignPagePhase,
  campaignProgress,
  linkedCards,
} from "@/components/sandbox/content/blog/campaign-model";
import { useCampaignActions } from "@/components/sandbox/content/blog/use-campaign-actions";
import { useOpenBlogChat } from "@/hooks/use-open-blog-chat";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useClockTick } from "@/lib/use-clock-tick";
import { useChatRunning } from "./use-chat-running";
import { CampaignProposal } from "./campaign-proposal";
import { BriefingPicker } from "./campaign-briefing";
import { cardTitle } from "./card-model";
import { Group, PhaseSteps, PropertiesPanel, Row } from "./detail-parts";

const PAGE_PHASES = ["briefing", "campaign"] as const;

const PAGE_PHASE_LABEL = {
  briefing: "contentTrack.campaign.phase.briefing",
  campaign: "contentTrack.campaign.phase.campaign",
} as const satisfies Record<CampaignPagePhase, TranslationKey>;

const APPROVED_STATUSES = ["active", "paused", "finished"] as const;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Where a goal opened at `index` is now: there if unchanged, else wherever its twin moved, else -1. */
export function currentGoalIndex(
  goals: readonly CampaignGoal[],
  opened: { index: number; goal: CampaignGoal },
): number {
  const same = (goal: CampaignGoal | undefined) =>
    JSON.stringify(goal) === JSON.stringify(opened.goal);
  if (same(goals[opened.index])) return opened.index;
  return goals.findIndex((goal) => same(goal));
}

export function CampaignPage({
  campaign,
  cards,
  removing,
  onClose,
  onOpenCard,
  onRemove,
}: {
  campaign: CampaignEntry;
  /** The organization's blogpost cards: the one shaping it, and the ones written for it. */
  cards: readonly BlogCard[];
  removing: boolean;
  onClose: () => void;
  onOpenCard: (cardId: string) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const now = useClockTick();
  const openChat = useOpenBlogChat();
  const { update, run } = useCampaignActions();
  const reached = campaignPagePhase(campaign);
  /** A step the person opened holds until the agent moves the campaign on. */
  const [pick, setPick] = useState<{
    phase: CampaignPagePhase;
    reached: CampaignPagePhase;
  } | null>(null);
  const phase = pick?.reached === reached ? pick.phase : reached;
  /**
   * The goal whose dialog is open, as it was when opened, or "new". The
   * campaign's agent can rewrite the list meanwhile, so a save finds the goal
   * again rather than trusting its old place.
   */
  const [editingGoal, setEditingGoal] = useState<
    { index: number; goal: CampaignGoal } | "new" | null
  >(null);
  const [adjusting, setAdjusting] = useState(false);
  const [askDelete, setAskDelete] = useState(false);

  const progress = campaignProgress(campaign, now);
  // The record says what the agent was asked; its chat says whether it is still at it.
  const chatBusy = useChatRunning(campaign.threadId, campaign.run?.requestedAt);
  const working = campaignAgentWorking(campaign, now) || chatBusy;
  const developed = campaignIsDeveloped(campaign);
  const owner = campaignOwnerCard(campaign, cards);
  const posts = linkedCards(campaign, cards);
  const draft = campaign.status === "draft";
  const crumb = campaign.name.trim() || t("contentTrack.campaign.untitled");
  const period = [campaign.period.start, campaign.period.end]
    .filter(Boolean)
    .join(" → ");
  const layout = { view: "campaigns" as const, campaign: campaign.id };

  const startAgent = (input: {
    briefing?: CampaignBriefing;
    message?: string;
  }) =>
    run.mutate(
      { campaignId: campaign.id, ...input },
      {
        onSuccess: (result) => openChat(result.threadId, layout),
        onError: (err) =>
          toast.error(
            t("contentTrack.campaign.runFailed", { error: message(err) }),
          ),
      },
    );

  const setStatus = (status: CampaignStatus) =>
    update.mutate(
      { id: campaign.id, patch: { status } },
      {
        onError: (err) =>
          toast.error(
            t("contentTrack.campaign.updateFailed", { error: message(err) }),
          ),
      },
    );

  /** The campaign's goals replaced by `goals`, closing the goal dialog once saved. */
  const saveGoals = (goals: CampaignGoal[]) =>
    update.mutate(
      { id: campaign.id, patch: { goals } },
      {
        onSuccess: () => setEditingGoal(null),
        onError: (err) =>
          toast.error(
            t("contentTrack.campaign.updateFailed", { error: message(err) }),
          ),
      },
    );

  return (
    <>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("contentTrack.title"), onSelect: onClose }}
        items={[{ key: campaign.id, label: crumb }]}
      />
      <Page.Actions>
        {owner && draft ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenCard(owner.id)}
          >
            <File06 size={14} />
            {t("contentTrack.campaign.continueInCard")}
          </Button>
        ) : campaign.threadId ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openChat(campaign.threadId, layout)}
          >
            <MessageChatCircle size={14} />
            {t("contentTrack.campaign.adjust")}
          </Button>
        ) : progress === "idle" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending || working}
            onClick={() => startAgent({})}
          >
            <Stars02 size={14} />
            {t("contentTrack.campaign.start")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdjusting(true)}
          >
            <MessageChatCircle size={14} />
            {t("contentTrack.campaign.adjust")}
          </Button>
        )}
        {draft && developed && (
          <Button
            variant="brand"
            size="sm"
            disabled={update.isPending || working}
            title={working ? t("contentTrack.card.agentBusy") : undefined}
            onClick={() => setStatus("active")}
          >
            <CheckCircle size={14} />
            {t("contentTrack.campaign.approve")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("contentTrack.campaign.delete")}
          disabled={removing}
          onClick={() => setAskDelete(true)}
        >
          <Trash01 size={14} />
        </Button>
      </Page.Actions>
      <Panel.Toolbar.Left.Portal>
        <PhaseSteps
          steps={PAGE_PHASES}
          labels={PAGE_PHASE_LABEL}
          phase={phase}
          reached={reached}
          onSelect={(next) => setPick({ phase: next, reached })}
        />
      </Panel.Toolbar.Left.Portal>

      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <header className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
              {t("contentTrack.campaign.eyebrow")}
              {progress !== "approved" &&
                ` · ${t(CAMPAIGN_PROGRESS_LABEL[progress])}`}
            </span>
            <h1 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
              {crumb}
            </h1>
          </header>
          {phase === "briefing" ? (
            <BriefingPicker
              campaign={campaign}
              working={working}
              disabled={working || run.isPending || !!owner || !draft}
              onChoose={(briefing) => startAgent({ briefing })}
            />
          ) : (
            <CampaignProposal
              campaign={campaign}
              working={working}
              onGoal={(at) =>
                setEditingGoal(
                  at === "new"
                    ? "new"
                    : campaign.goals[at]
                      ? { index: at, goal: campaign.goals[at] }
                      : null,
                )
              }
            />
          )}
        </div>
        <aside className="w-full shrink-0 lg:w-[264px]">
          <PropertiesPanel title={t("contentTrack.props.title")}>
            <Group>
              <Row icon={<Clock size={14} />}>
                {draft ? (
                  <Badge variant={CAMPAIGN_STATUS_VARIANT.draft}>
                    {t(CAMPAIGN_STATUS_LABEL.draft)}
                  </Badge>
                ) : (
                  <Select
                    value={campaign.status}
                    disabled={update.isPending}
                    onValueChange={(value) => {
                      const next = APPROVED_STATUSES.find(
                        (status) => status === value,
                      );
                      if (next) setStatus(next);
                    }}
                  >
                    <SelectTrigger className="h-7 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {APPROVED_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {t(CAMPAIGN_STATUS_LABEL[status])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Row>
              {developed && (
                <>
                  <Row icon={<Flag05 size={14} />}>
                    {t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type])}
                  </Row>
                  <Row icon={<Target04 size={14} />}>
                    {t(CAMPAIGN_OBJECTIVE_LABEL[campaign.intent.objective])}
                  </Row>
                  <Row icon={<Calendar size={14} />}>
                    {period || t("contentTrack.campaign.noPeriod")}
                  </Row>
                </>
              )}
            </Group>
            {owner && (
              <Group caption={t("contentTrack.campaign.bornIn")}>
                <button
                  type="button"
                  className="truncate text-left text-[13px] text-foreground hover:underline"
                  onClick={() => onOpenCard(owner.id)}
                >
                  {cardTitle(owner) || t("contentTrack.card.untitled")}
                </button>
              </Group>
            )}
            <Group caption={t("contentTrack.campaign.posts")}>
              <span className="text-[13px] text-foreground">
                {t("contentTrack.campaign.postCount", { count: posts.length })}
              </span>
            </Group>
          </PropertiesPanel>
        </aside>
      </div>

      {editingGoal !== null && (
        <GoalDialog
          goal={editingGoal === "new" ? null : editingGoal.goal}
          pending={update.isPending}
          onClose={() => setEditingGoal(null)}
          onSave={(goal) => {
            if (editingGoal === "new") {
              saveGoals([...campaign.goals, goal]);
              return;
            }
            const at = currentGoalIndex(campaign.goals, editingGoal);
            if (at === -1) {
              toast.error(t("contentTrack.campaign.goalChanged"));
              setEditingGoal(null);
              return;
            }
            saveGoals(
              campaign.goals.map((each, index) => (index === at ? goal : each)),
            );
          }}
          onDelete={
            editingGoal === "new"
              ? undefined
              : () => {
                  const at = currentGoalIndex(campaign.goals, editingGoal);
                  if (at === -1) {
                    toast.error(t("contentTrack.campaign.goalChanged"));
                    setEditingGoal(null);
                    return;
                  }
                  saveGoals(campaign.goals.filter((_, index) => index !== at));
                }
          }
        />
      )}
      {adjusting && (
        <AdjustDialog
          pending={run.isPending || working}
          onClose={() => setAdjusting(false)}
          onSend={(text) => {
            setAdjusting(false);
            startAgent({ message: text });
          }}
        />
      )}
      <AlertDialog open={askDelete} onOpenChange={setAskDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("contentTrack.campaign.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("contentTrack.campaign.deleteDescription", {
                count: posts.length,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("contentTrack.new.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onRemove}>
              {t("contentTrack.campaign.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What to tell the agent, for a campaign that has no chat yet. Mounted only while open. */
function AdjustDialog({
  pending,
  onClose,
  onSend,
}: {
  pending: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("contentTrack.campaign.adjustTitle")}</DialogTitle>
        </DialogHeader>
        <Textarea
          value={text}
          rows={4}
          maxLength={4_000}
          placeholder={t("contentTrack.campaign.adjustPlaceholder")}
          onChange={(e) => setText(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("contentTrack.new.cancel")}
          </Button>
          <Button
            disabled={pending || text.trim() === ""}
            onClick={() => onSend(text.trim())}
          >
            {t("contentTrack.campaign.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
