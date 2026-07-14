/**
 * Per-tile error boundary. Keeps a crashing tile from taking down the
 * whole home board — the failed tile renders a small placeholder and
 * neighbours stay healthy.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "@untitledui/icons";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message?: string;
}

export class TileErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[home-tiles] tile crashed:", error, info.componentStack);
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <span className="flex size-8 items-center justify-center rounded-md bg-destructive/10 text-destructive">
          <AlertTriangle size={16} />
        </span>
        <p className="text-sm font-medium text-foreground">This tile crashed</p>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {this.state.message ?? "Something went wrong rendering this tile."}
        </p>
      </div>
    );
  }
}
