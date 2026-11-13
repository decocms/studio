/**
 * A Blocks (v8) test's status as a pill: off, running or shown to everyone,
 * from its share. The Experiments app and Monitor's read-only view both show
 * it, so the two read the same.
 */

import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { ExperimentStatus } from "@/components/sections-editor/named-rules";
import { useT } from "@/i18n/use-t.ts";

const STATUS_DOT: Record<ExperimentStatus, string> = {
  running: "bg-success",
  everyone: "bg-primary",
  off: "bg-muted-foreground/50",
};

export function ExperimentStatusPill({ status }: { status: ExperimentStatus }) {
  const t = useT();
  const label =
    status === "running"
      ? t("experiments.v8.status.running")
      : status === "everyone"
        ? t("experiments.v8.status.everyone")
        : t("experiments.v8.status.off");
  return (
    <Badge variant="secondary" data-status={status}>
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {label}
    </Badge>
  );
}
