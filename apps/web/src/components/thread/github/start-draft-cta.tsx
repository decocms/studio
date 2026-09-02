import { useState } from "react";
import { ArrowRight, Lock01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useCreateDraft } from "./use-version-gate";

/**
 * "Production is read-only — start a new draft to edit" call-to-action. Shown
 * wherever editing is blocked because the current version is production: the
 * chat composer slot (`variant="composer"`) and the CMS content editor
 * (`variant="panel"`). Clicking creates a new draft and switches editing onto
 * it via {@link useCreateDraft}.
 */
export function StartDraftCta({
  virtualMcpId,
  variant = "composer",
}: {
  virtualMcpId: string;
  variant?: "composer" | "panel";
}) {
  const t = useT();
  const createDraft = useCreateDraft(virtualMcpId);
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      await createDraft();
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => void handleClick()}
      className={cn(
        "group flex items-center gap-3 rounded-2xl border border-border bg-background/60 px-4 py-3.5 text-left shadow-sm backdrop-blur-sm transition-colors hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
        variant === "composer" ? "w-full" : "mx-auto my-10 w-full max-w-md",
      )}
    >
      <Lock01 size={18} className="shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">
          {t("chat.input.productionReadOnly")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("chat.input.startDraftToEdit")}
        </span>
      </span>
      <ArrowRight
        size={16}
        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
