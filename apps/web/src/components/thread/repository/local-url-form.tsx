import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";
import { useT } from "@/i18n/use-t.ts";

/** "Local" tab: paste a tunnel URL to point preview + CMS at your own dev
 *  server, or turn the override off. Save is disabled until the URL changes.
 *
 *  v7 sites only, and exactly main's: a synchronous save, no `deco serve`
 *  probe. Blocks v8 sites use Localhost instead. */
export function LocalUrlForm({
  url,
  onSave,
}: {
  url: string | null;
  onSave: (url: string | null) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(url ?? "");
  const trimmed = value.trim();
  const submit = () =>
    onSave(trimmed ? productionUrlFromDomain(trimmed) : null);
  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="text-xs text-muted-foreground">
        {t("thread.branchPicker.localHint")}
      </p>
      <input
        type="url"
        inputMode="url"
        aria-label={t("thread.branchPicker.localUrlLabel")}
        placeholder={t("thread.branchPicker.localUrlPlaceholder")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed) submit();
        }}
        className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center justify-between gap-2">
        {url ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-destructive hover:text-destructive"
            onClick={() => onSave(null)}
          >
            {t("thread.branchPicker.localTurnOff")}
          </Button>
        ) : (
          <span />
        )}
        <Button size="sm" disabled={!trimmed} onClick={submit}>
          {t("thread.branchPicker.save")}
        </Button>
      </div>
    </div>
  );
}
