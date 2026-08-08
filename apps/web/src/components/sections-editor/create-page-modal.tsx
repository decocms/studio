import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Loading01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
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
  const t = useT();
  const [name, setName] = useState(
    t("sectionsEditor.createPageModal.defaultPageName"),
  );
  const [path, setPath] = useState(
    t("sectionsEditor.createPageModal.defaultPagePath"),
  );
  const [templateKey, setTemplateKey] = useState(BLANK_TEMPLATE);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName(t("sectionsEditor.createPageModal.defaultPageName"));
      setPath(t("sectionsEditor.createPageModal.defaultPagePath"));
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
            <DialogTitle>
              {t("sectionsEditor.createPageModal.title")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <label
                htmlFor="new-page-name"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("sectionsEditor.createPageModal.nameLabel")}
              </label>
              <Input
                id="new-page-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(
                  "sectionsEditor.createPageModal.namePlaceholder",
                )}
                autoFocus
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="new-page-path"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("sectionsEditor.createPageModal.pathLabel")}
              </label>
              <Input
                id="new-page-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t(
                  "sectionsEditor.createPageModal.pathPlaceholder",
                )}
                disabled={isPending}
              />
            </div>
            {showTemplates && (
              <div className="space-y-1.5">
                <label
                  htmlFor="new-page-template"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("sectionsEditor.createPageModal.templateLabel")}
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
              {t("sectionsEditor.createPageModal.cancelButton")}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !path.trim() || isPending}
            >
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  {t("sectionsEditor.createPageModal.creatingButton")}
                </>
              ) : (
                t("sectionsEditor.createPageModal.createButton")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
