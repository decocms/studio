import { AuthSplitLayout } from "@/components/auth-split-layout";
import { useT } from "@/i18n/use-t.ts";
import { LoadingIndicator } from "./loading-indicator.tsx";

export type CommerceOnboardingLoadingVariant = "workspace" | "generic";

export function CommerceOnboardingLoading({
  variant,
}: {
  variant: CommerceOnboardingLoadingVariant;
}) {
  return (
    <AuthSplitLayout>
      <ReportsOnboardingLoadingIndicator variant={variant} />
    </AuthSplitLayout>
  );
}

export function ReportsOnboardingLoadingIndicator({
  variant,
}: {
  variant: CommerceOnboardingLoadingVariant;
}) {
  const t = useT();
  const label =
    variant === "workspace"
      ? t("routes.reportsOnboarding.loading.preparingWorkspace")
      : t("routes.reportsOnboarding.loading.preparing");

  return (
    <div className="flex justify-center py-4" role="status" aria-live="polite">
      <LoadingIndicator label={label} className="text-muted-foreground" />
    </div>
  );
}
