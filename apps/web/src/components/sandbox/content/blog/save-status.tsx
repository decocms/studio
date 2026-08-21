import { AlertCircle, Check, Loading01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

/** Subtle autosave indicator shown in editor headers. */
export function SaveStatus({
  isPending,
  isError,
}: {
  isPending: boolean;
  isError: boolean;
}) {
  const t = useT();
  if (isError) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle size={13} />
        {t("sandbox.saveStatus.failed")}
      </span>
    );
  }
  if (isPending) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loading01 size={13} className="animate-spin" />
        {t("sandbox.saveStatus.saving")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
      <Check size={13} />
      {t("sandbox.saveStatus.saved")}
    </span>
  );
}
