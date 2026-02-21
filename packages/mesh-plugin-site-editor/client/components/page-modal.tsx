import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";

interface PageModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (title: string, path: string) => Promise<void>;
  mode: "create" | "rename";
  initialTitle?: string;
  initialPath?: string;
}

export function PageModal({
  open,
  onClose,
  onSubmit,
  mode,
  initialTitle = "",
  initialPath = "",
}: PageModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [path, setPath] = useState(initialPath);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    try {
      await onSubmit(
        title,
        path || `/${title.toLowerCase().replace(/\s+/g, "-")}`,
      );
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Create page" : "Rename page"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="page-title">Title</Label>
            <Input
              id="page-title"
              value={title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setTitle(e.target.value)
              }
              placeholder="My Page"
              autoFocus
            />
          </div>
          {mode === "create" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="page-path">Path</Label>
              <Input
                id="page-path"
                value={path}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setPath(e.target.value)
                }
                placeholder="/my-page"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !title.trim()}>
              {loading ? "Saving..." : mode === "create" ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
