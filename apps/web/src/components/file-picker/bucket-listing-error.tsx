import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";

export function BucketListingError({
  denied,
  retrying,
  onRetry,
}: {
  denied: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div role="alert" className="rounded-lg border border-border p-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        {t(
          denied
            ? "filePicker.filePickerDialog.listingDenied"
            : "filePicker.filePickerDialog.listingFailed",
        )}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={retrying}
        onClick={onRetry}
      >
        {t("filePicker.filePickerDialog.retryListing")}
      </Button>
    </div>
  );
}
