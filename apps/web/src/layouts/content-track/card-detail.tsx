/**
 * One blogpost card, over the whole panel: its hypothesis, the post as it
 * fills in, and its properties. A panel rather than a sheet because a sheet is
 * modal, and the card's chat has to stay usable beside it.
 *
 * Nothing here streams or mounts a chat: the card's agent writes the card, and
 * the card arrives through the board's own subscription.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle,
  LinkExternal01,
  MessageChatCircle,
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
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { PropertyGroup } from "@/layouts/task-board/task-dialog";
import { useClockTick } from "@/lib/use-clock-tick";
import { useConnections, useProjectContext } from "@/sdk";
import { CARD_STATUS_LABEL } from "./blogposts-board";
import {
  type CardPhase,
  cardAgentWorking,
  cardTitle,
  defaultPhase,
  imageReady,
  shopTheLook,
  stageDone,
} from "./card-model";
import { PostBody } from "./post-body";

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
  const [phase, setPhase] = useState<CardPhase>(defaultPhase(card));
  const working = cardAgentWorking(card, useClockTick());
  const title = cardTitle(card) || t("contentTrack.card.untitled");
  const hasThesis = !!card.hypothesis?.statement?.trim();
  const canBring = card.status === "ideas" && !hasThesis && !working;
  const canApprove =
    card.status === "ideas" && hasThesis && !!card.campaignId && !working;

  return (
    <>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("contentTrack.title"), onSelect: onClose }}
        items={[{ key: card.id, label: title }]}
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
        <Page.Tabs>
          {(["hypothesis", "execute", "monitor"] as const).map((entry) => (
            <Page.Tab
              key={entry}
              active={phase === entry}
              onClick={() => setPhase(entry)}
            >
              {t(PHASE_LABEL[entry])}
            </Page.Tab>
          ))}
        </Page.Tabs>
      </Panel.Toolbar.Left.Portal>
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
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
        <aside className="w-full shrink-0 lg:w-72">
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

function Working({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
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
      <div className="flex flex-col gap-6">
        <Working label={t("contentTrack.card.researching")} />
        <Working label={t("contentTrack.card.strategizing")} />
      </div>
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
    <div className="flex flex-col gap-8">
      {hypothesis.statement ? (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold text-foreground">
              {hypothesis.title}
            </h2>
            {hypothesis.format?.name && (
              <Badge variant="secondary">{hypothesis.format.name}</Badge>
            )}
          </div>
          <p className="text-sm leading-relaxed text-foreground">
            {hypothesis.statement}
          </p>
          {hypothesis.angle && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium">
                {t("contentTrack.card.angle")}:
              </span>{" "}
              {hypothesis.angle}
            </p>
          )}
        </section>
      ) : (
        working && <Working label={t("contentTrack.card.strategizing")} />
      )}

      <Section title={t("contentTrack.card.signals")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {sources.map((source) => {
            const items = evidence.filter((item) => item.source === source);
            return (
              <div
                key={source}
                className="flex flex-col gap-1.5 rounded-xl bg-card p-4 shadow-edge"
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {t(SOURCE_LABEL[source])}
                </span>
                {items.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {source === "gsc" && !gscConnected
                      ? t("contentTrack.card.notConnected")
                      : t("contentTrack.card.noSignal")}
                  </span>
                ) : (
                  items.map((item, index) => (
                    <div key={index} className="flex flex-col gap-0.5">
                      {item.figure && (
                        <span className="text-base font-semibold tabular-nums text-foreground">
                          {item.figure}
                        </span>
                      )}
                      <span className="text-sm text-foreground">
                        {item.fact}
                      </span>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {campaign && (
        <Section title={t("contentTrack.card.whereItSits")}>
          <div className="flex flex-col gap-1 rounded-xl bg-card p-4 shadow-edge">
            <span className="text-sm font-medium text-foreground">
              {campaign.name || t("sandbox.campaigns.untitled")}
            </span>
            {(campaign.period.start || campaign.period.end) && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {[campaign.period.start, campaign.period.end]
                  .filter(Boolean)
                  .join(" → ")}
              </span>
            )}
          </div>
        </Section>
      )}

      {(hypothesis.keywords?.length ?? 0) > 0 && (
        <Section title={t("contentTrack.card.keywords")}>
          <div className="flex flex-wrap gap-1.5">
            {hypothesis.keywords?.map((keyword) => (
              <Badge key={keyword.term} variant="outline" size="lg">
                {keyword.term}
                {keyword.volume !== undefined && (
                  <span className="text-muted-foreground">
                    {t("contentTrack.card.perMonth", {
                      volume: keyword.volume.toLocaleString(),
                    })}
                  </span>
                )}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {(hypothesis.guardrails?.length ?? 0) > 0 && (
        <Section title={t("contentTrack.card.guardrails")}>
          <ul className="flex flex-col gap-1.5">
            {hypothesis.guardrails?.map((guardrail) => (
              <li
                key={guardrail.text}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <span className="text-foreground">{guardrail.text}</span>
                <Badge variant="muted" className="shrink-0">
                  {t(
                    guardrail.origin === "campaign"
                      ? "contentTrack.card.origin.campaign"
                      : "contentTrack.card.origin.brand",
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hypothesis.metric && (
        <Section title={t("contentTrack.card.metric")}>
          <p className="text-sm text-foreground">{hypothesis.metric}</p>
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
  const products = shopTheLook(card, campaign?.intent.products ?? []);

  return (
    <div className="flex flex-col gap-6">
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
          className="aspect-video w-full rounded-xl object-cover"
        />
      ) : working && !stageDone(card, "illustrating") ? (
        <div className="flex flex-col gap-1">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <span className="text-xs text-muted-foreground">
            {t("contentTrack.card.creatorGenerating")}
          </span>
        </div>
      ) : null}

      {post.title ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold text-foreground">
            {post.title}
          </h2>
          {post.excerpt && (
            <p className="text-sm text-muted-foreground">{post.excerpt}</p>
          )}
        </div>
      ) : (
        working && <Working label={t("contentTrack.card.writerDrafting")} />
      )}

      {(post.sections?.length ?? 0) > 0 && (
        <PostBody sections={post.sections ?? []} />
      )}

      {products.length > 0 && (
        <Section title={t("contentTrack.card.shopTheLook")}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {products.map((product) => (
              <div
                key={product.id}
                className="flex flex-col gap-2 rounded-xl bg-card p-2 shadow-edge"
              >
                {product.images[0] ? (
                  <img
                    src={product.images[0]}
                    alt={product.name}
                    className="aspect-square w-full rounded-lg object-cover"
                  />
                ) : (
                  <div className="aspect-square w-full rounded-lg bg-muted" />
                )}
                <span className="line-clamp-2 text-xs font-medium text-foreground">
                  {product.name}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {card.status === "awaiting_review" && card.branch && (
        <p className="text-sm text-muted-foreground">
          {t("contentTrack.card.saved", { branch: card.branch })}
        </p>
      )}
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
  const text = (value: string | undefined) => (
    <span className="px-3 text-sm text-foreground">{value || none}</span>
  );
  const code = (value: string | undefined) => (
    <code className="break-all px-3 text-xs text-foreground">
      {value || none}
    </code>
  );

  return (
    <div className="flex flex-col gap-5">
      <PropertyGroup label={t("contentTrack.props.status")}>
        <Select
          value={card.status}
          disabled={working}
          onValueChange={(next) => onMove(next as BlogCardStatus)}
        >
          <SelectTrigger className="w-full">
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
      </PropertyGroup>
      <PropertyGroup label={t("contentTrack.props.format")}>
        {text(card.hypothesis?.format?.name)}
      </PropertyGroup>
      <PropertyGroup label={t("contentTrack.props.campaign")}>
        {text(campaign?.name)}
      </PropertyGroup>
      <PropertyGroup label={t("contentTrack.props.site")}>
        {text(siteTitle ?? card.virtualMcpId)}
      </PropertyGroup>
      <PropertyGroup label={t("contentTrack.props.branch")}>
        {code(card.branch)}
      </PropertyGroup>
      <PropertyGroup label={t("contentTrack.props.post")}>
        {code(card.postKey)}
      </PropertyGroup>
      {card.postKey && (
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link
            to="/$org/projects/$agentId/site-editor/content"
            params={{ org: org.slug, agentId: card.virtualMcpId }}
            search={{ contentCollection: "posts", contentItem: card.postKey }}
          >
            <LinkExternal01 size={14} />
            {t("contentTrack.props.openInEditor")}
          </Link>
        </Button>
      )}
    </div>
  );
}
