import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  type BlogCollectionId,
  blogDeepLinkTarget,
  blogViewFallbackSearch,
} from "@/components/sandbox/content/blog/blog-search-params";
import { useBlogViewState } from "@/hooks/use-blog-view";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { PanelLoading } from "@/layouts/main-panel-boundary";

type ProjectParams = { org?: string; agentId?: string };

/**
 * Blog's routes are the org's Blog view (`blog_view_enabled`). Without it the
 * blog lives in the Site Editor's Content tab, so a Blog link (a shared URL, a
 * recent app) opens there instead. Waits while the flag loads.
 */
export function BlogViewGate({ children }: { children: ReactNode }) {
  const blogView = useBlogViewState();
  const params = useParams({ strict: false }) as ProjectParams;
  const search = useSearch({ strict: false }) as {
    blogCollection?: BlogCollectionId;
    blogItem?: string;
  };
  if (blogView === undefined) return <PanelLoading />;
  if (blogView || !params.org || !params.agentId) return children;
  return (
    <Navigate
      to={PROJECT_ROUTE.siteEditorContent}
      params={{ org: params.org, agentId: params.agentId }}
      search={(prev: Record<string, unknown>) => ({
        ...prev,
        blogCollection: undefined,
        blogItem: undefined,
        blogView: undefined,
        ...blogViewFallbackSearch(search),
      })}
      hash={true}
      replace
    />
  );
}

/**
 * The Blog Manager's "Editar no Studio" link points at the Site Editor's
 * Content tab. With the org's Blog view on, the blog isn't there: the link
 * opens in Blog. Waits while the flag loads, rather than open the Content tab
 * and leave it.
 */
export function BlogDeepLinkHandoff({ children }: { children: ReactNode }) {
  const blogView = useBlogViewState();
  const params = useParams({ strict: false }) as ProjectParams;
  const search = useSearch({ strict: false }) as {
    contentCollection?: string;
    contentItem?: string;
  };
  const { org, agentId } = params;
  // The account-less Site Editor has no project to hand the link to.
  const target = org && agentId ? blogDeepLinkTarget(search) : null;
  if (!target || !org || !agentId || blogView === false) return children;
  if (blogView === undefined) return <PanelLoading />;
  const clearContentDeepLink = (prev: Record<string, unknown>) => ({
    ...prev,
    contentCollection: undefined,
    contentItem: undefined,
  });
  return target.postId ? (
    <Navigate
      to={PROJECT_ROUTE.blogPost}
      params={{ org, agentId, postId: target.postId }}
      search={clearContentDeepLink}
      hash={true}
      replace
    />
  ) : (
    <Navigate
      to={PROJECT_ROUTE.blog}
      params={{ org, agentId }}
      search={(prev: Record<string, unknown>) => ({
        ...clearContentDeepLink(prev),
        blogCollection: target.collection,
        blogItem: target.item,
      })}
      hash={true}
      replace
    />
  );
}
