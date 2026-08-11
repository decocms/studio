import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { NoPermissionState } from "@/components/no-permission-state";
import { useDeploymentAdmin } from "@/hooks/use-deployment-admin";
import { useT } from "@/i18n/use-t.ts";

const TABS = [
  { to: "/_admin/users", labelKey: "admin.layout.usersTab" },
  { to: "/_admin/orgs", labelKey: "admin.layout.organizationsTab" },
] as const;

function AdminTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();

  return (
    <nav className="flex items-center gap-1 border-b border-border px-4 md:px-10">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className={cn(
            "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
            pathname.startsWith(tab.to)
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t(tab.labelKey)}
        </Link>
      ))}
    </nav>
  );
}

function AdminGate() {
  const { isAdmin, loading, needsEmailVerification } = useDeploymentAdmin();
  const t = useT();

  if (loading) {
    return (
      <div className="flex h-dvh flex-1 items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <NoPermissionState
        area={t("admin.layout.adminDashboardArea")}
        description={
          needsEmailVerification
            ? t("admin.layout.emailVerificationRequired")
            : t("admin.layout.restrictedToDashboard")
        }
        action={
          <Button variant="outline" size="sm" asChild>
            <Link to="/">{t("admin.layout.goHome")}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <div className="shrink-0 px-4 pt-6 md:px-10">
        <h1 className="pb-4 text-xl font-medium">
          {t("admin.layout.adminDashboard")}
        </h1>
      </div>
      <AdminTabs />
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

export default function AdminLayoutRoute() {
  return (
    <RequiredAuthLayout>
      <AdminGate />
    </RequiredAuthLayout>
  );
}
