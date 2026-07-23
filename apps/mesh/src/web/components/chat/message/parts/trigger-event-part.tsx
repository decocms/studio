import { useT } from "@/web/i18n/use-t.ts";
import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown, Lightning01 } from "@untitledui/icons";

export interface TriggerEventData {
  source: string;
  type: string;
  data: unknown;
}

/**
 * Renders the structured payload of an event/webhook-fired automation run as a
 * dedicated card on the user message, instead of the raw guard-wrapped JSON the
 * model sees. Collapsed by default; expands to a pretty-printed payload.
 */
export function TriggerEventPart({ event }: { event: TriggerEventData }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const payload = JSON.stringify(event.data, null, 2);

  return (
    <div className="rounded-lg border border-border/60 bg-background overflow-hidden text-left">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm cursor-pointer"
      >
        <Lightning01 className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {t("chat.triggerEventPart.triggeredByEvent")}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {event.type}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border/60 px-3 py-2">
          <div className="mb-2 text-xs text-muted-foreground">
            {event.source}
          </div>
          <pre className="overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">
            {payload}
          </pre>
        </div>
      )}
    </div>
  );
}
