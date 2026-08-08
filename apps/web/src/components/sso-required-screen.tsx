import { AccessScreenLayout } from "@/components/access-screen-layout";
import { Button } from "@decocms/ui/components/button.tsx";
import { Lock01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

export interface SsoRequiredScreenProps {
  orgId: string;
  orgSlug: string;
  orgName?: string;
  domain?: string;
}

export function SsoRequiredScreen({
  orgSlug,
  orgName,
  domain,
}: SsoRequiredScreenProps) {
  const t = useT();

  const handleSsoLogin = () => {
    window.location.href = `/api/${encodeURIComponent(orgSlug)}/sso/authorize`;
  };

  const handleGoBack = () => {
    window.location.href = "/";
  };

  return (
    <AccessScreenLayout>
      <div className="bg-primary/10 p-3 rounded-full">
        <Lock01 className="h-6 w-6 text-primary" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.ssoRequiredScreen.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {orgName ? (
            <>
              <strong>{orgName}</strong>{" "}
              {t("common.ssoRequiredScreen.requiresSsoAuth")}
              {domain
                ? ` ${t("common.ssoRequiredScreen.via", { domain })}`
                : ""}
              .
            </>
          ) : (
            t("common.ssoRequiredScreen.orgRequiresSsoAuth")
          )}
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full">
        <Button onClick={handleSsoLogin}>
          {t("common.ssoRequiredScreen.signInWithSso")}
        </Button>
        <Button variant="ghost" onClick={handleGoBack}>
          {t("common.ssoRequiredScreen.goBack")}
        </Button>
      </div>
    </AccessScreenLayout>
  );
}
