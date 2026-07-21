import { type FormEvent, useState } from "react";
import { Loading01 } from "@untitledui/icons";
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
import { type TranslationKey, useT } from "@/web/i18n/use-t.ts";

export type FileExplorerNameDialogMode = "new-file" | "new-folder" | "rename";

const MODE_COPY: Record<
  FileExplorerNameDialogMode,
  {
    titleKey: TranslationKey;
    descriptionKey: TranslationKey;
    submitKey: TranslationKey;
    placeholderKey: TranslationKey;
  }
> = {
  "new-file": {
    titleKey: "sandbox.fileExplorerNameDialog.newFileTitle",
    descriptionKey: "sandbox.fileExplorerNameDialog.newFileDescription",
    submitKey: "sandbox.fileExplorerNameDialog.newFileSubmit",
    placeholderKey: "sandbox.fileExplorerNameDialog.newFilePlaceholder",
  },
  "new-folder": {
    titleKey: "sandbox.fileExplorerNameDialog.newFolderTitle",
    descriptionKey: "sandbox.fileExplorerNameDialog.newFolderDescription",
    submitKey: "sandbox.fileExplorerNameDialog.newFolderSubmit",
    placeholderKey: "sandbox.fileExplorerNameDialog.newFolderPlaceholder",
  },
  rename: {
    titleKey: "sandbox.fileExplorerNameDialog.renameTitle",
    descriptionKey: "sandbox.fileExplorerNameDialog.renameDescription",
    submitKey: "sandbox.fileExplorerNameDialog.renameSubmit",
    placeholderKey: "sandbox.fileExplorerNameDialog.renamePlaceholder",
  },
};

export function FileExplorerNameDialog({
  open,
  mode,
  initialName = "",
  parentLabel,
  isPending = false,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  mode: FileExplorerNameDialogMode;
  initialName?: string;
  parentLabel?: string;
  isPending?: boolean;
  onSubmit: (name: string) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [prevOpen, setPrevOpen] = useState(open);
  const copy = MODE_COPY[mode];

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setName(initialName);
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && !isPending) onOpenChange(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isPending) return;
    await onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t(copy.titleKey)}</DialogTitle>
            <DialogDescription>{t(copy.descriptionKey)}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {parentLabel && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("sandbox.fileExplorerNameDialog.location")}
                </span>
                <Input
                  value={parentLabel}
                  readOnly
                  disabled
                  className="font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <label
                htmlFor="file-explorer-name"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("sandbox.fileExplorerNameDialog.name")}
              </label>
              <Input
                id="file-explorer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(copy.placeholderKey)}
                autoFocus
                disabled={isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t("sandbox.fileExplorerNameDialog.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending}>
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  {t("sandbox.fileExplorerNameDialog.saving")}
                </>
              ) : (
                t(copy.submitKey)
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
