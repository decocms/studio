import { Component, cloneElement } from "react";
import { Spinner } from "@deco/ui/components/spinner.tsx";

// Error boundary to catch Monaco disposal errors and recover by forcing remount
export class MonacoErrorBoundary extends Component<
  { children: React.ReactElement<{ mountKey?: number }> },
  { hasError: boolean; mountKey: number }
> {
  constructor(props: { children: React.ReactElement<{ mountKey?: number }> }) {
    super(props);
    this.state = { hasError: false, mountKey: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    // Check if it's the specific Monaco disposal error
    if (error.message?.includes("InstantiationService has been disposed")) {
      return { hasError: true };
    }
    throw error;
  }

  override componentDidCatch(error: Error) {
    if (error.message?.includes("InstantiationService has been disposed")) {
      // Schedule recovery: increment mountKey and clear error
      this.setState((prev) => ({
        hasError: false,
        mountKey: prev.mountKey + 1,
      }));
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full w-full bg-white dark:bg-[#1e1e1e] text-gray-400">
          <Spinner size="sm" />
        </div>
      );
    }
    // Clone child with mountKey to force fresh instance on recovery
    return cloneElement(this.props.children, {
      mountKey: this.state.mountKey,
    });
  }
}
