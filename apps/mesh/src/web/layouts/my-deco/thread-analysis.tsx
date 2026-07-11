/**
 * ThreadAnalysis — the "what's happening here" line on a home card.
 *
 * Two layers:
 *  1. Instant heuristic — the manager-oriented status `verb` ("Waiting for your
 *     review", "Agent is working", …). Always available, zero cost.
 *  2. Content-grounded summary — the latest agent activity, pulled from the
 *     thread's actual messages (see `useThreadAnalysis`). Fetched only for
 *     active threads; replaces the heuristic once it lands.
 *
 * The status verb stays as a small prefix so you keep the "what it means for me"
 * read even when the content line is a raw agent message.
 */
import { getStatusConfig } from "@/web/lib/task-status";
import { useThreadAnalysis } from "@/web/hooks/use-thread-analysis";
import type { MyThread } from "@/web/hooks/use-my-threads";

export function ThreadAnalysis({ item }: { item: MyThread }) {
  const { thread } = item;
  const { verb } = getStatusConfig(thread.status);
  const { summary, isLoading } = useThreadAnalysis(item);

  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {isLoading ? (
          <span className="inline-block h-2.5 w-24 rounded bg-muted animate-pulse align-middle" />
        ) : (
          verb
        )}
      </p>
      {summary && (
        <p className="text-xs leading-relaxed text-foreground/80 line-clamp-2">
          {summary}
        </p>
      )}
    </div>
  );
}
