/**
 * ThreadAnalysis — the "what's happening here" line on a home card.
 *
 * v1 (this file, Phase 2) is a heuristic: it reuses the manager-oriented status
 * `verb` ("Waiting for your review", "Agent is working", …) so every card has an
 * instant, zero-cost read on where the piece stands. Phase 3 layers a real
 * per-thread LLM summary on top (see `useThreadAnalysis`).
 */
import { getStatusConfig } from "@/web/lib/task-status";
import type { MyThread } from "@/web/hooks/use-my-threads";

export function ThreadAnalysis({ item }: { item: MyThread }) {
  const { thread } = item;
  const heuristic = getStatusConfig(thread.status).verb;

  return (
    <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
      {heuristic}
    </p>
  );
}
