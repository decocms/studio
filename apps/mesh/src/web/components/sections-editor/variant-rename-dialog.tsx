import { type FormEvent, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Loading01 } from "@untitledui/icons";
import { useT } from "@/web/i18n/use-t.ts";

/**
 * Renames a page variant by saving its matcher as a global block and pointing
 * the variant rule at that block. Clearing the input inlines the matcher again.
 */
export function VariantRenameDialog({
  open,
  initialName,
  autoLabel,
  isPending = false,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  initialName: string;
  autoLabel: string;
  isPending?: boolean;
  onSubmit: (name: string) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setName(initialName);
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isPending) {
      onOpenChange(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isPending) return;
    await onSubmit(name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {t("sectionsEditor.variantRenameDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("sectionsEditor.variantRenameDialog.description", {
                fallback:
                  autoLabel ||
                  t("sectionsEditor.variantRenameDialog.defaultFallback"),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5 py-4">
            <label
              htmlFor="variant-rename-name"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("sectionsEditor.variantRenameDialog.nameLabel")}
            </label>
            <Input
              id="variant-rename-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoLabel}
              autoFocus
              disabled={isPending}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t("sectionsEditor.variantRenameDialog.cancel")}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  {t("sectionsEditor.variantRenameDialog.saving")}
                </>
              ) : (
                t("sectionsEditor.variantRenameDialog.save")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
