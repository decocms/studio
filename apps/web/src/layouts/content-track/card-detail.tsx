/**
 * One blogpost card, over the whole panel: its hypothesis, the post as it
 * fills in, and its properties. A panel rather than a sheet because a sheet is
 * modal, and the card's chat has to stay usable beside it.
 *
 * Nothing here streams or mounts a chat: the card's agent writes the card, and
 * the card arrives through the board's own subscription.
 */

import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  BarChart07,
  Calendar,
  Check,
  CheckCircle,
  Clock,
  Flag05,
  GitBranch01,
  Globe01,
  LinkExternal01,
  MessageChatCircle,
  Package,
  SearchMd,
  SlashCircle01,
  Star01,
  Tag01,
  Target04,
} from "@untitledui/icons";
import {
  BLOG_CARD_STAGES,
  BLOG_CARD_STATUSES,
  type BlogCard,
  type BlogCardStatus,
  type BlogEvidenceSource,
} from "@decocms/shared/blog-card";
import { pickBlogConnection } from "@decocms/shared/blog-connections";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import type { CampaignEntry } from "@/components/sandbox/content/blog/blog-data";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useClockTick } from "@/lib/use-clock-tick";
import { useConnections, useProjectContext } from "@/sdk";
import { CARD_STATUS_LABEL } from "./blogposts-board";
import {
  type CardPhase,
  cardAgentWorking,
  cardTitle,
  defaultPhase,
  imageReady,
  stageDone,
} from "./card-model";
import { RoleAtWork, RoleAvatar } from "./newsroom";
import { PostBody } from "./post-body";

const PHASES = ["hypothesis", "execute", "monitor"] as const;

const PHASE_LABEL = {
  hypothesis: "contentTrack.phase.hypothesis",
  execute: "contentTrack.phase.execute",
  monitor: "contentTrack.phase.monitor",
} as const satisfies Record<CardPhase, TranslationKey>;

const SOURCE_LABEL = {
  gsc: "contentTrack.card.source.gsc",
  ga4: "contentTrack.card.source.ga4",
  vtex: "contentTrack.card.source.vtex",
  calendar: "contentTrack.card.source.calendar",
  brand: "contentTrack.card.source.brand",
} as const satisfies Record<BlogEvidenceSource, TranslationKey>;

const SOURCE_ICON = {
  gsc: SearchMd,
  ga4: BarChart07,
  vtex: Package,
  calendar: Calendar,
  brand: Star01,
} as const satisfies Record<BlogEvidenceSource, unknown>;

const STAGE_LABEL = {
  grounding: "contentTrack.card.stage.grounding",
  drafting: "contentTrack.card.stage.drafting",
  illustrating: "contentTrack.card.stage.illustrating",
  assembling: "contentTrack.card.stage.assembling",
  writing: "contentTrack.card.stage.writing",
} as const satisfies Record<
  Exclude<(typeof BLOG_CARD_STAGES)[number], "done">,
  TranslationKey
>;

/** The four systems a hypothesis is read against, always shown. */
const SIGNALS = ["gsc", "ga4", "vtex", "calendar"] as const;

export function CardDetail({
  card,
  campaign,
  siteTitle,
  executing,
  onClose,
  onOpenChat,
  onRun,
  onMove,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  siteTitle: string | undefined;
  /** A run start is in flight. */
  executing: boolean;
  onClose: () => void;
  onOpenChat: () => void;
  onRun: (phase: "hypothesis" | "execute") => void;
  onMove: (status: BlogCardStatus) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [phase, setPhase] = useState<CardPhase>(defaultPhase(card));
  const working = cardAgentWorking(card, useClockTick());
  const crumb = cardTitle(card) || t("contentTrack.card.untitled");
  const title =
    (phase === "hypothesis" ? card.hypothesis?.title : card.post?.title) ||
    crumb;
  const hasThesis = !!card.hypothesis?.statement?.trim();
  const canBring = card.status === "ideas" && !hasThesis && !working;
  const canApprove =
    card.status === "ideas" && hasThesis && !!card.campaignId && !working;
  const sections = card.post?.sections?.length ?? 0;
  const meta = [
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
              setPhase("execute");
            }}
          >
            {t("contentTrack.card.approve")}
          </Button>
        )}
      </Page.Actions>
      <Panel.Toolbar.Left.Portal>
        <PhaseSteps
          phase={phase}
          reached={defaultPhase(card)}
          onSelect={setPhase}
        />
      </Panel.Toolbar.Left.Portal>
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
                {title}
              </h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {meta.join(" · ")}
              </p>
            </div>
            {card.postKey && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="mt-1 shrink-0"
              >
                <Link
                  to="/$org/projects/$agentId/site-editor/content"
                  params={{ org: org.slug, agentId: card.virtualMcpId }}
                  search={{
                    contentCollection: "posts",
                    contentItem: card.postKey,
                  }}
                >
                  {t("contentTrack.card.siteEditor")}
                  <LinkExternal01 size={14} />
                </Link>
              </Button>
            )}
          </header>
          {card.error && (
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{card.error}</span>
            </div>
          )}
          {phase === "hypothesis" ? (
            <HypothesisPhase
              card={card}
              campaign={campaign}
              working={working}
            />
          ) : phase === "execute" ? (
            <ExecutePhase card={card} campaign={campaign} working={working} />
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
            siteTitle={siteTitle}
            working={working}
            onMove={onMove}
          />
        </aside>
      </div>
    </>
  );
}

/** The card's phases as steps: the ones it has passed are done. */
function PhaseSteps({
  phase,
  reached,
  onSelect,
}: {
  phase: CardPhase;
  reached: CardPhase;
  onSelect: (phase: CardPhase) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      {PHASES.map((entry, index) => {
        const active = entry === phase;
        const done = index < PHASES.indexOf(reached);
        return (
          <button
            key={entry}
            type="button"
            onClick={() => onSelect(entry)}
            className={cn(
              "flex items-center gap-[7px] rounded-full px-[13px] py-[5px] text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted",
              active && "bg-muted font-semibold text-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-[15px] place-items-center rounded-full border-[1.5px] border-current",
                done && "border-foreground bg-foreground text-background",
                active && !done && "border-foreground",
              )}
            >
              {done ? (
                <Check size={10} />
              ) : active ? (
                <span className="size-1.5 rounded-full bg-foreground" />
              ) : null}
            </span>
            {t(PHASE_LABEL[entry])}
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[9px]">
      <h3 className="text-[12.5px] font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Lines of text that are not there yet, with the role writing them. */
function Pending({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {children}
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

function HypothesisPhase({
  card,
  campaign,
  working,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  working: boolean;
}) {
  const t = useT();
  const connections = useConnections();
  const gscConnected = !!pickBlogConnection("gsc", connections);
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

  const sources = evidence.some((item) => item.source === "brand")
    ? [...SIGNALS, "brand" as const]
    : SIGNALS;

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
        {hypothesis.metric && (
          <div className="mt-1 flex items-start gap-2 rounded-[10px] border border-border bg-muted px-3 py-2.5 text-[12.5px] leading-[1.45] text-muted-foreground">
            <Target04 size={14} className="mt-px shrink-0 text-success" />
            <span>
              <span className="font-semibold text-foreground">
                {t("contentTrack.card.measuredIn")}
              </span>{" "}
              {hypothesis.metric}
            </span>
          </div>
        )}
      </section>

      <Section title={t("contentTrack.card.signals")}>
        <div className="grid gap-[9px] sm:grid-cols-2">
          {sources.map((source) => {
            const [first, ...rest] = evidence.filter(
              (item) => item.source === source,
            );
            const Icon = SOURCE_ICON[source];
            return (
              <div
                key={source}
                className="rounded-[11px] border border-border bg-card px-[13px] py-3"
              >
                <div className="mb-[9px] flex items-center gap-[7px]">
                  <span className="grid size-[22px] shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground">
                    <Icon size={12} />
                  </span>
                  <span className="text-[11.5px] font-semibold text-muted-foreground">
                    {t(SOURCE_LABEL[source])}
                  </span>
                </div>
                {first ? (
                  <>
                    {first.figure ? (
                      <>
                        <div className="mb-[3px] text-[15px] font-semibold tracking-[-0.01em] text-foreground tabular-nums">
                          {first.figure}
                        </div>
                        <p className="text-xs leading-[1.42] text-muted-foreground">
                          {first.fact}
                        </p>
                      </>
                    ) : (
                      <p className="text-[13px] leading-[1.45] text-foreground">
                        {first.fact}
                      </p>
                    )}
                    {rest.length > 0 && (
                      <ul className="mt-2.5 flex flex-col gap-2 border-t border-border pt-2.5">
                        {rest.map((item, index) => (
                          <li
                            key={index}
                            className="text-xs leading-[1.42] text-muted-foreground"
                          >
                            {item.figure && (
                              <span className="font-semibold text-foreground tabular-nums">
                                {item.figure}{" "}
                              </span>
                            )}
                            {item.fact}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {source === "gsc" && !gscConnected
                      ? t("contentTrack.card.notConnected")
                      : t("contentTrack.card.noSignal")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {campaign && (
        <Section title={t("contentTrack.card.whereItSits")}>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-[11px] rounded-[11px] border border-border bg-card px-[13px] py-[11px]">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Flag05 size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-foreground">
                  {campaign.name || t("sandbox.campaigns.untitled")}
                </div>
                <div className="mt-px text-xs text-muted-foreground tabular-nums">
                  {[
                    t("contentTrack.card.campaign"),
                    [campaign.period.start, campaign.period.end]
                      .filter(Boolean)
                      .join(" → "),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 pl-4 text-xs text-muted-foreground">
              <span className="size-2 rounded-sm bg-muted-foreground/50" />
              {t("contentTrack.card.thisTask")}
            </div>
          </div>
        </Section>
      )}

      {(hypothesis.keywords?.length ?? 0) > 0 && (
        <Section title={t("contentTrack.card.keywords")}>
          <div className="flex flex-wrap gap-[7px]">
            {hypothesis.keywords?.map((keyword) => (
              <span
                key={keyword.term}
                className="inline-flex items-center gap-[7px] rounded-[9px] border border-border bg-card px-[11px] py-1.5 text-[12.5px] text-foreground"
              >
                {keyword.term}
                {keyword.volume !== undefined && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("contentTrack.card.perMonth", {
                      volume: keyword.volume.toLocaleString(),
                    })}
                  </span>
                )}
              </span>
            ))}
          </div>
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

function ExecutePhase({
  card,
  campaign,
  working,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  working: boolean;
}) {
  const t = useT();
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

      {(post.sections?.length ?? 0) > 0 && (
        <PostBody
          sections={post.sections ?? []}
          products={campaign?.intent.products ?? []}
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

/** One property: an icon, its value, and what sits at its right. */
function Row({
  icon,
  children,
  trail,
}: {
  icon: ReactNode;
  children: ReactNode;
  trail?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 text-[13px] text-foreground">
      <span className="grid w-4 shrink-0 place-items-center text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {trail && (
        <span className="shrink-0 text-xs text-muted-foreground">{trail}</span>
      )}
    </div>
  );
}

function Group({
  caption,
  children,
}: {
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {caption && (
        <span className="pb-1 text-xs font-medium text-muted-foreground">
          {caption}
        </span>
      )}
      {children}
    </div>
  );
}

function Properties({
  card,
  campaign,
  siteTitle,
  working,
  onMove,
}: {
  card: BlogCard;
  campaign: CampaignEntry | undefined;
  siteTitle: string | undefined;
  working: boolean;
  onMove: (status: BlogCardStatus) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const none = t("contentTrack.props.none");
  const period = campaign
    ? [campaign.period.start, campaign.period.end].filter(Boolean).join(" → ")
    : "";

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-edge">
      <span className="border-b border-border pb-2 text-[13px] font-semibold text-foreground">
        {t("contentTrack.props.title")}
      </span>
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
          {campaign?.name || none}
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
          <Link
            to="/$org/projects/$agentId/site-editor/content"
            params={{ org: org.slug, agentId: card.virtualMcpId }}
            search={{ contentCollection: "posts", contentItem: card.postKey }}
            className="flex min-h-7 items-center gap-2 text-[13px] text-foreground hover:underline"
          >
            <span className="grid w-4 shrink-0 place-items-center text-muted-foreground">
              <LinkExternal01 size={14} />
            </span>
            {t("contentTrack.props.openInEditor")}
          </Link>
          <Row
            icon={
              <span className="size-1.5 rounded-full bg-muted-foreground" />
            }
          >
            <code className="text-xs">{card.postKey}</code>
          </Row>
        </Group>
      )}
    </div>
  );
}
