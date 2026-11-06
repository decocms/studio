import {
  blogDraftBranchName,
  generateBranchName,
} from "@decocms/shared/branch-name";
import { RELEASES_MAX } from "@decocms/shared/sdk/types";
import { toast } from "sonner";
import {
  errorDetail,
  errorDetailsDescription,
} from "@/components/sections-editor/site-editor-toast.tsx";
import { useT } from "@/i18n/use-t.ts";
import { type DraftKind, draftNameKey } from "@/lib/draft-kind";
import { nextDraftName, nextReleaseColor, useReleases } from "./use-releases";

/**
 * Starts a new draft the way the version switcher's "New draft" does: a fresh
 * branch, listed as the next "Draft N" (a Blog draft, as the next "Blog Draft
 * N"). Returns the branch for the caller to open, or `null` at the release cap
 * (after saying so).
 */
export function useStartDraft(params: {
  virtualMcpId: string;
  userLabel: string | null | undefined;
  userId: string;
  /** The view's kind of draft; the site's when not given. */
  kind?: DraftKind;
}): () => string | null {
  const t = useT();
  const { releases, createRelease } = useReleases(params.virtualMcpId);
  return () => {
    // At RELEASES_MAX the server rejects another create.
    if (releases.length >= RELEASES_MAX) {
      toast.error(t("thread.branchPicker.capReached", { max: RELEASES_MAX }));
      return null;
    }
    const branch =
      params.kind === "blog"
        ? blogDraftBranchName(params.userLabel)
        : generateBranchName(params.userLabel);
    createRelease({
      branch,
      name: nextDraftName(releases, t(draftNameKey(branch))),
      color: nextReleaseColor(releases.length),
      createdBy: params.userId,
      createdAt: new Date().toISOString(),
    }).catch((err: unknown) => {
      // A failed release write reverts the row silently otherwise.
      toast.error(t("thread.branchPicker.saveError"), {
        description: errorDetailsDescription(t, errorDetail(err)),
      });
    });
    return branch;
  };
}
