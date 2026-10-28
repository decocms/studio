/**
 * The content track: the brand's blogposts on a board of their own, and the
 * campaigns they belong to. Two gates stand in front of it, in this order: a
 * brand guide a post can be written from, then the VTEX and GA4 connections
 * every post reads.
 */

import type { ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { BlogConnectionsGate } from "@/components/sandbox/content/blog/blog-connections-gate";
import { useBlogState } from "@/components/sandbox/content/blog/use-blog-state";
import { useT } from "@/i18n/use-t.ts";
import { Campaigns } from "@/layouts/context/brand-campaigns";
import { useProjectContext } from "@/sdk";
import { ContentSetup } from "./content-setup";
import { contentTrackGate } from "./track-state";

type ContentView = "blogposts" | "campaigns";

function BlogpostsPlaceholder() {
  const t = useT();
  return (
    <EmptyState
      image={null}
      title={t("contentTrack.blogpostsEmptyTitle")}
      description={t("contentTrack.blogpostsEmptyDescription")}
    />
  );
}

export function ContentTrack({ trackTabs }: { trackTabs: ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const blog = useBlogState({ orgSlug: org.slug });
  const search = useSearch({ strict: false }) as { view?: string };
  const view: ContentView =
    search.view === "campaigns" ? "campaigns" : "blogposts";
  const state = contentTrackGate(blog);

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
      <Page.Title>{t("contentTrack.title")}</Page.Title>
      <Panel.Toolbar.Left.Portal>
        <Page.Tabs>
          {trackTabs}
          {state.gate === "open" && (
            <>
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
      <Page.Content>
        <Page.Container>
          {state.gate === "loading" ? (
            <Skeleton className="h-64 w-full rounded-2xl" />
          ) : state.gate === "setup" ? (
            <ContentSetup missing={state.missing} />
          ) : (
            <BlogConnectionsGate>
              {view === "campaigns" ? <Campaigns /> : <BlogpostsPlaceholder />}
            </BlogConnectionsGate>
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
