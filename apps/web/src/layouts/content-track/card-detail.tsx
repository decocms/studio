/**
 * One blogpost card, over the whole panel: its campaign, its hypothesis, the
 * post as it fills in, and its properties. A panel rather than a sheet because a sheet is
 * modal, and the card's chat has to stay usable beside it.
 *
 * Nothing here streams or mounts a chat: the card's agent writes the card, and
 * the card arrives through the board's own subscription.
 */

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Eye,
  File06,
  Flag05,
  GitBranch01,
  Globe01,
  LinkExternal01,
  MessageChatCircle,
  SlashCircle01,
  Tag01,
} from "@untitledui/icons";
import {
  BLOG_CARD_STAGES,
  BLOG_CARD_STATUSES,
  type BlogCard,
  type BlogCardStatus,
} from "@decocms/shared/blog-card";
import type { CampaignBriefing } from "@decocms/shared/blog-campaign";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "@decocms/ui/components/tabs.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import {
  CAMPAIGN_OBJECTIVE_LABEL,
  CAMPAIGN_TRIGGER_LABEL,
} from "@/components/sandbox/content/blog/campaign-labels";
import {
  campaignAgentWorking,
  campaignIsDeveloped,
} from "@/components/sandbox/content/blog/campaign-model";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { CompareFrame } from "@/components/thread/repository/cms-publish-compare";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useClockTick } from "@/lib/use-clock-tick";
import { CARD_STATUS_LABEL } from "./blogposts-board";
import { CampaignPhase } from "./card-campaign-phase";
import { type CardPatch, CardPublishing } from "./card-publishing";
import {
  type CardPhase,
  cardAgentWorking,
  cardCampaignState,
  cardTitle,
  defaultPhase,
  imageReady,
  stageDone,
} from "./card-model";
import {
  Group,
  KeywordChips,
  Pending,
  PhaseSteps,
  PropertiesPanel,
  Row,
  Section,
} from "./detail-parts";
import { EvidenceBySource } from "./evidence-grid";
import { RoleAtWork, RoleAvatar } from "./newsroom";
import { PostBody } from "./post-body";
import {
  type CardPreview,
  type CardPreviewGap,
  useCardPreview,
} from "./use-card-preview";
import { useOpenCardEditor } from "./use-open-card-editor";
import { goalNodes, type SitsNode, WhereItSits } from "./where-it-sits";

const PHASES = ["campaign", "hypothesis", "execute", "monitor"] as const;

const PHASE_LABEL = {
  campaign: "contentTrack.phase.campaign",
  hypothesis: "contentTrack.phase.hypothesis",
  execute: "contentTrack.phase.execute",
  monitor: "contentTrack.phase.monitor",
} as const satisfies Record<CardPhase, TranslationKey>;

const STAGE_LABEL = {
  grounding: "contentTrack.card.stage.grounding",
  drafting: "contentTrack.card.stage.drafting",
  illustrating: "contentTrack.card.stage.illustrating",
  assembling: "contentTrack.card.stage.assembling",
  writing: "contentTrack.card.stage.writing",
  reviewing: "contentTrack.card.stage.reviewing",
} as const satisfies Record<
  Exclude<(typeof BLOG_CARD_STAGES)[number], "done">,
  TranslationKey
>;

export function CardDetail({
  card,
  campaign,
  ready,
  site,
  executing,
  onClose,
  onOpenChat,
  onRun,
  onShape,
  onLink,
  onApproveCampaign,
  onOpenCampaign,
  onMove,
  onUpdate,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  /** The approved campaigns the post can be written for. */
  ready: CampaignEntry[];
  /** The site the post is written for; undefined while projects load. */
  site: VirtualMCPEntity | undefined;
  /** A run start or a campaign write is in flight. */
  executing: boolean;
  onClose: () => void;
  onOpenChat: () => void;
  onRun: (phase: "hypothesis" | "execute") => void;
  onShape: (briefing?: CampaignBriefing) => void;
  onLink: (campaignId: string) => void;
  /** Approve the campaign the card's agent shaped, then bring the hypothesis. */
  onApproveCampaign: () => void;
  onOpenCampaign: (campaignId: string) => void;
  onMove: (status: BlogCardStatus) => void;
  /** A person's write on the card: its publishing fields follow the post. */
  onUpdate: (patch: CardPatch) => Promise<unknown>;
}) {
  const t = useT();
  const now = useClockTick();
  const reached = defaultPhase(card, campaign);
  /** A step the person opened holds until the card moves on. */
  const [pick, setPick] = useState<{
    phase: CardPhase;
    reached: CardPhase;
  } | null>(null);
  const phase = pick?.reached === reached ? pick.phase : reached;
  const open = (next: CardPhase) => setPick({ phase: next, reached });
  const preview = useCardPreview(card, site);
  const working = cardAgentWorking(card, now);
  const shaping = cardCampaignState(card, campaign) === "shaping";
  const campaignWorking =
    shaping && !!campaign && campaignAgentWorking(campaign, now);
  const crumb = cardTitle(card) || t("contentTrack.card.untitled");
  const title =
    (phase === "campaign"
      ? campaign?.name
      : phase === "hypothesis"
        ? card.hypothesis?.title
        : card.post?.title) || crumb;
  const hasThesis = !!card.hypothesis?.statement?.trim();
  const canBring =
    card.status === "ideas" &&
    !hasThesis &&
    !working &&
    !!campaign &&
    campaign.status !== "draft";
  const canApprove =
    card.status === "ideas" && hasThesis && !!card.campaignId && !working;
  const canApproveCampaign =
    card.status === "ideas" &&
    shaping &&
    !!campaign &&
    campaignIsDeveloped(campaign) &&
    !campaignWorking;
  const sections = card.post?.sections?.length ?? 0;
  // The Campaign phase is titled with the campaign's name, which is not the post's.
  const meta =
    phase === "campaign"
      ? []
      : [
          t("contentTrack.card.kind"),
          card.hypothesis?.format?.name,
          sections > 0
            ? t("contentTrack.card.sectionCount", { count: sections })
            : undefined,
        ].filter(Boolean);

  return (
    <>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("contentTrack.title"), onSelect: onClose }}
        items={[{ key: card.id, label: crumb }]}
      />
      <Page.Actions>
        {card.threadId && (
          <Button variant="outline" size="sm" onClick={onOpenChat}>
            <MessageChatCircle size={16} />
            {t("contentTrack.card.adjust")}
          </Button>
        )}
        {canApproveCampaign && (
          <Button
            variant="brand"
            size="sm"
            disabled={executing}
            onClick={() => {
              onApproveCampaign();
              open("hypothesis");
            }}
          >
            {t("contentTrack.card.campaignPhase.approveAndBring")}
          </Button>
        )}
        {canBring && (
          <Button
            variant="brand"
            size="sm"
            disabled={executing}
            onClick={() => onRun("hypothesis")}
          >
            {t("contentTrack.card.bring")}
          </Button>
        )}
        {canApprove && (
          <Button
            variant="brand"
            size="sm"
            disabled={executing}
            onClick={() => {
              onRun("execute");
              open("execute");
            }}
          >
            {t("contentTrack.card.approve")}
          </Button>
        )}
      </Page.Actions>
      <Panel.Toolbar.Left.Portal>
        <PhaseSteps
          steps={PHASES}
          labels={PHASE_LABEL}
          phase={phase}
          reached={reached}
          onSelect={open}
        />
      </Panel.Toolbar.Left.Portal>
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
                {title}
              </h1>
              {meta.length > 0 && (
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {meta.join(" · ")}
                </p>
              )}
            </div>
            {card.postKey && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1 shrink-0"
                disabled={!preview.url}
                onClick={() => {
                  if (preview.url) {
                    window.open(preview.url, "_blank", "noopener,noreferrer");
                  }
                }}
              >
                <Eye size={14} />
                {t("contentTrack.card.seePreview")}
                <LinkExternal01 size={14} />
              </Button>
            )}
          </header>
          {card.error && (
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{card.error}</span>
            </div>
          )}
          {phase === "campaign" ? (
            <CampaignPhase
              card={card}
              campaign={campaign}
              ready={ready}
              working={campaignWorking}
              pending={executing}
              onLink={onLink}
              onShape={onShape}
              onOpenCampaign={onOpenCampaign}
            />
          ) : phase === "hypothesis" ? (
            <HypothesisPhase
              card={card}
              campaign={campaign}
              working={working}
              onOpenCampaign={onOpenCampaign}
            />
          ) : phase === "execute" ? (
            <ExecutePhase
              card={card}
              campaign={campaign}
              working={working}
              preview={preview}
            />
          ) : (
            <EmptyState
              image={null}
              title={t("contentTrack.card.monitorTitle")}
              description={t("contentTrack.card.monitorDescription")}
            />
          )}
        </div>
        <aside className="w-full shrink-0 lg:w-[264px]">
          <Properties
            card={card}
            campaign={campaign}
            site={site}
            working={working || campaignWorking}
            onMove={onMove}
            onOpenCampaign={onOpenCampaign}
            onUpdate={onUpdate}
          />
        </aside>
      </div>
    </>
  );
}

function HypothesisPhase({
  card,
  campaign,
  working,
  onOpenCampaign,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  working: boolean;
  onOpenCampaign: (campaignId: string) => void;
}) {
  const t = useT();
  const hypothesis = card.hypothesis ?? {};
  const evidence = hypothesis.evidence ?? [];

  if (!hypothesis.statement && evidence.length === 0) {
    return working ? (
      <Pending>
        <RoleAtWork
          role="researcher"
          activity={t("contentTrack.card.activity.researching")}
        />
      </Pending>
    ) : (
      <p className="text-sm text-muted-foreground">
        {t("contentTrack.card.noHypothesis")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          {t("contentTrack.card.whyEyebrow")}
        </span>
        <div className="flex flex-wrap items-center gap-[7px] text-xs text-muted-foreground">
          <RoleAvatar role="strategist" className="size-[17px] rounded-full" />
          <span>{t("contentTrack.card.proposed")}</span>
          {card.status !== "ideas" && (
            <>
              <span aria-hidden>·</span>
              <span>{t("contentTrack.card.approved")}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="font-semibold text-foreground">
            {t("contentTrack.card.nowIn", {
              status: t(CARD_STATUS_LABEL[card.status]),
            })}
          </span>
        </div>
        {hypothesis.statement ? (
          <p className="text-[15.5px] leading-[1.5] text-foreground">
            {hypothesis.statement}
          </p>
        ) : (
          working && (
            <Pending>
              <RoleAtWork
                role="strategist"
                activity={t("contentTrack.card.activity.strategizing")}
              />
            </Pending>
          )
        )}
        {hypothesis.angle && (
          <p className="text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">
              {t("contentTrack.card.angle")}:
            </span>{" "}
            {hypothesis.angle}
          </p>
        )}
      </section>

      <HypothesisSits
        campaign={campaign}
        hypothesis={hypothesis}
        onOpenCampaign={onOpenCampaign}
      />

      <Section title={t("contentTrack.card.signals")}>
        <EvidenceBySource evidence={evidence} />
      </Section>

      {(hypothesis.keywords?.length ?? 0) > 0 && (
        <Section title={t("contentTrack.card.keywords")}>
          <KeywordChips keywords={hypothesis.keywords ?? []} />
        </Section>
      )}

      {(hypothesis.guardrails?.length ?? 0) > 0 && (
        <Section title={t("contentTrack.card.guardrails")}>
          <ul className="flex flex-col gap-[9px]">
            {hypothesis.guardrails?.map((guardrail) => (
              <li
                key={guardrail.text}
                className="flex items-center gap-[9px] text-[13px] text-foreground"
              >
                <SlashCircle01
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">{guardrail.text}</span>
                <span className="shrink-0 rounded-[5px] border border-border bg-muted px-[7px] py-px text-[10.5px] text-muted-foreground">
                  {t(
                    guardrail.origin === "campaign"
                      ? "contentTrack.card.origin.campaign"
                      : "contentTrack.card.origin.brand",
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** What the post answers to: the campaign's goals, the campaign, and this post's own objective. */
function HypothesisSits({
  campaign,
  hypothesis,
  onOpenCampaign,
}: {
  campaign: CampaignEntry | undefined;
  hypothesis: NonNullable<BlogCard["hypothesis"]>;
  onOpenCampaign: (campaignId: string) => void;
}) {
  const t = useT();
  if (!campaign && !hypothesis.objective) return null;
  const post: SitsNode = {
    key: "post",
    kind: "post",
    onPage: true,
    title: t("contentTrack.sits.thisPost"),
    body: hypothesis.objective || t("contentTrack.sits.noObjective"),
    meta: hypothesis.metric
      ? [t("contentTrack.sits.measuredBy", { metric: hypothesis.metric })]
      : [],
  };
  if (!campaign) {
    return (
      <WhereItSits
        title={t("contentTrack.sits.hypothesisTitle")}
        nodes={[post]}
      />
    );
  }
  const open = () => onOpenCampaign(campaign.id);
  const period = [campaign.period.start, campaign.period.end]
    .filter(Boolean)
    .join(" → ");
  return (
    <WhereItSits
      title={t("contentTrack.sits.hypothesisTitle")}
      nodes={[
        ...goalNodes(campaign.goals, t, open, {
          title: t("contentTrack.sits.noGoals"),
          onOpen: open,
        }),
        {
          key: "campaign",
          kind: "campaign",
          title: campaign.name || t("sandbox.campaigns.untitled"),
          meta: [
            t("contentTrack.sits.campaign"),
            t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type]),
            t(CAMPAIGN_OBJECTIVE_LABEL[campaign.intent.objective]),
            period,
          ],
          onOpen: open,
        },
        post,
      ]}
    />
  );
}

/** What a person can do about a missing preview, when there is anything. */
const PREVIEW_GAP: Record<
  Exclude<CardPreviewGap, "not-written">,
  TranslationKey
> = {
  "no-preview-server": "contentTrack.card.previewGap.noPreviewServer",
  "no-cms": "contentTrack.card.previewGap.noCms",
  "no-route": "contentTrack.card.previewGap.noRoute",
  unavailable: "contentTrack.card.previewGap.unavailable",
};

function ExecutePhase({
  card,
  campaign,
  working,
  preview,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  working: boolean;
  preview: CardPreview;
}) {
  const t = useT();
  /** The person's pick; until then the post's content, with the site a click away. */
  const [view, setView] = useState<"site" | "content" | null>(null);
  const shown = view ?? "content";
  if (card.status === "ideas" && !card.post) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("contentTrack.card.notStarted")}
      </p>
    );
  }
  const post = card.post ?? {};

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(STAGE_LABEL) as (keyof typeof STAGE_LABEL)[]).map(
          (stage) => {
            const done = stageDone(card, stage);
            const current = card.stage === stage && working;
            return (
              <li key={stage}>
                <Badge
                  variant={done ? "success" : current ? "brand" : "muted"}
                  className={cn(current && "animate-pulse")}
                >
                  {done && <CheckCircle />}
                  {t(STAGE_LABEL[stage])}
                </Badge>
              </li>
            );
          },
        )}
      </ol>

      {card.postKey && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup
            type="single"
            size="sm"
            value={shown}
            onValueChange={(next) =>
              next && setView(next as "site" | "content")
            }
            aria-label={t("contentTrack.card.previewToggle")}
            className="gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
          >
            <ToggleGroupItem
              value="site"
              disabled={!preview.url}
              className={PREVIEW_TOGGLE_ITEM}
            >
              <Globe01 size={12} />
              {t("contentTrack.card.previewSite")}
            </ToggleGroupItem>
            <ToggleGroupItem value="content" className={PREVIEW_TOGGLE_ITEM}>
              <File06 size={12} />
              {t("contentTrack.card.previewContent")}
            </ToggleGroupItem>
          </ToggleGroup>
          {preview.url ? (
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("contentTrack.card.openInNewTab")}
              <LinkExternal01 size={12} />
            </a>
          ) : preview.loading ? (
            <span className="text-xs text-muted-foreground">
              {t("contentTrack.card.previewLoading")}
            </span>
          ) : (
            preview.gap &&
            preview.gap !== "not-written" && (
              <span className="text-xs text-muted-foreground">
                {t(PREVIEW_GAP[preview.gap])}
              </span>
            )
          )}
        </div>
      )}

      {shown === "site" && preview.url ? (
        <SitePreviewFrame url={preview.url} />
      ) : (
        <PostContent
          card={card}
          campaign={campaign}
          working={working}
          post={post}
        />
      )}

      {card.status === "awaiting_review" && card.branch && (
        <p className="text-sm text-muted-foreground">
          {t("contentTrack.card.saved", { branch: card.branch })}
        </p>
      )}
    </div>
  );
}

const PREVIEW_TOGGLE_ITEM =
  "h-6 gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-transparent data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-edge";

/** The page the site serves for the post, as a desktop miniature like the publish compare's. */
function SitePreviewFrame({ url }: { url: string }) {
  const t = useT();
  let address = url;
  try {
    const parsed = new URL(url);
    address = `${parsed.host}${parsed.pathname}`;
  } catch {
    // The raw address is still worth showing.
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-edge">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <Globe01 size={12} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {address}
        </span>
      </div>
      <div className="relative h-[720px] bg-background">
        <CompareFrame
          url={url}
          device="desktop"
          title={t("contentTrack.card.previewFrameTitle")}
          missing=""
        />
      </div>
    </div>
  );
}

/** The post as the card holds it: cover, excerpt and body, filling in as the agent writes. */
function PostContent({
  card,
  campaign,
  working,
  post,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  working: boolean;
  post: NonNullable<BlogCard["post"]>;
}) {
  const t = useT();
  return (
    <>
      {imageReady(post.cover?.url) ? (
        <img
          src={post.cover.url}
          alt={post.cover.alt ?? ""}
          className="h-48 w-full rounded-xl object-cover"
        />
      ) : working && !stageDone(card, "illustrating") ? (
        <div className="relative">
          <Skeleton className="h-48 w-full rounded-xl" />
          <span className="absolute top-3 right-3">
            <RoleAtWork
              role="creator"
              activity={t("contentTrack.card.activity.cover")}
            />
          </span>
        </div>
      ) : null}

      {post.excerpt ? (
        <p className="text-[15px] leading-[1.55] text-foreground">
          {post.excerpt}
        </p>
      ) : (
        working &&
        !post.title && (
          <Pending>
            <RoleAtWork
              role="writer"
              activity={t("contentTrack.card.activity.drafting")}
            />
          </Pending>
        )
      )}

      {!working && (post.gaps?.length ?? 0) > 0 && (
        <PostGaps gaps={post.gaps ?? []} />
      )}

      {(post.sections?.length ?? 0) > 0 && (
        <PostBody
          sections={post.sections ?? []}
          products={campaign?.intent.products ?? []}
        />
      )}
    </>
  );
}

const GAP_LABEL = {
  "no-bucket": "contentTrack.card.gap.noBucket",
  "no-image-model": "contentTrack.card.gap.noImageModel",
  "images-failed": "contentTrack.card.gap.imagesFailed",
  "sections-dropped": "contentTrack.card.gap.sectionsDropped",
  "no-preview": "contentTrack.card.gap.noPreview",
} as const satisfies Record<string, TranslationKey>;

type PostGap = NonNullable<NonNullable<BlogCard["post"]>["gaps"]>[number];

/** What the run could not do or could not fix, for whoever reviews the post. */
function PostGaps({ gaps }: { gaps: PostGap[] }) {
  const t = useT();
  const text = (gap: PostGap) => {
    const label = GAP_LABEL[gap.code as keyof typeof GAP_LABEL];
    if (label) {
      return t(label, { count: gap.count ?? 0, detail: gap.detail ?? "" });
    }
    return gap.detail || gap.code;
  };
  return (
    <div className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">{t("contentTrack.card.gaps")}</span>
        <ul className="flex flex-col gap-0.5">
          {gaps.map((gap, index) => (
            <li key={`${gap.code}-${index}`}>{text(gap)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Properties({
  card,
  campaign,
  site,
  working,
  onMove,
  onOpenCampaign,
  onUpdate,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  site: VirtualMCPEntity | undefined;
  working: boolean;
  onMove: (status: BlogCardStatus) => void;
  onOpenCampaign: (campaignId: string) => void;
  onUpdate: (patch: CardPatch) => Promise<unknown>;
}) {
  const t = useT();
  const [tab, setTab] = useState<"properties" | "publishing">("properties");
  const siteTitle = site?.title;
  const editor = useOpenCardEditor();
  const none = t("contentTrack.props.none");
  const period = campaign
    ? [campaign.period.start, campaign.period.end].filter(Boolean).join(" → ")
    : "";

  const groups = (
    <>
      <Group>
        <Row icon={<Clock size={14} />}>
          <Select
            value={card.status}
            disabled={working}
            onValueChange={(next) => onMove(next as BlogCardStatus)}
          >
            <SelectTrigger
              size="sm"
              className="h-7 w-full border-none px-1.5 shadow-none"
              aria-label={t("contentTrack.props.status")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLOG_CARD_STATUSES.map((status) => (
                <SelectItem
                  key={status}
                  value={status}
                  disabled={status === "generating"}
                >
                  {t(CARD_STATUS_LABEL[status])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row icon={<Tag01 size={14} />}>
          {card.hypothesis?.format?.name || none}
        </Row>
        <Row icon={<SuperAgentIcon size={14} />}>
          {t("contentTrack.props.agent")}
        </Row>
      </Group>
      <Group caption={t("contentTrack.props.campaign")}>
        <Row icon={<Flag05 size={14} />} trail={period || undefined}>
          {campaign ? (
            <button
              type="button"
              className="max-w-full truncate text-left hover:underline"
              onClick={() => onOpenCampaign(campaign.id)}
            >
              {campaign.name || t("contentTrack.campaign.untitled")}
            </button>
          ) : (
            none
          )}
        </Row>
      </Group>
      <Group caption={t("contentTrack.props.site")}>
        <Row icon={<Globe01 size={14} />}>{siteTitle ?? card.virtualMcpId}</Row>
        <Row icon={<GitBranch01 size={14} />}>
          <code className="text-xs">{card.branch || none}</code>
        </Row>
      </Group>
      {card.postKey && (
        <Group caption={t("contentTrack.props.links")}>
          <button
            type="button"
            disabled={!editor.ready || editor.opening || !card.branch}
            onClick={() => void editor.open(card)}
            className="flex min-h-7 items-center gap-2 text-left text-[13px] text-foreground hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60"
          >
            <span className="grid w-4 shrink-0 place-items-center text-muted-foreground">
              <LinkExternal01 size={14} />
            </span>
            {t("contentTrack.props.openInEditor")}
          </button>
          <Row
            icon={
              <span className="size-1.5 rounded-full bg-muted-foreground" />
            }
          >
            <code className="text-xs">{card.postKey}</code>
          </Row>
        </Group>
      )}
    </>
  );
  // The post's publishing fields are there to set once it is on the site.
  if (!card.postKey) {
    return (
      <PropertiesPanel title={t("contentTrack.props.title")}>
        {groups}
      </PropertiesPanel>
    );
  }
  return (
    <Tabs
      value={tab}
      onValueChange={(next) =>
        setTab(next === "publishing" ? "publishing" : "properties")
      }
      variant="underline"
      className="gap-0"
    >
      <PropertiesPanel
        title={
          <TabsList variant="underline" className="-mx-1 h-8">
            <TabsTrigger
              variant="underline"
              value="properties"
              className="px-1.5 text-[13px] font-semibold"
            >
              {t("contentTrack.props.title")}
            </TabsTrigger>
            <TabsTrigger
              variant="underline"
              value="publishing"
              className="px-1.5 text-[13px] font-semibold"
            >
              {t("contentTrack.props.publishing")}
            </TabsTrigger>
          </TabsList>
        }
      >
        {tab === "properties" ? (
          groups
        ) : (
          <CardPublishing
            card={card}
            site={site}
            locked={working}
            onUpdate={onUpdate}
          />
        )}
      </PropertiesPanel>
    </Tabs>
  );
}
