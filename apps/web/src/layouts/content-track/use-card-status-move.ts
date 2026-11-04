/**
 * Moving a card moves its post first, on the card's branch, and then the card,
 * so the status a person picks is the one the site renders. Two writes in that
 * order, as the Publishing tab's are: a card that fails to follow still finds
 * its post by id.
 */

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BlogCard, BlogCardStatus } from "@decocms/shared/blog-card";
import { decoBlockFingerprint } from "@decocms/shared/decofile";
import {
  BlockConflictError,
  type DecofileDraft,
} from "@/components/sections-editor/decofile-api";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { cardPostMove } from "./card-post-move";
import type { CardPatch } from "./card-publishing";
import {
  type CardBranch,
  cardBranchQuery,
  cardWritten,
  writeCardBranch,
} from "./use-card-preview";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function useCardStatusMove(
  update: (input: { id: string; patch: CardPatch }) => Promise<unknown>,
) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();

  return async (card: BlogCard, status: BlogCardStatus) => {
    const moveCard = (
      patch: CardPatch,
      failed:
        | "contentTrack.card.moveFailed"
        | "contentTrack.publish.cardBehind" = "contentTrack.card.moveFailed",
    ) =>
      update({ id: card.id, patch }).catch((err) =>
        toast.error(t(failed, { error: message(err) })),
      );
    if (status === "generating" || !cardWritten(card) || !card.branch) {
      await moveCard({ status });
      return;
    }

    const live = status === "scheduled" || status === "published";
    const query = cardBranchQuery(queryClient, org.slug, card);
    let read: CardBranch | null;
    try {
      // Fresh: a move decided on a stale read refuses a post someone just completed.
      read = await queryClient.fetchQuery({ ...query, staleTime: 0 });
    } catch (err) {
      if (live) {
        toast.error(t("contentTrack.card.moveFailed", { error: message(err) }));
        return;
      }
      // Only putting a post live needs its branch; the board can follow without it.
      toast.warning(t("contentTrack.card.postNotMoved"));
      await moveCard({ status });
      return;
    }
    if (!read) {
      // A hosted site answers with no decofile to move the post in.
      toast.warning(t("contentTrack.card.postNotMoved"));
      await moveCard({ status });
      return;
    }

    const move = cardPostMove(card, read.decofile, status, new Date());
    if (move.kind === "missing") {
      if (live) {
        toast.error(t("contentTrack.card.postMissing"));
        return;
      }
      await moveCard({ status });
      return;
    }
    if (move.kind === "incomplete") {
      toast.error(t("sandbox.postBoard.moveBlocked"));
      return;
    }
    if (move.kind === "same") {
      await moveCard(
        move.key === card.postKey ? { status } : { status, postKey: move.key },
      );
      return;
    }

    let pointer: DecofileDraft;
    try {
      pointer = await writeCardBranch(
        queryClient,
        org.slug,
        { virtualMcpId: card.virtualMcpId, branch: card.branch },
        read,
        {
          set: move.plan.writes,
          delete: move.plan.deletes,
          expect: {
            [move.from]: await decoBlockFingerprint(read.decofile[move.from]),
            ...(move.to !== move.from && { [move.to]: null }),
          },
        },
      );
    } catch (err) {
      if (err instanceof BlockConflictError) {
        toast.error(t("contentTrack.publish.conflict"));
        void queryClient.invalidateQueries({ queryKey: query.queryKey });
      } else {
        toast.error(t("contentTrack.card.moveFailed", { error: message(err) }));
      }
      return;
    }
    await moveCard(
      { status, postKey: move.to, commit: pointer.version },
      "contentTrack.publish.cardBehind",
    );
  };
}
