import { useT } from "@/i18n/use-t.ts";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Clock } from "@untitledui/icons";

export interface RequestPendingScreenProps {
  orgName: string;
  orgLogo: string | null;
}

export function RequestPendingScreen({
  orgName,
  orgLogo,
}: RequestPendingScreenProps) {
  const t = useT();
  return (
    <AccessScreenLayout>
      {orgLogo ? (
        <Avatar
          url={orgLogo}
          fallback={orgName.charAt(0).toUpperCase()}
          shape="square"
          size="base"
          className="h-12 w-12"
        />
      ) : (
        <div className="bg-primary/10 p-3 rounded-full">
          <Clock className="h-6 w-6 text-primary" />
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.requestPendingScreen.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("common.requestPendingScreen.description", { orgName })}
        </p>
      </div>
      <Button
        variant="ghost"
        onClick={() => {
          window.location.href = "/";
        }}
      >
        {t("common.requestPendingScreen.goHome")}
      </Button>
    </AccessScreenLayout>
  );
}
