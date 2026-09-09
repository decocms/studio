import { type FormEvent, useState } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import {
  REDIRECT_STATUS,
  type RedirectPayload,
  type RedirectType,
} from "./redirect-data";

const TYPE_OPTIONS: Array<{ value: RedirectType; labelKey: TranslationKey }> = [
  { value: "temporary", labelKey: "sandbox.redirectEditor.typeTemporary" },
  { value: "permanent", labelKey: "sandbox.redirectEditor.typePermanent" },
];

const EMPTY: RedirectPayload = {
  from: "",
  to: "",
  type: "temporary",
  discardQueryParameters: false,
};

/**
 * Modal form for creating a redirect. Unlike the right-pane editor (which
 * autosaves), nothing is written until the user submits a complete payload,
 * so the list never shows a placeholder `/redirect-from → /redirect-to` row.
 */
export function RedirectFormDialog({
  open,
  isPending = false,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  isPending?: boolean;
  error?: string;
  onSubmit: (values: RedirectPayload) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [payload, setPayload] = useState<RedirectPayload>(EMPTY);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setPayload(EMPTY);
      setLocalError(null);
    }
  }

  const setField = (patch: Partial<RedirectPayload>) =>
    setPayload((prev) => ({ ...prev, ...patch }));

  const handleOpenChange = (next: boolean) => {
    if (!next && !isPending) {
      setLocalError(null);
      onOpenChange(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const from = payload.from.trim();
    const to = payload.to.trim();
    if (!from || !to || isPending) {
      setLocalError(t("sandbox.redirectFormDialog.errorRequired"));
      return;
    }
    setLocalError(null);
    await onSubmit({ ...payload, from, to });
  };

  const displayError = localError ?? error;
  const canSubmit = !!payload.from.trim() && !!payload.to.trim() && !isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("sandbox.redirectFormDialog.title")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="redirect-form-from">
                {t("sandbox.redirectEditor.fromLabel")}
              </Label>
              <Input
                id="redirect-form-from"
                value={payload.from}
                onChange={(e) => setField({ from: e.target.value })}
                placeholder={t("sandbox.redirectEditor.fromPlaceholder")}
                autoFocus
                disabled={isPending}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="redirect-form-to">
                {t("sandbox.redirectEditor.toLabel")}
              </Label>
              <Input
                id="redirect-form-to"
                value={payload.to}
                onChange={(e) => setField({ to: e.target.value })}
                placeholder={t("sandbox.redirectEditor.toPlaceholder")}
                disabled={isPending}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="redirect-form-type">
                {t("sandbox.redirectEditor.typeLabel")}
              </Label>
              <Select
                value={payload.type}
                onValueChange={(v) => setField({ type: v as RedirectType })}
                disabled={isPending}
              >
                <SelectTrigger id="redirect-form-type" className="w-full">
                  <SelectValue
                    placeholder={t("sandbox.redirectEditor.typePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey, {
                        status: REDIRECT_STATUS[option.value],
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="flex cursor-pointer items-center gap-2.5">
              <Checkbox
                checked={payload.discardQueryParameters}
                disabled={isPending}
                onCheckedChange={(checked) =>
                  setField({ discardQueryParameters: checked === true })
                }
              />
              <span className="text-sm">
                {t("sandbox.redirectEditor.discardQueryParameters")}
              </span>
            </label>

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
              {t("sandbox.redirectFormDialog.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isPending ? (
                <>
                  <Spinner className="size-3.5" />
                  {t("sandbox.redirectFormDialog.pending")}
                </>
              ) : (
                t("sandbox.redirectFormDialog.submit")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
