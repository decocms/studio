import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Loading01 } from "@untitledui/icons";
import { validatePagePath } from "./page-path-utils";
import { BLANK_TEMPLATE, PageTemplateSelect } from "./page-template-select";
import type { PageEntry } from "./page-list";

export function CreatePageModal({
  open,
  onOpenChange,
  isPending = false,
  error,
  templates,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending?: boolean;
  error?: string;
  /**
   * Existing pages offered as content templates. Picking one clones its
   * content; only the name and path come from the form.
   */
  templates?: PageEntry[];
  onSubmit: (values: {
    name: string;
    path: string;
    templateKey: string | null;
  }) => void | Promise<void>;
}) {
  const [name, setName] = useState("My New Page");
  const [path, setPath] = useState("/example-path");
  const [templateKey, setTemplateKey] = useState(BLANK_TEMPLATE);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName("My New Page");
      setPath("/example-path");
      setTemplateKey(BLANK_TEMPLATE);
      setLocalError(null);
    }
  }

  const showTemplates = !!templates?.length;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isPending) {
      setLocalError(null);
      onOpenChange(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    if (!trimmedName || !trimmedPath || isPending) return;
    const pathError = validatePagePath(trimmedPath);
    if (pathError) {
      setLocalError(pathError);
      return;
    }
    setLocalError(null);
    await onSubmit({
      name: trimmedName,
      path: trimmedPath,
      templateKey:
        showTemplates && templateKey !== BLANK_TEMPLATE ? templateKey : null,
    });
  };

  const displayError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create new page</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <label
                htmlFor="new-page-name"
                className="text-xs font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id="new-page-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My New Page"
                autoFocus
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="new-page-path"
                className="text-xs font-medium text-muted-foreground"
              >
                Path
              </label>
              <Input
                id="new-page-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/example-path"
                disabled={isPending}
              />
            </div>
            {showTemplates && (
              <div className="space-y-1.5">
                <label
                  htmlFor="new-page-template"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Template
                </label>
                <PageTemplateSelect
                  id="new-page-template"
                  value={templateKey}
                  onChange={setTemplateKey}
                  templates={templates ?? []}
                  disabled={isPending}
                />
              </div>
            )}
            {displayError && (
              <p className="text-xs text-destructive">{displayError}</p>
            )}
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
            <Button
              type="submit"
              disabled={!name.trim() || !path.trim() || isPending}
            >
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  Creating…
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
