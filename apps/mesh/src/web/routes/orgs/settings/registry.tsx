import { lazy, Suspense } from "react";
import { Loading01 } from "@untitledui/icons";
import { RequireCapability } from "@/web/components/require-capability";

const RegistryLayout = lazy(
  () => import("@/web/views/registry/registry-layout"),
);

export default function SettingsRegistryPage() {
  return (
    <RequireCapability capability="registry:manage" area="the registry">
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center">
            <Loading01
              size={20}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <RegistryLayout />
      </Suspense>
    </RequireCapability>
  );
}
