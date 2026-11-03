import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getBlogPayload } from "@decocms/shared/blog";
import type { BlogCard } from "@decocms/shared/blog-card";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { buildBlogPostPreviewUrl } from "@/components/sandbox/content/blog/blog-preview-url";
import {
  type DecofileDraft,
  fetchDecofile,
  getDecofileDraft,
} from "@/components/sections-editor/decofile-api";
import { buildDraftPointer } from "@/components/sections-editor/section-preview-url";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { cardPostKey } from "./card-post-move";

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

/** The card's branch as read at its commit: the decofile, and the draft pointer of that read. */
export interface CardBranch {
  decofile: Record<string, unknown>;
  draft: DecofileDraft;
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

/** Whether the card's post is on its branch yet: a commit carries it. */
export function cardWritten(card: BlogCard): boolean {
  return !!card.postKey && !!card.branch && !!card.commit;
}

/**
 * The card's branch at its commit, read once for the preview, the Publishing
 * tab and a status move. Null for a hosted site, which answers with its own
 * draft and no decofile.
 */
export function cardBranchQuery(
  queryClient: QueryClient,
  orgSlug: string,
  card: Pick<BlogCard, "branch" | "commit" | "virtualMcpId">,
) {
  const { branch, commit, virtualMcpId } = card;
  return {
    queryKey: KEYS.blogCardDecofile(
      orgSlug,
      virtualMcpId,
      branch ?? "",
      commit ?? "",
    ),
    staleTime: PREVIEW_STALE_MS,
    retry: false,
    queryFn: async (): Promise<CardBranch | null> => {
      if (!branch) return null;
      const scope = { orgSlug, virtualMcpId, branch };
      const decofile = await fetchDecofile(queryClient, scope);
      const draft = getDecofileDraft(queryClient, scope);
      return decofile && draft ? { decofile, draft } : null;
    },
  };
}

/** The read waits for the commit: a session read creates a missing branch. */
export function useCardBranch(card: BlogCard, enabled = true) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  return useQuery({
    ...cardBranchQuery(queryClient, org.slug, card),
    enabled: enabled && cardWritten(card),
  });
}

/**
 * The card's post as its site renders it, from the card's own branch.
 *
 * The site pulls the branch through the draft pointer Fast Preview uses, and
 * the decofile API shows that pull a planning post as published, so no sandbox
 * runs.
 */
export function useCardPreview(
  card: BlogCard,
  site: VirtualMCPEntity | undefined,
): CardPreview {
  const { org } = useProjectContext();
  const previewBaseUrl = resolvePreviewServerUrl(site?.metadata);
  const query = useCardBranch(card, !!previewBaseUrl);
  const { branch, virtualMcpId } = card;
  const read = query.data;

  const postKey = read ? cardPostKey(card, read.decofile) : null;
  const block = read && postKey ? read.decofile[postKey] : undefined;
  const url =
    read && branch && previewBaseUrl
      ? buildBlogPostPreviewUrl({
          decofile: read.decofile,
          post: getBlogPayload(
            block && typeof block === "object"
              ? (block as Record<string, unknown>)
              : undefined,
            "posts",
          ),
          previewBaseUrl,
          draftPointer: buildDraftPointer({
            ...read.draft,
            orgSlug: org.slug,
            virtualMcpId,
            branch,
          }),
        })
      : null;

  if (!cardWritten(card)) {
    return { url: null, gap: "not-written", loading: false };
  }
  if (!previewBaseUrl) {
    return { url: null, gap: "no-preview-server", loading: false };
  }
  if (query.isError) {
    return { url: null, gap: previewGapOf(query.error), loading: false };
  }
  if (query.isLoading) return { url: null, gap: null, loading: true };
  if (!read) return { url: null, gap: "unavailable", loading: false };
  return url
    ? { url, gap: null, loading: false }
    : { url: null, gap: "no-route", loading: false };
}
