import { lazy, Suspense } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { RequireCapability } from "@/components/require-capability";

const RegistryLayout = lazy(() => import("@/views/registry/registry-layout"));

export default function SettingsRegistryPage() {
  return (
    <RequireCapability capability="registry:manage" area="the registry">
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        }
      >
        <RegistryLayout />
      </Suspense>
    </RequireCapability>
  );
}
