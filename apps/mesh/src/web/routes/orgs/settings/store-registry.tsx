import { lazy, Suspense } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { RequireCapability } from "@/web/components/require-capability";

const RegistryLayout = lazy(
  () => import("@/web/views/registry/registry-layout"),
);

export default function StoreRegistryPage() {
  const navigate = useNavigate();
  const { org } = useParams({ from: "/shell/$org" });

  return (
    <RequireCapability capability="registry:manage" area="the registry">
      <Suspense
        fallback={
          <div className="h-full flex items-center justify-center">
            <Loading01
              size={20}
              className="animate-spin text-muted-foreground"
            />
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
