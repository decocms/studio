import { useEffect, useState } from "react";
import { computeElapsedMs, formatDuration } from "@/web/lib/format-time";

export function LiveTimer({ since }: { since: number }) {
  // `since` can be a server-stamped timestamp; clamp at 0 so positive
  // server-vs-client clock skew never renders a negative duration.
  const [elapsed, setElapsed] = useState(() =>
    computeElapsedMs(since, Date.now()),
  );

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- interval required for live elapsed timer
  useEffect(() => {
    const id = setInterval(
      () => setElapsed(computeElapsedMs(since, Date.now())),
      100,
    );
    return () => clearInterval(id);
  }, [since]);

  return (
    <span className="tabular-nums text-sm font-mono text-muted-foreground/50">
      {formatDuration(elapsed / 1000)}
    </span>
  );
}
