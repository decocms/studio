/**
 * Handing blog work to the site's agent, and keeping hold of the thread.
 *
 * The screens here used to call a generation tool and hold the request open
 * while it worked — a spinner for up to two minutes, and nothing to show for
 * it if the person closed the tab. A run answers at once with the thread it
 * will happen in, so what the caller keeps is not a promise of a result but a
 * place to watch one being made.
 */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";

export interface BlogRunBrief {
  prompt: string;
  title?: string;
}

/** The thread a run is happening in, while the sheet is open on it. */
export interface WatchedRun {
  id: string;
  title: string | null;
}

export function useBlogRun(virtualMcpId: string) {
  const t = useT();
  const studio = useStudioTools();
  const [watching, setWatching] = useState<WatchedRun | null>(null);

  const start = useMutation({
    mutationFn: (brief: BlogRunBrief) =>
      studio.call("BLOG_RUN_START", { virtualMcpId, ...brief }),
    onSuccess: ({ threadId }, brief) => {
      setWatching({ id: threadId, title: brief.title ?? null });
      toast.success(t("sandbox.blogRun.started"));
    },
    onError: () => toast.error(t("sandbox.blogRun.failed")),
  });

  return {
    /** Queue the work. Resolves as soon as the run has somewhere to happen. */
    start: (brief: BlogRunBrief) => start.mutate(brief),
    isStarting: start.isPending,
    /** The run being read, or null. Opening one does not stop the others. */
    watching,
    watch: setWatching,
    stopWatching: () => setWatching(null),
  };
}
