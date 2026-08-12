import { type FormEvent, useState } from "react";
import { Loading01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { validatePagePath } from "@/components/sections-editor/page-path-utils";
import {
  BLANK_TEMPLATE,
  PageTemplateSelect,
} from "@/components/sections-editor/page-template-select";
import type { PageEntry } from "@/components/sections-editor/page-list";

export type PageFormMode = "create" | "duplicate" | "rename";

const TITLE_KEYS: Record<PageFormMode, TranslationKey> = {
  create: "sandbox.pageFormDialog.titleCreate",
  duplicate: "sandbox.pageFormDialog.titleDuplicate",
  rename: "sandbox.pageFormDialog.titleRename",
};

const SUBMIT_LABEL_KEYS: Record<PageFormMode, TranslationKey> = {
  create: "sandbox.pageFormDialog.submitCreate",
  duplicate: "sandbox.pageFormDialog.submitDuplicate",
  rename: "sandbox.pageFormDialog.submitSave",
};

const PENDING_LABEL_KEYS: Record<PageFormMode, TranslationKey> = {
  create: "sandbox.pageFormDialog.pendingCreate",
  duplicate: "sandbox.pageFormDialog.pendingDuplicate",
  rename: "sandbox.pageFormDialog.pendingSave",
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
  templates?: PageEntry[];
  validate?: (values: { name: string; path: string }) => string | null;
  onSubmit: (values: {
    name: string;
    path: string;
    templateKey: string | null;
  }) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
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
            <DialogTitle>{t(TITLE_KEYS[mode])}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {showTemplates && (
              <div className="space-y-1.5">
                <label
                  htmlFor="page-form-template"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("sandbox.pageFormDialog.labelTemplate")}
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
                {t("sandbox.pageFormDialog.labelName")}
              </label>
              <Input
                id="page-form-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("sandbox.pageFormDialog.placeholderName")}
                autoFocus
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="page-form-path"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("sandbox.pageFormDialog.labelPath")}
              </label>
              <Input
                id="page-form-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("sandbox.pageFormDialog.placeholderPath")}
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
              {t("sandbox.pageFormDialog.buttonCancel")}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !path.trim() || isPending}
            >
              {isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  {t(PENDING_LABEL_KEYS[mode])}
                </>
              ) : (
                t(SUBMIT_LABEL_KEYS[mode])
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
