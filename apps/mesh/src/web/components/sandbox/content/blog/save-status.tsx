import { AlertCircle, Check, Loading01 } from "@untitledui/icons";

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
        <Loading01 size={13} className="animate-spin" />
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
