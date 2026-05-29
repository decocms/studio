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

/**
 * Renames a page variant by setting a custom `name` on its entry. When the
 * user clears the input, the variant falls back to the rule-derived label
 * (e.g. "Mobile", "Feb 23 → Mar 1") on the next render.
 */
export function VariantRenameDialog({
  open,
  initialName,
  autoLabel,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  initialName: string;
  autoLabel: string;
  onSubmit: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setName(initialName);
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename variant</DialogTitle>
            <DialogDescription>
              Override the auto-generated label. Leave empty to fall back to{" "}
              <span className="font-medium">{autoLabel || "the rule"}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5 py-4">
            <label
              htmlFor="variant-rename-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Name
            </label>
            <Input
              id="variant-rename-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoLabel}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
