import { AlertCircle, Check } from "@untitledui/icons";
import { Spinner } from "@decocms/ui/components/spinner.tsx";

/** Subtle autosave indicator shown in editor headers. */
export function SaveStatus({
  isPending,
  isError,
}: {
  isPending: boolean;
  isError: boolean;
}) {
  if (isError) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle size={13} />
        Couldn't save
      </span>
    );
  }
  if (isPending) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-[13px]" />
        Saving…
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
      <Check size={13} />
      Saved
    </span>
  );
}
