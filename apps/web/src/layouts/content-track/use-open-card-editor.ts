import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BlogCard } from "@decocms/shared/blog-card";
import { useThreadManager } from "@/components/chat/store/hooks";
import { authClient } from "@/lib/auth-client";
import { useProjectContext } from "@/sdk";
import { cardTitle } from "./card-model";

/**
 * A person's Site Editor chat on a card's branch. Fixed per organization, card
 * and person, so opening the editor again reuses the chat and a teammate gets
 * a chat of their own. Shaped like the card's own chat id (`blogCardThreadId`).
 */
export async function cardEditorThreadId(
  orgId: string,
  cardId: string,
  userId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`blog-card-editor:${orgId}:${cardId}:${userId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `thrd_${hex.slice(0, 32)}`;
}

/**
 * Open the Site Editor on the card's branch, with the post open.
 *
 * The editor follows its chat's branch and takes none of its own, so the card
 * opens it through a chat on `blog-<id>`. The create is idempotent: a second
 * open finds the chat it made the first time.
 */
export function useOpenCardEditor() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const threads = useThreadManager();
  const { data: session } = authClient.useSession();
  const [opening, setOpening] = useState(false);
  const userId = session?.user?.id;

  const open = async (card: BlogCard) => {
    if (!userId || !card.branch || !card.postKey) return;
    setOpening(true);
    try {
      const thread = await cardEditorThreadId(org.id, card.id, userId);
      await threads.create({
        id: thread,
        virtual_mcp_id: card.virtualMcpId,
        branch: card.branch,
        title: cardTitle(card) || undefined,
      });
      await navigate({
        to: "/$org/projects/$agentId/site-editor/content",
        params: { org: org.slug, agentId: card.virtualMcpId },
        search: {
          thread,
          contentCollection: "posts",
          contentItem: card.postKey,
        },
      });
    } catch {
      // The create toasts its own failure; the card stays where it was.
    } finally {
      setOpening(false);
    }
  };

  return { open, opening, ready: !!userId };
}
