import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { PostEditScreen } from "@/components/sandbox/content/blog/post-edit-screen";
import { BlogWorkspace } from "@/components/sandbox/content/blog/blog-workspace";
import {
  livePostKey,
  planningPostKey,
} from "@/components/sandbox/content/blog/blog-post-id";
import type { BlogPostView } from "@/components/sandbox/content/blog/blog-search-params";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import { BlogSourceGate } from "./blog-source-gate";
import { resolvePanelNavigationSearch } from "./panel-navigation-search";

/**
 * The decofile key holding this post, or `null` when neither form exists.
 *
 * The URL names the post ID, which outlives a status change; the block key
 * does not. Live first: a post that has been promoted may still leave a stale
 * planning block behind, and the live one is what the site renders.
 */
export function resolvePostBlockKey(
  decofile: Record<string, unknown>,
  postId: string,
): string | null {
  const live = livePostKey(postId);
  if (live in decofile) return live;
  const planning = planningPostKey(postId);
  return planning in decofile ? planning : null;
}

export function BlogPostTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false }) as { blogView?: BlogPostView };
  const postId = params.postId ?? "";
  const routeParams = {
    org: params.org ?? "",
    agentId: params.agentId ?? "",
  };
  const openBlog = () => {
    void navigate({
      to: PROJECT_ROUTE.blog,
      params: routeParams,
      // The same session: without it the shell resolves an entry thread
      // again, and may land on another draft.
      search: (prev: Record<string, unknown>) =>
        resolvePanelNavigationSearch({ previous: prev, destination: "agent" }),
    });
  };

  return (
    <BlogSourceGate virtualMcpId={virtualMcpId}>
      <BlogWorkspace>
        {(context) => {
          const blockKey = resolvePostBlockKey(context.decofile, postId);
          if (!blockKey) {
            return (
              <EmptyState
                className="h-full"
                title={t("sandbox.postEditScreen.notFound")}
                description={t("sandbox.postEditScreen.notFoundHint")}
                buttonProps={{
                  children: t("sandbox.collectionsSidebar.posts"),
                  onClick: openBlog,
                }}
              />
            );
          }
          return (
            <PostEditScreen
              orgSlug={context.orgSlug}
              virtualMcpId={context.virtualMcpId}
              branch={context.branch}
              blockKey={blockKey}
              decofile={context.decofile}
              meta={context.meta}
              previewBaseUrl={context.sitePreviewUrl}
              fastPreviewActive={context.fastPreviewActive}
              view={search.blogView}
              onViewChange={(next) => {
                void navigate({
                  to: PROJECT_ROUTE.blogPost,
                  params: { ...routeParams, postId },
                  search: (prev: Record<string, unknown>) => ({
                    ...prev,
                    blogView: next,
                  }),
                  replace: true,
                });
              }}
              onOpenBlog={openBlog}
            />
          );
        }}
      </BlogWorkspace>
    </BlogSourceGate>
  );
}
