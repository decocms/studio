import { Button } from "@decocms/ui/components/button.tsx";
import { Lock01, SearchLg } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { useDeploymentAdmin } from "@/hooks/use-deployment-admin";
import { useT } from "@/i18n/use-t.ts";
import { adminFetch } from "@/lib/admin-fetch";
import { authClient } from "@/lib/auth-client";

export interface NoAccessScreenProps {
  orgSlug: string;
  orgId?: string;
  orgName?: string;
  reason: "no-access" | "not-found";
}

export function NoAccessScreen({
  orgSlug,
  orgId,
  orgName,
  reason,
}: NoAccessScreenProps) {
  const t = useT();
  const { isAdmin: isDeploymentAdmin } = useDeploymentAdmin();
  const handleGoHome = () => {
    window.location.href = "/";
  };

  const isNotFound = reason === "not-found";
  const Icon = isNotFound ? SearchLg : Lock01;
  const title = isNotFound
    ? t("common.noAccessScreen.organizationNotFound")
    : t("common.noAccessScreen.noAccess");
  const body = isNotFound ? (
    <>
      {t("common.noAccessScreen.couldNotFind")} <strong>{orgSlug}</strong>.
    </>
  ) : (
    <>
      {t("common.noAccessScreen.noAccessTo")}{" "}
      <strong>{orgName ?? orgSlug}</strong>.
      <br />
      {t("common.noAccessScreen.askAdminToInvite")}
    </>
  );

  return (
    <AccessScreenLayout>
      <div className="bg-muted p-3 rounded-full">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {isDeploymentAdmin && orgId ? (
        <div className="flex flex-col gap-2 w-full">
          <AdminSelfJoinButton orgId={orgId} orgSlug={orgSlug} />
          <Button variant="ghost" onClick={handleGoHome}>
            {t("common.goHome")}
          </Button>
        </div>
      ) : (
        <Button onClick={handleGoHome}>{t("common.goHome")}</Button>
      )}
    </AccessScreenLayout>
  );
}

function AdminSelfJoinButton({
  orgId,
  orgSlug,
}: {
  orgId: string;
  orgSlug: string;
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const email = session?.user.email;

  const join = useMutation({
    mutationFn: () =>
      adminFetch(`/api/_admin/orgs/${orgId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: "admin" }),
      }),
    onSuccess: () => {
      window.location.href = `/${orgSlug}`;
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("common.noAccessScreen.adminJoinFailed"),
      );
    },
  });

  return (
    <Button onClick={() => join.mutate()} disabled={!email || join.isPending}>
      {join.isPending
        ? t("common.noAccessScreen.adminJoining")
        : t("common.noAccessScreen.adminJoin")}
    </Button>
  );
}
