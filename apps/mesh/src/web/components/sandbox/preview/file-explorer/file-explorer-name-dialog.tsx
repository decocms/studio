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

export type FileExplorerNameDialogMode = "new-file" | "new-folder" | "rename";

const MODE_COPY: Record<
  FileExplorerNameDialogMode,
  { title: string; description: string; submit: string; placeholder: string }
> = {
  "new-file": {
    title: "New File",
    description: "Enter a name for the new file.",
    submit: "Create",
    placeholder: "filename.ts",
  },
  "new-folder": {
    title: "New Folder",
    description: "Enter a name for the new folder.",
    submit: "Create",
    placeholder: "folder-name",
  },
  rename: {
    title: "Rename",
    description: "Enter a new name for this item.",
    submit: "Rename",
    placeholder: "new-name",
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
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {parentLabel && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Location
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
                Name
              </label>
              <Input
                id="file-explorer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={copy.placeholder}
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
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending}>
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  Saving…
                </>
              ) : (
                copy.submit
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
