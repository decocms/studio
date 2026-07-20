import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useSaveBlock } from "@/web/components/sections-editor/use-save-block";
import { useAutosave } from "./blog/use-autosave";
import { SaveStatus } from "./blog/save-status";
import {
  buildRedirectBlock,
  getRedirectPayload,
  REDIRECT_STATUS,
  type RedirectPayload,
  type RedirectType,
} from "./redirect-data";

const TYPE_OPTIONS: Array<{ value: RedirectType; label: string }> = [
  { value: "temporary", label: `Temporary (${REDIRECT_STATUS.temporary})` },
  { value: "permanent", label: `Permanent (${REDIRECT_STATUS.permanent})` },
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
        <span className="text-sm font-medium">Redirect</span>
        <SaveStatus isPending={save.isPending} isError={save.isError} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-xl space-y-6">
          <div className="space-y-2">
            <Label htmlFor="redirect-from">From</Label>
            <Input
              id="redirect-from"
              value={payload.from}
              placeholder="/old-path"
              onChange={(e) => setField({ from: e.target.value })}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              The source path to match. Supports URLPattern syntax (e.g.{" "}
              <code>/product/:slug</code>).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="redirect-to">To</Label>
            <Input
              id="redirect-to"
              value={payload.to}
              placeholder="/new-path"
              onChange={(e) => setField({ to: e.target.value })}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              The destination — a relative path or an absolute URL.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="redirect-type">Type</Label>
            <Select
              value={payload.type}
              onValueChange={(v) => setField({ type: v as RedirectType })}
            >
              <SelectTrigger id="redirect-type" className="h-10 w-full">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
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
            <span className="text-sm">Discard query parameters</span>
          </label>
        </div>
      </div>
    </div>
  );
}
