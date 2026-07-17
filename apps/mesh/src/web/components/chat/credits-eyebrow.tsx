/**
 * Credits Eyebrow — subtle pills shown above the chat greeting on
 * the home page to communicate credit status.
 *
 * - Has credits: green pill "$2.00 in credits to get started"
 * - No credits: amber pill "No credits remaining"
 */

import { Coins04, AlertCircle } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";

interface CreditsEyebrowProps {
  balanceDollars: number;
}

export function CreditsEyebrow({ balanceDollars }: CreditsEyebrowProps) {
  const formatted = balanceDollars.toFixed(2);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full",
        "bg-success/10 border border-success/20",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
      )}
    >
      <Coins04 size={13} className="text-success" />
      <span className="text-xs font-medium text-success tabular-nums">
        ${formatted} in credits to get started
      </span>
    </div>
  );
}

export function NoCreditsEyebrow() {
  const { org } = useProjectContext();
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() =>
        navigate({
          to: "/$org/settings/ai-providers",
          params: { org: org.slug },
        })
      }
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full cursor-pointer",
        "bg-warning/10 border border-warning/20",
        "hover:bg-warning/15",
        "transition-colors duration-150",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
      )}
    >
      <AlertCircle size={13} className="text-warning" />
      <span className="text-xs font-medium text-warning">
        No credits remaining &middot; Add more
      </span>
    </button>
  );
}
