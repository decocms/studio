import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useMoveBlocks } from "@/components/sections-editor/use-move-blocks";
import {
  APPS_UPDATE_COMMAND,
  type BlogSupport,
  postStatusUnsupported,
} from "./blog-capabilities";
import {
  blocksPostStatus,
  getBlogPayload,
  movePostToStatus,
  type PostStatus,
  postIdOfKey,
  postStatus,
} from "./blog-data";

/** Lane labels — one map, so the board and the editor can't drift apart. */
export const POST_STATUS_LABEL: Record<PostStatus, TranslationKey> = {
  draft: "sandbox.postBoard.laneDraft",
  generating: "sandbox.postBoard.laneGenerating",
  awaiting_review: "sandbox.postBoard.laneAwaitingReview",
  scheduled: "sandbox.postBoard.laneScheduled",
  published: "sandbox.postBoard.lanePublished",
  archived: "sandbox.postBoard.laneArchived",
};

/** Why a target lane is refused, or null when the move may go ahead. */
export type MoveRefusal =
  /** Required fields are missing — the post can't go live yet. */
  | { kind: "incomplete" }
  /** The site's blog app is too old to honour this state. */
  | { kind: "unsupported"; required: string; version: string | null }
  /** A move for this post is already in flight. */
  | { kind: "in-flight" }
  /** `generating` is owned by the generation run, never set by hand. */
  | { kind: "not-a-target" };

interface UsePostStatusMoveParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  support: BlogSupport;
  /**
   * A move across forms renamed the block. Reported as (from, to) rather than
   * just the new key, so a caller only re-points if it was on that post — the
   * board drags posts it has not opened.
   */
  onMoved?: (fromKey: string, toKey: string) => void;
}

/**
 * The one path a post takes to a new status, shared by the board's drag-and-drop,
 * the delete-into-Archived action and the editor's status control.
 *
 * Every surface asks {@link PostStatusMove.refuse} the same question before
 * offering the move, and every surface applies it through the same atomic
 * `useMoveBlocks`, so none of them can disagree or leave a half-moved post.
 */
export function usePostStatusMove({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  support,
  onMoved,
}: UsePostStatusMoveParams): PostStatusMove {
  const t = useT();
  const move = useMoveBlocks({ orgSlug, virtualMcpId, branch });
  // Keyed by post id, not block key: the key changes mid-move, the id doesn't.
  const [movingIds, setMovingIds] = useState<ReadonlySet<string>>(new Set());

  const payloadOf = (key: string) =>
    getBlogPayload(
      decofile[key] as Record<string, unknown> | undefined,
      "posts",
    );

  const refuse = (
    key: string,
    next: PostStatus,
    payload = payloadOf(key),
  ): MoveRefusal | null => {
    if (next === "generating") return { kind: "not-a-target" };
    if (movingIds.has(postIdOfKey(key))) return { kind: "in-flight" };
    const unsupported = postStatusUnsupported(support, next);
    if (unsupported) return { kind: "unsupported", ...unsupported };
    if (blocksPostStatus(payload, next)) return { kind: "incomplete" };
    return null;
  };

  const reasonText = (refusal: MoveRefusal): string => {
    switch (refusal.kind) {
      case "unsupported":
        return t("sandbox.postBoard.moveUnsupported", {
          required: refusal.required,
          command: APPS_UPDATE_COMMAND,
        });
      case "incomplete":
        return t("sandbox.postBoard.moveBlocked");
      case "in-flight":
        return t("sandbox.postBoard.moveInFlight");
      case "not-a-target":
        return t("sandbox.postBoard.moveNotATarget");
      default: {
        const _exhaustive: never = refusal;
        return String(_exhaustive);
      }
    }
  };

  const apply = async (
    key: string,
    next: PostStatus,
    /** The editor's live draft, when it has unsaved edits the move must carry. */
    draft?: Record<string, unknown>,
  ) => {
    const payload = draft ?? payloadOf(key);
    if (postStatus(payload) === next) return null;
    const refusal = refuse(key, next, payload);
    if (refusal) {
      if (refusal.kind !== "in-flight") toast.error(reasonText(refusal));
      return null;
    }
    const id = postIdOfKey(key);
    setMovingIds((prev) => new Set(prev).add(id));
    const plan = movePostToStatus({ key, payload }, next, new Date());
    const targetKey = Object.keys(plan.writes)[0] ?? key;
    /**
     * Report at dispatch, not when the write comes back. `move` retires the old
     * key from the cache right away, so an editor still pointed at it would
     * render an empty post — a title that blanks to "Untitled" — for the whole
     * round-trip.
     */
    if (targetKey !== key) onMoved?.(key, targetKey);
    try {
      await move.move(plan);
      return targetKey;
    } catch (err) {
      // `move` already restored the cache; put the caller back on the old key.
      if (targetKey !== key) onMoved?.(targetKey, key);
      toast.error(
        err instanceof Error ? err.message : t("sandbox.postBoard.moveFailed"),
      );
      return null;
    } finally {
      setMovingIds((prev) => {
        const rest = new Set(prev);
        rest.delete(id);
        return rest;
      });
    }
  };

  return {
    apply,
    refuse,
    reasonText,
    isMoving: (key: string) => movingIds.has(postIdOfKey(key)),
  };
}

export interface PostStatusMove {
  /** Persist the transition. Resolves to the post's new key, or null if refused. */
  apply: (
    key: string,
    next: PostStatus,
    draft?: Record<string, unknown>,
  ) => Promise<string | null>;
  /** Why this target is unavailable, or null when it's offerable. */
  refuse: (
    key: string,
    next: PostStatus,
    payload?: Record<string, unknown>,
  ) => MoveRefusal | null;
  /** User-facing sentence for a refusal. */
  reasonText: (refusal: MoveRefusal) => string;
  isMoving: (key: string) => boolean;
}
