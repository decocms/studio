/**
 * The content track: the brand's blogposts on a board of their own, and the
 * campaigns they belong to. Two gates stand in front of it, in this order: a
 * brand guide a post can be written from, then the VTEX and GA4 connections
 * every post reads.
 */

import { type ReactNode, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "@untitledui/icons";
import { toast } from "sonner";
import type { BlogCard, BlogCardStatus } from "@decocms/shared/blog-card";
import { Button } from "@decocms/ui/components/button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import {
  CAMPAIGN_KEY_PREFIX,
  scanCampaigns,
} from "@/components/sandbox/content/blog/blog-data";
import { BlogConnectionsGate } from "@/components/sandbox/content/blog/blog-connections-gate";
import { useBlogCards } from "@/components/sandbox/content/blog/use-blog-cards";
import { useVtexCatalogSource } from "@/components/sandbox/content/blog/blocks/vtex-mcp-source";
import { useBlogConnections } from "@/components/sandbox/content/blog/use-blog-connections";
import {
  type BlogState,
  useBlogState,
} from "@/components/sandbox/content/blog/use-blog-state";
import { useBrandLiveSync } from "@/hooks/use-brand-events";
import { scopableProjects, useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { Campaigns } from "@/layouts/context/brand-campaigns";
import { projectRepo } from "@/lib/repository-binding";
import { useProjectContext, useVirtualMCPsNonBlocking } from "@/sdk";
import { BlogpostsBoard } from "./blogposts-board";
import { CardDetail } from "./card-detail";
import { ContentSetup } from "./content-setup";
import { TrackDivider } from "./track-divider";
import { type NewBlogpost, NewBlogpostDialog } from "./new-blogpost-dialog";
import { contentTrackGate } from "./track-state";
import { useOpenCardChat } from "./use-open-card-chat";

type ContentView = "blogposts" | "campaigns";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ContentTrack({ trackTabs }: { trackTabs: ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const blog = useBlogState({ orgSlug: org.slug });
  useBrandLiveSync();
  const search = useSearch({ strict: false }) as {
    view?: string;
    card?: string;
  };
  const view: ContentView =
    search.view === "campaigns" ? "campaigns" : "blogposts";
  const state = contentTrackGate(blog);
  /** An open card takes the header over, as a task does on the code board. */
  const cardOpen =
    state.gate === "open" && view === "blogposts" && !!search.card;

  const open = (next: ContentView) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        view: next === "blogposts" ? undefined : next,
        card: undefined,
      }),
    });

  return (
    <Page>
      {!cardOpen && <Page.Title>{t("contentTrack.title")}</Page.Title>}
      {!cardOpen && (
        <Panel.Toolbar.Left.Portal>
          <Page.Tabs>
            {trackTabs}
            {state.gate === "open" && (
              <>
                {trackTabs && <TrackDivider />}
                <Page.Tab
                  active={view === "blogposts"}
                  onClick={() => open("blogposts")}
                >
                  {t("contentTrack.viewBlogposts")}
                </Page.Tab>
                <Page.Tab
                  active={view === "campaigns"}
                  onClick={() => open("campaigns")}
                >
                  {t("contentTrack.viewCampaigns")}
                </Page.Tab>
              </>
            )}
          </Page.Tabs>
        </Panel.Toolbar.Left.Portal>
      )}
      <Page.Content>
        <Page.Container>
          {state.gate === "loading" ? (
            <Skeleton className="h-64 w-full rounded-2xl" />
          ) : state.gate === "setup" ? (
            <ContentSetup missing={state.missing} />
          ) : (
            <BlogConnectionsGate>
              {view === "campaigns" ? (
                <Campaigns />
              ) : (
                <Blogposts blog={blog} cardId={search.card} />
              )}
            </BlogConnectionsGate>
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

function Blogposts({
  blog,
  cardId,
}: {
  blog: BlogState;
  cardId: string | undefined;
}) {
  const t = useT();
  const navigate = useNavigate();
  const scopeId = useScopeId();
  const projects = useVirtualMCPsNonBlocking();
  const sites = scopableProjects(projects).filter(
    (project) => projectRepo(project) !== null,
  );
  const { cards, isLoading, create, update, run } = useBlogCards();
  const openChat = useOpenCardChat();
  const [creating, setCreating] = useState(false);

  const { vtex } = useBlogConnections();
  const catalog = useVtexCatalogSource(vtex.connectionId);
  const campaigns = scanCampaigns(blog.blocks);
  const campaignById = new Map(
    campaigns.map((campaign) => [
      campaign.key.slice(CAMPAIGN_KEY_PREFIX.length),
      campaign,
    ]),
  );
  const campaignNames = new Map(
    [...campaignById].map(([id, campaign]) => [id, campaign.name]),
  );
  const visible = scopeId
    ? cards.filter((card) => card.virtualMcpId === scopeId)
    : cards;

  const openCard = (id: string | undefined) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, card: id }),
    });

  const move = (card: BlogCard, status: BlogCardStatus) =>
    update.mutate(
      { id: card.id, patch: { status } },
      {
        onError: (err) =>
          toast.error(
            t("contentTrack.card.moveFailed", { error: message(err) }),
          ),
      },
    );

  const startRun = (card: BlogCard, phase: "hypothesis" | "execute") =>
    run.mutate(
      { id: card.id, phase },
      {
        onSuccess: ({ threadId }) =>
          phase === "hypothesis" && openChat({ id: card.id, threadId }),
        onError: (err) =>
          toast.error(
            t("contentTrack.card.runFailed", { error: message(err) }),
          ),
      },
    );

  const start = async (input: NewBlogpost) => {
    let created: BlogCard;
    try {
      created = (
        await create.mutateAsync({
          virtualMcpId: input.virtualMcpId,
          campaignId: input.campaignId,
          ...(input.prompt ? { prompt: input.prompt } : {}),
        })
      ).card;
    } catch (err) {
      toast.error(t("contentTrack.new.failed", { error: message(err) }));
      return;
    }
    setCreating(false);
    try {
      const { threadId } = await run.mutateAsync({
        id: created.id,
        phase: "hypothesis",
      });
      openChat({ id: created.id, threadId });
    } catch (err) {
      openCard(created.id);
      toast.error(t("contentTrack.card.runFailed", { error: message(err) }));
    }
  };

  if (cardId) {
    const card = cards.find((entry) => entry.id === cardId);
    if (!card) {
      return isLoading ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : (
        <>
          <Page.Breadcrumbs
            after="page"
            parent={{
              label: t("contentTrack.title"),
              onSelect: () => openCard(undefined),
            }}
            items={[]}
          />
          <EmptyState
            image={null}
            title={t("contentTrack.card.missingTitle")}
            description={t("contentTrack.card.missingDescription")}
          />
        </>
      );
    }
    return (
      <CardDetail
        card={card}
        campaign={
          card.campaignId ? campaignById.get(card.campaignId) : undefined
        }
        site={projects.find((p) => p.id === card.virtualMcpId)}
        executing={run.isPending}
        onClose={() => openCard(undefined)}
        onOpenChat={() => openChat(card)}
        onRun={(phase) => startRun(card, phase)}
        onMove={(status) => move(card, status)}
      />
    );
  }

  return (
    <>
      <Page.Actions>
        <Button variant="brand" size="sm" onClick={() => setCreating(true)}>
          <Plus size={16} />
          <span className="max-md:sr-only">
            {t("contentTrack.newBlogpost")}
          </span>
        </Button>
      </Page.Actions>
      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : visible.length === 0 ? (
        <EmptyState
          image={null}
          title={t("contentTrack.blogpostsEmptyTitle")}
          description={t("contentTrack.blogpostsEmptyDescription")}
          actions={
            <Button variant="brand" onClick={() => setCreating(true)}>
              <Plus size={16} />
              {t("contentTrack.newBlogpost")}
            </Button>
          }
        />
      ) : (
        <BlogpostsBoard
          cards={visible}
          campaignNames={campaignNames}
          onOpen={(card) => openCard(card.id)}
          onMove={move}
        />
      )}
      <NewBlogpostDialog
        open={creating}
        onOpenChange={setCreating}
        blog={blog}
        catalog={catalog}
        sites={sites}
        siteId={scopeId}
        pending={create.isPending || run.isPending}
        onCreate={(input) => void start(input)}
      />
    </>
  );
}
