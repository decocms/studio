import { lazy, Suspense } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { RequireCapability } from "@/components/require-capability";
import { PanelLoading } from "@/layouts/main-panel-boundary";
import { useT } from "@/i18n/use-t";

const RegistryLayout = lazy(() => import("@/views/registry/registry-layout"));
const route = getRouteApi("/shell/$org/settings/store/registry");

export default function StoreRegistryPage() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = route.useParams();
  const { registryTab = "items" } = route.useSearch();

  return (
    <RequireCapability
      capability="registry:manage"
      area={t("registry.registryLayout.permissionArea")}
    >
      <Suspense fallback={<PanelLoading />}>
        <RegistryLayout
          activeTab={registryTab}
          onTabChange={(nextTab) => {
            navigate({
              to: "/$org/settings/store/registry",
              params: { org },
              search: (previous) => ({
                ...previous,
                registryTab: nextTab === "items" ? undefined : nextTab,
              }),
            });
          }}
        />
      </Suspense>
    </RequireCapability>
  );
}
