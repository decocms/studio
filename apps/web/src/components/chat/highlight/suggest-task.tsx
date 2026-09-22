import { Button } from "@decocms/ui/components/button.tsx";
import { ClipboardCheck } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { SuggestTaskToolPart } from "../types";
import { CollapsibleHighlight } from "./collapsible-highlight";

/** Inferred from the part so the UI doesn't import the backend schema. */
type SuggestTaskInput = NonNullable<SuggestTaskToolPart["input"]>;

export function SuggestTaskHighlight({
  parts,
  isStreaming,
  onRespond,
}: {
  parts: SuggestTaskToolPart[];
  isStreaming: boolean;
  onRespond: (part: SuggestTaskToolPart, accepted: boolean) => void;
}) {
  const t = useT();
  // One offer at a time — stacking cards turns an offer into a form.
  const part = parts.at(-1);
  const input = part?.input as SuggestTaskInput | undefined;
  if (!part || !input?.title) return null;

  return (
    <CollapsibleHighlight
      icon={<ClipboardCheck size={14} />}
      label={t("chat.suggestTask.label")}
      title={input.title}
      defaultExpanded={true}
      footerRight={
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7"
            disabled={isStreaming}
            onClick={() => onRespond(part, false)}
          >
            {t("chat.suggestTask.notNow")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7"
            disabled={isStreaming}
            onClick={() => onRespond(part, true)}
          >
            {t("chat.suggestTask.create")}
          </Button>
        </>
      }
    >
      {input.summary ? (
        <p className="px-4 pb-1 text-sm leading-snug text-muted-foreground whitespace-pre-wrap">
          {input.summary}
        </p>
      ) : null}
    </CollapsibleHighlight>
  );
}
