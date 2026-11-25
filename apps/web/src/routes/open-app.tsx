import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { buttonVariants } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  androidIntentUrl,
  appPlatform,
  mobileAppLink,
  parseOpenAppParams,
} from "@decocms/shared/mobile-app";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { useT } from "@/i18n/use-t.ts";

/**
 * Public bridge from a phone camera to an Eitri app's Dev build
 * (`/open-app?protocol=…&slug=…&path=…`): cameras open https links, not
 * custom schemes, so the canvas's "View on phone" QR code lands here and
 * this page opens the draft in the app (an `intent://` on Android, the app
 * link on iOS). It builds that link itself from its validated query
 * (`parseOpenAppParams`), so it never goes to an arbitrary address. No
 * login, no data read.
 */
export default function OpenAppRoute() {
  const t = useT();
  const params = parseOpenAppParams(
    Object.fromEntries(new URLSearchParams(window.location.search)),
  );
  const platform = appPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const target = !params
    ? null
    : platform === "android"
      ? androidIntentUrl(params)
      : mobileAppLink(params);
  const installUrl =
    platform === "android"
      ? params?.apk
      : platform === "ios"
        ? params?.ios
        : undefined;
  const [notOpened, setNotOpened] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!target || platform === "desktop") return;
    window.location.href = target;
    if (platform !== "ios") return;
    // Still on screen after a moment: iOS didn't hand over to the app.
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") setNotOpened(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, [target, platform]);

  if (!target) {
    return (
      <AuthSplitLayout>
        <div className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("common.openApp.invalidTitle")}
          </h1>
          <p className="text-muted-foreground">
            {t("common.openApp.invalidDescription")}
          </p>
        </div>
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout>
      <div className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("common.openApp.title")}
          </h1>
          <p className="text-muted-foreground">
            {platform === "desktop"
              ? t("common.openApp.desktop")
              : t("common.openApp.description")}
          </p>
        </div>
        {platform === "desktop" ? (
          // Always dark on white: phone cameras read it in either theme.
          <div className="w-fit rounded-lg bg-white p-3">
            <QRCodeSVG value={window.location.href} size={200} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <a
              href={target}
              className={cn(buttonVariants({ size: "xl" }), "w-full")}
            >
              {t("common.openApp.open")}
            </a>
            {notOpened ? (
              <p className="text-sm text-muted-foreground">
                {t("common.openApp.notOpened")}
              </p>
            ) : null}
            {installUrl ? (
              <a
                href={installUrl}
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "w-full",
                )}
              >
                {t("common.openApp.install")}
              </a>
            ) : null}
          </div>
        )}
      </div>
    </AuthSplitLayout>
  );
}
