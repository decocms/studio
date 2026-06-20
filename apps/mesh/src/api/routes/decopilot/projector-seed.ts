// RESUME_MODE = "completed-only" (confirmed by Task 0 spike 2026-06-19)

import type { UIMessage } from "ai";
import {
  foldParts,
  type FoldedMessage,
  type ThreadMessagePart,
} from "@/storage/fold-parts";

export function foldedToUIMessage(m: FoldedMessage): UIMessage {
  return {
    id: m.id,
    role: m.role,
    parts: m.parts as UIMessage["parts"],
    metadata: m.metadata ?? undefined,
  };
}

export function buildSeedFromParts(parts: ThreadMessagePart[]): UIMessage[] {
  return foldParts(parts)
    .filter((m) => m.status === "complete")
    .map(foldedToUIMessage);
}
