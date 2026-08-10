import { Suspense } from "react";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { Coins04 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { useDecoCredits } from "@/hooks/use-deco-credits";
import { cn } from "@decocms/ui/lib/utils.ts";

class SilentErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}
  override render(): ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function creditColor(balanceDollars: number): string {
  if (balanceDollars <= 1) return "text-destructive";
  if (balanceDollars <= 5) return "text-warning";
  return "text-foreground/70";
}

function CreditChip() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { hasDecoKey, balanceDollars } = useDecoCredits();
  if (!hasDecoKey) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={
            balanceDollars != null
              ? `Credits: $${balanceDollars.toFixed(2)}`
              : "Credits"
          }
          className={cn(balanceDollars != null && creditColor(balanceDollars))}
          onClick={() =>
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            })
          }
        >
          <Coins04 />
          <span>
            {balanceDollars != null
              ? `$${balanceDollars.toFixed(2)}`
              : "Credits"}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function SidebarTopActions() {
  return (
    <SilentErrorBoundary>
      <Suspense fallback={null}>
        <CreditChip />
      </Suspense>
    </SilentErrorBoundary>
  );
}
