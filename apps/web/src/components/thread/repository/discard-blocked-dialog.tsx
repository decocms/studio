/**
 * Shown instead of a discard that would leave pages using a test or campaign
 * that no longer exists (named-rule-discard.ts): nothing was discarded. Same
 * shape and tone as Delete's dialog in the Experiments tab: a title asking to
 * change these pages first, one short line per name, its pages (each opening
 * in the site editor), and Close. Discard all is never blocked.
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
import type { NamedRuleUseRow } from "@/components/sections-editor/named-rule-uses.ts";

export function DiscardBlockedDialog({
  breaks,
  onClose,
  onOpen,
}: {
  breaks: NamedRuleDiscardBreak[] | null;
  onClose: () => void;
  /** Opens a page or section in the site editor (the dialog closes first). */
  onOpen: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  const line = (item: NamedRuleDiscardBreak) => {
    const tests = item.kind === "experiments";
    const name = item.name;
    if (item.cause === "removes") {
      return tests
        ? t("thread.publishPopover.discardBlocked.usesTest", { name })
        : t("thread.publishPopover.discardBlocked.usesCampaign", { name });
    }
    return t("thread.publishPopover.discardBlocked.returns", { name });
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
              <NamedRuleUseList
                rows={item.rows}
                marked={false}
                onOpen={(row) => {
                  onClose();
                  onOpen(row);
                }}
              />
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
