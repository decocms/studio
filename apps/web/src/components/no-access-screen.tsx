import { Button } from "@decocms/ui/components/button.tsx";
import { Lock01, SearchLg } from "@untitledui/icons";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { useT } from "@/i18n/use-t.ts";

export interface NoAccessScreenProps {
  orgSlug: string;
  orgName?: string;
  reason: "no-access" | "not-found";
}

export function NoAccessScreen({
  orgSlug,
  orgName,
  reason,
}: NoAccessScreenProps) {
  const t = useT();
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
      <Button onClick={handleGoHome}>
        {t("common.noAccessScreen.goToHome")}
      </Button>
    </AccessScreenLayout>
  );
}
