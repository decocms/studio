import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { LoadingIndicator } from "./loading-indicator.tsx";

export type CommerceOnboardingLoadingVariant =
  | "route"
  | "workspace"
  | "connect"
  | "setup"
  | "button";

const COMMERCE_ONBOARDING_LOADING_LABELS: Record<
  CommerceOnboardingLoadingVariant,
  string
> = {
  route: "Preparing commerce onboarding...",
  workspace: "Preparing your commerce workspace...",
  connect: "Connecting workspace...",
  setup: "Setting up Commerce Discovery...",
  button: "Setting up",
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
    <div className="py-4" role="status" aria-live="polite">
      <LoadingIndicator
        label={getCommerceOnboardingLoadingLabel(variant)}
        className="text-muted-foreground"
      />
    </div>
  );
}

export function CommerceOnboardingButtonLoading() {
  return (
    <LoadingIndicator label={getCommerceOnboardingLoadingLabel("button")} />
  );
}
