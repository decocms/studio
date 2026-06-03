import { AlertTriangle } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

/**
 * Shown when the capability bitmap can't be loaded (network / server error),
 * so a transient failure surfaces as a retryable error rather than masquerading
 * as a no-access denial. "Try again" invalidates the query, which refetches it.
 */
export function CapabilityLoadError() {
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();

  return (
    <div className="flex h-full min-h-[60vh] flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <AlertTriangle size={28} />
      </div>
      <div className="space-y-1">
        <h3 className="text-lg font-medium">Couldn't load your permissions</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Something went wrong checking your access. This is usually temporary.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          queryClient.invalidateQueries({
            queryKey: KEYS.myCapabilities(locator),
          })
        }
      >
        Try again
      </Button>
    </div>
  );
}
