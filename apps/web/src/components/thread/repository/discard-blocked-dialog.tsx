/**
 * Shown instead of a discard that would leave pages using a test or campaign
 * that no longer exists (named-rule-discard.ts): nothing was discarded. For
 * each name it says what to discard or change first and lists the pages, in
 * the same calm style as Delete's dialog in the Experiments tab, with one
 * Close button.
 */

import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { NamedRuleDiscardBreak } from "@/components/sections-editor/named-rule-discard.ts";
import { NamedRuleUseList } from "@/components/sections-editor/named-rule-used-by.tsx";

export function DiscardBlockedDialog({
  breaks,
  onClose,
}: {
  breaks: NamedRuleDiscardBreak[] | null;
  onClose: () => void;
}) {
  const t = useT();
  const line = (item: NamedRuleDiscardBreak) => {
    const tests = item.kind === "experiments";
    const name = item.name;
    if (item.cause === "removes") {
      return tests
        ? t("thread.publishPopover.discardBlocked.removesTest", { name })
        : t("thread.publishPopover.discardBlocked.removesCampaign", { name });
    }
    return tests
      ? t("thread.publishPopover.discardBlocked.returnsTest", { name })
      : t("thread.publishPopover.discardBlocked.returnsCampaign", { name });
  };
  return (
    <Dialog open={breaks !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-lg"
        closeButtonClassName="hidden"
        data-testid="discard-blocked"
      >
        <DialogHeader>
          <DialogTitle>
            {t("thread.publishPopover.discardBlocked.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {(breaks ?? []).map(line).join(" ")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-4 overflow-y-auto">
          {(breaks ?? []).map((item) => (
            <div
              key={`${item.kind}:${item.name}`}
              className="flex flex-col gap-2"
            >
              <p className="text-sm text-muted-foreground">{line(item)}</p>
              <NamedRuleUseList rows={item.rows} marked={false} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("thread.publishPopover.discardBlocked.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
