import { Button } from "@decocms/ui/components/button.tsx";
import { Archive } from "@untitledui/icons";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { useT } from "@/i18n/use-t.ts";

export interface ArchivedOrgScreenProps {
  orgName?: string;
}

export function ArchivedOrgScreen({ orgName }: ArchivedOrgScreenProps) {
  const t = useT();
  const handleGoHome = () => {
    window.location.href = "/";
  };

  return (
    <AccessScreenLayout>
      <div className="bg-muted p-3 rounded-full">
        <Archive className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.archivedOrgScreen.orgUnavailable")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {orgName
            ? t("common.archivedOrgScreen.deletedWithName", { orgName })
            : t("common.archivedOrgScreen.deletedGeneric")}
        </p>
      </div>
      <Button onClick={handleGoHome}>
        {t("common.archivedOrgScreen.goHome")}
      </Button>
    </AccessScreenLayout>
  );
}
