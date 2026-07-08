import { type FormEvent, useState } from "react";
import { Loading01 } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { validatePagePath } from "@/web/components/sections-editor/page-path-utils";
import {
  BLANK_TEMPLATE,
  PageTemplateSelect,
  type PageTemplateOption,
} from "@/web/components/sections-editor/page-template-select";

export type PageFormMode = "create" | "duplicate" | "rename";

export type { PageTemplateOption };

const TITLES: Record<PageFormMode, string> = {
  create: "Create new page",
  duplicate: "Duplicate page",
  rename: "Rename page",
};

const SUBMIT_LABELS: Record<PageFormMode, string> = {
  create: "Create",
  duplicate: "Duplicate",
  rename: "Save",
};

const PENDING_LABELS: Record<PageFormMode, string> = {
  create: "Creating…",
  duplicate: "Duplicating…",
  rename: "Saving…",
};

export function PageFormDialog({
  open,
  mode,
  initialName,
  initialPath,
  isPending = false,
  error,
  /**
   * Existing pages offered as content templates in "create" mode. Picking
   * one clones its content; only the name and path come from the form.
   * Ignored for other modes.
   */
  templates,
  /**
   * Returns a validation error to display (e.g. "path already in use"),
   * or null when the values pass. Called on submit; lets the host
   * de-dupe against the latest decofile snapshot.
   */
  validate,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  mode: PageFormMode;
  initialName: string;
  initialPath: string;
  isPending?: boolean;
  error?: string;
  templates?: PageTemplateOption[];
  validate?: (values: { name: string; path: string }) => string | null;
  onSubmit: (values: {
    name: string;
    path: string;
    templateKey: string | null;
  }) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  const [path, setPath] = useState(initialPath);
  const [templateKey, setTemplateKey] = useState(BLANK_TEMPLATE);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName(initialName);
      setPath(initialPath);
      setTemplateKey(BLANK_TEMPLATE);
      setLocalError(null);
    }
  }

  const showTemplates = mode === "create" && !!templates?.length;

  const handleOpenChange = (next: boolean) => {
    if (!next && !isPending) {
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
    const hostError = validate?.({ name: trimmedName, path: trimmedPath });
    if (hostError) {
      setLocalError(hostError);
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
            <DialogTitle>{TITLES[mode]}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {showTemplates && (
              <div className="space-y-1.5">
                <label
                  htmlFor="page-form-template"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Template
                </label>
                <PageTemplateSelect
                  id="page-form-template"
                  value={templateKey}
                  onChange={setTemplateKey}
                  templates={templates ?? []}
                  disabled={isPending}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <label
                htmlFor="page-form-name"
                className="text-xs font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id="page-form-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My page"
                autoFocus
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="page-form-path"
                className="text-xs font-medium text-muted-foreground"
              >
                Path
              </label>
              <Input
                id="page-form-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/example"
                disabled={isPending}
              />
            </div>
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
                  {PENDING_LABELS[mode]}
                </>
              ) : (
                SUBMIT_LABELS[mode]
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
