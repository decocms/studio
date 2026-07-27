import { Button } from "@deco/ui/components/button.tsx";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import type { DesktopAuth } from "@/desktop/use-desktop-auth";
import { useT } from "@/i18n/use-t";

export function KeychainUnavailableScreen({ auth }: { auth: DesktopAuth }) {
  const t = useT();

  return (
    <AuthSplitLayout>
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">
            {t("common.desktopKeychainUnavailable.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("common.desktopKeychainUnavailable.description")}
          </p>
        </div>
        <Button
          type="button"
          onClick={() => void auth.retryStatus()}
          disabled={auth.isRetryingStatus}
        >
          {auth.isRetryingStatus
            ? t("common.desktopKeychainUnavailable.retrying")
            : t("common.desktopKeychainUnavailable.retry")}
        </Button>
      </div>
    </AuthSplitLayout>
  );
}
