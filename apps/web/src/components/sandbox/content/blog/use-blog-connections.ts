/**
 * The blog's two required connections, as the browser sees them — the same
 * rules the server refuses by (`@decocms/shared/blog-connections`), so the
 * screen says what is missing before a click spends anything.
 */

import { useQuery } from "@tanstack/react-query";
import {
  type BlogConnectionStatus,
  blogConnectionStatus,
  pickBlogConnection,
} from "@decocms/shared/blog-connections";
import { KEYS } from "@/lib/query-keys";
import { useConnections, useProjectContext } from "@/sdk";

export interface BlogConnections {
  vtex: BlogConnectionStatus & { slug: string | null };
  ga4: BlogConnectionStatus & { slug: string | null };
  /** Both connected: the blog may proceed. */
  ready: boolean;
  /** False while GA4's sign-in is still being read. */
  settled: boolean;
}

export function useBlogConnections(): BlogConnections {
  const { org } = useProjectContext();
  const connections = useConnections();
  const vtex = pickBlogConnection("vtex", connections);
  const ga4 = pickBlogConnection("ga4", connections);

  /** A GA4 that signs in with OAuth: whether its stored token still works. */
  const needsToken = !!ga4 && !ga4.connection_token && !!ga4.oauth_config;
  const token = useQuery({
    queryKey: KEYS.blogConnectionToken(org.id, ga4?.id ?? ""),
    enabled: needsToken,
    retry: false,
    queryFn: async () => {
      const response = await fetch(
        `/api/${encodeURIComponent(org.slug)}/connections/${encodeURIComponent(ga4?.id ?? "")}/oauth-token/status`,
        { credentials: "include" },
      );
      if (!response.ok) return false;
      const data = (await response.json()) as {
        hasToken?: boolean;
        isExpired?: boolean;
        canRefresh?: boolean;
      };
      return !!data.hasToken && (!data.isExpired || !!data.canRefresh);
    },
  });

  const signedIn = !needsToken || token.data === true;
  const vtexStatus = {
    ...blogConnectionStatus("vtex", vtex, true),
    slug: vtex?.slug ?? null,
  };
  const ga4Status = {
    ...blogConnectionStatus("ga4", ga4, signedIn),
    slug: ga4?.slug ?? null,
  };
  return {
    vtex: vtexStatus,
    ga4: ga4Status,
    ready: vtexStatus.gap === null && ga4Status.gap === null,
    settled: !needsToken || !token.isLoading,
  };
}
