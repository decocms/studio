import { lazy, Suspense } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useNavigate, useParams } from "@tanstack/react-router";
import { RequireCapability } from "@/components/require-capability";

const RegistryLayout = lazy(() => import("@/views/registry/registry-layout"));

export default function StoreRegistryPage() {
  const navigate = useNavigate();
  const { org } = useParams({ from: "/shell/$org" });

  return (
    <RequireCapability capability="registry:manage" area="the registry">
      <Suspense
        fallback={
          <div className="h-full flex items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        }
      >
        <RegistryLayout
          onBack={() =>
            navigate({ to: "/$org/settings/store", params: { org } })
          }
        />
      </Suspense>
    </RequireCapability>
  );
}
