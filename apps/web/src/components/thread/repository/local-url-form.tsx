import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";
import { useT } from "@/i18n/use-t.ts";

/** "Local" tab: paste your dev server's URL (localhost or a tunnel) to point
 *  preview + CMS at it, or turn the override off. Save is disabled until the URL changes.
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
  // null when empty or unparseable: Save stays disabled instead of silently
  // turning Local off.
  const next = productionUrlFromDomain(withLocalScheme(value.trim()));
  const submit = () => next && onSave(next);
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
          if (e.key === "Enter") submit();
        }}
        className="h-8 w-full rounded-md border bg-transparent px-2 text-sm focus-ring"
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
        <Button size="sm" disabled={!next} onClick={submit}>
          {t("thread.branchPicker.save")}
        </Button>
      </div>
    </div>
  );
}

// A bare `localhost:8000` must stay http: a local dev server has no TLS, and
// productionUrlFromDomain defaults bare hosts to https (right for deco domains).
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
const withLocalScheme = (url: string): string =>
  LOOPBACK.test(url) ? `http://${url}` : url;
