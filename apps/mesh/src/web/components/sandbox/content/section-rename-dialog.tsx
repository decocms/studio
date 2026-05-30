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

/**
 * Renames the display name of a saved global section. We do NOT rename
 * the block key here — keys are the resolveType used by every page that
 * references the section, so changing them would orphan references. The
 * key is shown as read-only context so users understand the constraint.
 */
export function SectionRenameDialog({
  open,
  blockKey,
  initialName,
  isPending = false,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  blockKey: string;
  initialName: string;
  isPending?: boolean;
  onSubmit: (name: string) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  const [prevOpen, setPrevOpen] = useState(open);

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
            <DialogTitle>Rename section</DialogTitle>
            <DialogDescription>
              Updates the display name. The internal key stays the same so pages
              referencing this section keep working.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <label
                htmlFor="section-rename-name"
                className="text-xs font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id="section-rename-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Key
              </span>
              <Input value={blockKey} readOnly disabled className="font-mono" />
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
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
