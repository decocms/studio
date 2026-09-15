import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { NoPermissionState } from "@/components/no-permission-state";
import { useDeploymentAdmin } from "@/hooks/use-deployment-admin";
import { useT } from "@/i18n/use-t.ts";
import { Main } from "@/components/main";
import { PanelLoading } from "@/layouts/main-panel-boundary";

const TABS = [
  { to: "/_admin/users", labelKey: "admin.layout.usersTab" },
  { to: "/_admin/orgs", labelKey: "admin.layout.organizationsTab" },
  { to: "/_admin/prompts", labelKey: "admin.layout.promptsTab" },
] as const;

function AdminTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();

  return (
    <nav
      aria-label={t("admin.layout.navigation")}
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto no-scrollbar"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          aria-current={pathname.startsWith(tab.to) ? "page" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            pathname.startsWith(tab.to)
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
        <PanelLoading />
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
    <Main className="h-dvh">
      <Main.Topbar>
        <Main.Topbar.Left>
          <Main.Title>
            <Main.Title.Target fallback={t("admin.layout.adminDashboard")} />
          </Main.Title>
        </Main.Topbar.Left>
        <Main.Topbar.Center>
          <div className="hidden min-w-0 md:block">
            <AdminTabs />
          </div>
          <Main.Topbar.Center.Target />
        </Main.Topbar.Center>
        <Main.Topbar.Right>
          <Main.Topbar.Right.Target />
        </Main.Topbar.Right>
      </Main.Topbar>
      <Main.Toolbar />
      <Main.Toolbar.Portal visibility="compact">
        <AdminTabs />
      </Main.Toolbar.Portal>
      <Main.Content mode="canvas">
        <Outlet />
      </Main.Content>
    </Main>
  );
}

export default function AdminLayoutRoute() {
  return (
    <RequiredAuthLayout>
      <AdminGate />
    </RequiredAuthLayout>
  );
}
