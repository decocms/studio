import { Button } from "@decocms/ui/components/button.tsx";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import type { DesktopAuth } from "@/desktop/use-desktop-auth";
import { useT } from "@/i18n/use-t";

// This screen only ever renders inside the desktop webview, so the browser
// gates' touch heuristic is meaningless here — the platform alone decides
// which credential vault the message can name.
function isMacDesktop(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

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
            {isMacDesktop()
              ? t("common.desktopKeychainUnavailable.description")
              : t("common.desktopKeychainUnavailable.descriptionLinux")}
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
