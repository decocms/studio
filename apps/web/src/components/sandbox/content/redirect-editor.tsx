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
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useAutosave } from "./blog/use-autosave";
import { SaveStatus } from "./blog/save-status";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import {
  buildRedirectBlock,
  getRedirectPayload,
  REDIRECT_STATUS,
  type RedirectPayload,
  type RedirectType,
} from "./redirect-data";

const TYPE_OPTIONS: Array<{ value: RedirectType; labelKey: TranslationKey }> = [
  { value: "temporary", labelKey: "sandbox.redirectEditor.typeTemporary" },
  { value: "permanent", labelKey: "sandbox.redirectEditor.typePermanent" },
];

/**
 * Right-pane editor for a single redirect block. Autosaves each field change
 * (write-through the shared decofile cache via `useSaveBlock`), mirroring the
 * blog record editor. Create/delete happen upstream in the Content browser.
 */
export function RedirectEditor({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  block,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
}) {
  const t = useT();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const initial = getRedirectPayload(block);

  const [payload, setPayload] = useAutosave(initial, (next) => {
    save.mutate({ blockKey, data: buildRedirectBlock(next) });
  });

  const setField = (patch: Partial<RedirectPayload>) =>
    setPayload({ ...payload, ...patch });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="text-sm font-medium">
          {t("sandbox.redirectEditor.title")}
        </span>
        <SaveStatus isPending={save.isPending} isError={save.isError} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-xl space-y-6">
          <div className="space-y-2">
            <Label htmlFor="redirect-from">
              {t("sandbox.redirectEditor.fromLabel")}
            </Label>
            <Input
              id="redirect-from"
              value={payload.from}
              placeholder={t("sandbox.redirectEditor.fromPlaceholder")}
              onChange={(e) => setField({ from: e.target.value })}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              {t("sandbox.redirectEditor.fromDescription")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="redirect-to">
              {t("sandbox.redirectEditor.toLabel")}
            </Label>
            <Input
              id="redirect-to"
              value={payload.to}
              placeholder={t("sandbox.redirectEditor.toPlaceholder")}
              onChange={(e) => setField({ to: e.target.value })}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              {t("sandbox.redirectEditor.toDescription")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="redirect-type">
              {t("sandbox.redirectEditor.typeLabel")}
            </Label>
            <Select
              value={payload.type}
              onValueChange={(v) => setField({ type: v as RedirectType })}
            >
              <SelectTrigger id="redirect-type" className="h-10 w-full">
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
            <p className="text-xs text-muted-foreground">
              {/* TODO(i18n): rich text with <strong> tags */}
              Use <strong>Temporary</strong> when the redirect may change;{" "}
              <strong>Permanent</strong> lets browsers cache it.
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5">
            <Checkbox
              checked={payload.discardQueryParameters}
              onCheckedChange={(checked) =>
                setField({ discardQueryParameters: checked === true })
              }
            />
            <span className="text-sm">
              {t("sandbox.redirectEditor.discardQueryParameters")}
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
