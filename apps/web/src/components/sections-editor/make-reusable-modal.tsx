import { useState, type FormEvent } from "react";
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
import { useT } from "@/i18n/use-t.ts";

export function MakeReusableModal({
  open,
  onOpenChange,
  defaultBlockId = "",
  isPending = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultBlockId?: string;
  isPending?: boolean;
  onSubmit: (blockId: string) => void | Promise<void>;
}) {
  const [blockId, setBlockId] = useState(defaultBlockId);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setBlockId(defaultBlockId);
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isPending) {
      onOpenChange(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = blockId.trim();
    if (!trimmed || isPending) return;
    await onSubmit(trimmed);
  };

  const t = useT();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {t("sectionsEditor.makeReusableModal.title")}
            </DialogTitle>
            <DialogDescription>
              {t("sectionsEditor.makeReusableModal.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-2">
            <label htmlFor="block-id" className="text-sm font-medium">
              {t("sectionsEditor.makeReusableModal.blockNameLabel")}
            </label>
            <Input
              id="block-id"
              value={blockId}
              onChange={(e) => setBlockId(e.target.value)}
              placeholder={t(
                "sectionsEditor.makeReusableModal.blockNamePlaceholder",
              )}
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
              {t("sectionsEditor.makeReusableModal.cancel")}
            </Button>
            <Button type="submit" disabled={!blockId.trim() || isPending}>
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  {t("sectionsEditor.makeReusableModal.saving")}
                </>
              ) : (
                t("sectionsEditor.makeReusableModal.save")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
