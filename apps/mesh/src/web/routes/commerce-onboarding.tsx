/**
 * Commerce onboarding — the "connect your tools" experience.
 *
 * For the demo this is the same clean split modal used on the home
 * ("Manage connections"): a list of connectable data sources on the left and
 * the "schedule a call" card on the right. It renders over a soft branded
 * backdrop; closing (X / click-outside) drops the user into the product.
 */
import { useNavigate } from "@tanstack/react-router";
import { CommerceDiscoveryModal } from "@/web/components/home/commerce-discovery-modal";

export default function CommerceOnboardingRoute() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen w-full bg-sidebar">
      <CommerceDiscoveryModal onClose={() => navigate({ to: "/" })} />
    </div>
  );
}
