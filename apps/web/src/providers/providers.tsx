import { Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { setCollectionToastTranslations } from "@/sdk";
import { planRefusalCopy, queryClient } from "@/providers/query-client";

import { AuthConfigProvider } from "@/providers/auth-config-provider";
import { BetterAuthUIProvider } from "@/providers/better-auth-ui-provider";
import { PostHogIdentitySync } from "@/providers/posthog-provider";
import { BootGate } from "@/layouts/boot-gate";
import { SplashScreen } from "@/components/splash-screen";
import { ThemeProvider } from "@/providers/theme-provider";
import { Toaster } from "sonner";
import { SandboxSignInDialog } from "@/components/connections/sandbox-sign-in-dialog";
import { useT } from "@/i18n/use-t";

function SdkTranslationInitializer({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useT();

  planRefusalCopy.feature = t("settings.paywall.serverRefusedFeature");
  planRefusalCopy.budget = t("settings.paywall.serverRefusedBudget");

  setCollectionToastTranslations({
    itemCreatedSuccessfully: t("collections.mutations.itemCreatedSuccessfully"),
    itemUpdatedSuccessfully: t("collections.mutations.itemUpdatedSuccessfully"),
    itemDeletedSuccessfully: t("collections.mutations.itemDeletedSuccessfully"),
    createItemFailed: t("collections.mutations.createItemFailed"),
    updateItemFailed: t("collections.mutations.updateItemFailed"),
    deleteItemFailed: t("collections.mutations.deleteItemFailed"),
  });

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Toaster />
      {/* The app's ONE splash boundary. It stays suspended from first paint
          until `BootGate` has the shell's prerequisites in hand, so the splash
          is a single mounted element that plays its animation once — see
          `layouts/boot-gate.tsx`. Nothing below here may render a splash of its
          own: a second boundary is a second element, and a second element
          restarts the animation. */}
      <Suspense fallback={<SplashScreen />}>
        <ThemeProvider>
          <AuthConfigProvider>
            <BetterAuthUIProvider>
              <PostHogIdentitySync>
                <SdkTranslationInitializer>
                  <BootGate>{children}</BootGate>
                  <SandboxSignInDialog />
                </SdkTranslationInitializer>
              </PostHogIdentitySync>
            </BetterAuthUIProvider>
          </AuthConfigProvider>
        </ThemeProvider>
      </Suspense>
    </QueryClientProvider>
  );
}
