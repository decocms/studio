import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBlogPayload } from "@decocms/shared/blog";
import type { BlogCard } from "@decocms/shared/blog-card";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { buildBlogPostPreviewUrl } from "@/components/sandbox/content/blog/blog-preview-url";
import {
  fetchDecofile,
  getDecofileDraft,
} from "@/components/sections-editor/decofile-api";
import { buildDraftPointer } from "@/components/sections-editor/section-preview-url";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";

/** Why a card shows no preview: each one asks something different of a person. */
export type CardPreviewGap =
  | "not-written"
  | "no-preview-server"
  | "no-cms"
  | "no-route"
  | "unavailable";

export interface CardPreview {
  url: string | null;
  gap: CardPreviewGap | null;
  loading: boolean;
}

/** Well inside the six hours a draft grant lives, so an open card never holds a dead one. */
const PREVIEW_STALE_MS = 30 * 60_000;

/** What a failed read of the branch says about the site. */
export function previewGapOf(err: unknown): CardPreviewGap {
  const status = (err as { status?: number } | null)?.status;
  if (status === 403) return "no-cms";
  if (status === 404) return "no-preview-server";
  return "unavailable";
}

/**
 * The card's post as its site renders it, from the card's own branch.
 *
 * The site pulls the branch through the draft pointer Fast Preview uses, and
 * the decofile API shows that pull a planning post as published, so no sandbox
 * runs. The read waits for the commit: a session read creates a missing branch.
 */
export function useCardPreview(
  card: BlogCard,
  site: VirtualMCPEntity | undefined,
): CardPreview {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const previewBaseUrl = resolvePreviewServerUrl(site?.metadata);
  const { postKey, branch, commit, virtualMcpId } = card;
  const written = !!postKey && !!branch && !!commit;

  const query = useQuery({
    queryKey: KEYS.blogCardPreview(
      org.slug,
      virtualMcpId,
      branch ?? "",
      commit ?? "",
    ),
    enabled: written && !!previewBaseUrl,
    staleTime: PREVIEW_STALE_MS,
    retry: false,
    queryFn: async (): Promise<Pick<CardPreview, "url" | "gap">> => {
      if (!postKey || !branch) return { url: null, gap: "not-written" };
      const scope = { orgSlug: org.slug, virtualMcpId, branch };
      let decofile: Record<string, unknown> | undefined;
      try {
        decofile = await fetchDecofile(queryClient, scope);
      } catch (err) {
        return { url: null, gap: previewGapOf(err) };
      }
      const draft = getDecofileDraft(queryClient, scope);
      // A hosted site answers with its own draft and no decofile: no branch to show.
      if (!decofile || !draft) return { url: null, gap: "unavailable" };
      const block = decofile[postKey];
      const url = buildBlogPostPreviewUrl({
        decofile,
        post: getBlogPayload(
          block && typeof block === "object"
            ? (block as Record<string, unknown>)
            : undefined,
          "posts",
        ),
        previewBaseUrl,
        draftPointer: buildDraftPointer({
          ...draft,
          orgSlug: org.slug,
          virtualMcpId,
          branch,
        }),
      });
      return url ? { url, gap: null } : { url: null, gap: "no-route" };
    },
  });

  if (!written) return { url: null, gap: "not-written", loading: false };
  if (!previewBaseUrl) {
    return { url: null, gap: "no-preview-server", loading: false };
  }
  return {
    url: query.data?.url ?? null,
    gap: query.data?.gap ?? (query.isError ? "unavailable" : null),
    loading: query.isLoading,
  };
}
