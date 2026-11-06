import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { BlogBrowser } from "@/components/sandbox/content/blog/blog-browser";
import { BlogWorkspace } from "@/components/sandbox/content/blog/blog-workspace";
import { postIdOfKey } from "@/components/sandbox/content/blog/blog-post-id";
import type {
  BlogCollectionId,
  BlogSearchParams,
} from "@/components/sandbox/content/blog/blog-search-params";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { BlogSourceGate } from "./blog-source-gate";
import { resolvePanelNavigationSearch } from "./panel-navigation-search";

export function BlogTab({ virtualMcpId }: { virtualMcpId: string }) {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false }) as BlogSearchParams;
  const collection: BlogCollectionId = search.blogCollection ?? "posts";
  const routeParams = {
    org: params.org ?? "",
    agentId: params.agentId ?? "",
  };

  /**
   * Collection and selection live in the URL, so a deep link opens exactly
   * what it names. `replace`, because switching collections is picking a tab:
   * leaving an entry per click would make Back walk the sidebar instead of
   * returning to wherever the reader came from.
   */
  const setSearch = (next: Partial<BlogSearchParams>) => {
    void navigate({
      to: PROJECT_ROUTE.blog,
      params: routeParams,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...next }),
      replace: true,
    });
  };

  return (
    <BlogSourceGate virtualMcpId={virtualMcpId}>
      <BlogWorkspace>
        {(context) => (
          <BlogBrowser
            context={context}
            collection={collection}
            item={search.blogItem}
            onOpenCollection={(next) =>
              setSearch({ blogCollection: next, blogItem: undefined })
            }
            onSelectItem={(key) => setSearch({ blogItem: key })}
            onOpenPost={(blockKey) => {
              void navigate({
                to: PROJECT_ROUTE.blogPost,
                params: { ...routeParams, postId: postIdOfKey(blockKey) },
                // The same session: without it the shell resolves an entry
                // thread again, and may land on another draft.
                search: (prev: Record<string, unknown>) =>
                  resolvePanelNavigationSearch({
                    previous: prev,
                    destination: "agent",
                  }),
              });
            }}
          />
        )}
      </BlogWorkspace>
    </BlogSourceGate>
  );
}
