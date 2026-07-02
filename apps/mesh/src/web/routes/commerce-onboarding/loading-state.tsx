import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { LoadingIndicator } from "./loading-indicator.tsx";

export type CommerceOnboardingLoadingVariant = "workspace" | "generic";

const COMMERCE_ONBOARDING_LOADING_LABELS: Record<
  CommerceOnboardingLoadingVariant,
  string
> = {
  workspace: "Preparing your commerce workspace...",
  generic: "Preparing workspace...",
};

export function getCommerceOnboardingLoadingLabel(
  variant: CommerceOnboardingLoadingVariant,
): string {
  return COMMERCE_ONBOARDING_LOADING_LABELS[variant];
}

export function CommerceOnboardingLoading({
  variant,
}: {
  variant: CommerceOnboardingLoadingVariant;
}) {
  return (
    <AuthSplitLayout>
      <CommerceOnboardingLoadingIndicator variant={variant} />
    </AuthSplitLayout>
  );
}

export function CommerceOnboardingLoadingIndicator({
  variant,
}: {
  variant: CommerceOnboardingLoadingVariant;
}) {
  return (
    <div className="flex justify-center py-4" role="status" aria-live="polite">
      <LoadingIndicator
        label={getCommerceOnboardingLoadingLabel(variant)}
        className="text-muted-foreground"
      />
    </div>
  );
}
