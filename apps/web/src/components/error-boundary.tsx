import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AlertTriangle, RefreshCw01 } from "@untitledui/icons";
import { captureException } from "@/lib/posthog-client";
import { ArchivedOrgScreen } from "@/components/archived-org-screen";
import { NoPermissionState } from "@/components/no-permission-state";
import { ORG_ARCHIVED_ERROR } from "@decocms/shared/organization/org-archived";
import { useT } from "@/i18n/use-t.ts";
import {
  isStaleAssetError,
  reloadNow,
  scheduleStaleBuildReload,
  type StaleBuildReload,
} from "@/lib/stale-build-reload";

function isArchivedOrgError(error: Error | null): boolean {
  return error?.message === ORG_ARCHIVED_ERROR;
}

function isAccessDeniedError(error: Error | null): boolean {
  return !!error?.message?.includes("Access denied");
}

/**
 * Props for the fallback render function
 */
export interface ErrorFallbackProps {
  error: Error | null;
  resetError: () => void;
}

/**
 * Fallback can be either a static ReactNode or a render function
 */
type FallbackType = ReactNode | ((props: ErrorFallbackProps) => ReactNode);

interface Props {
  children: ReactNode;
  fallback?: FallbackType;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundaryImpl extends Component<
  Props & { t: ReturnType<typeof useT> },
  State
> {
  override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Rethrown to ChunkErrorBoundary, which reports it.
    if (isStaleAssetError(error) && this.props.fallback === undefined) return;
    console.error("Uncaught error:", error, errorInfo);
    captureException(error, {
      boundary: "default",
      error_name: error.name,
      error_message: error.message,
      component_stack: errorInfo.componentStack ?? null,
      route: typeof window !== "undefined" ? window.location.pathname : null,
    });
  }

  private resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      const { fallback, t } = this.props;

      // If fallback is a function, call it with error props
      if (typeof fallback === "function") {
        return fallback({
          error: this.state.error,
          resetError: this.resetError,
        });
      }

      // If fallback is provided as a static node, use it
      if (fallback !== undefined) {
        return fallback;
      }

      // A stale chunk needs a page reload, which only the root boundary does.
      if (isStaleAssetError(this.state.error)) {
        throw this.state.error;
      }

      // Org deleted / archived — show friendly screen instead of raw error
      if (isArchivedOrgError(this.state.error)) {
        return <ArchivedOrgScreen />;
      }

      // Access denied — show permission blocker instead of raw error
      if (isAccessDeniedError(this.state.error)) {
        return <NoPermissionState />;
      }

      // Default fallback UI
      return (
        <div className="flex-1 flex flex-col items-center justify-center h-full p-6 text-center space-y-4">
          <div className="bg-destructive/10 p-3 rounded-full">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {t("common.errorBoundary.somethingWentWrong")}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {this.state.error?.message ||
                t("common.errorBoundary.unexpectedError")}
            </p>
          </div>
          <Button variant="outline" onClick={this.resetError}>
            {t("common.errorBoundary.tryAgain")}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

export function ErrorBoundary(props: Props) {
  const t = useT();
  return <ErrorBoundaryImpl {...props} t={t} />;
}

interface ChunkState extends State {
  reload: StaleBuildReload | null;
}

/**
 * Root-level error boundary. Stale chunk errors after a deployment reload the
 * page with backoff (see `stale-build-reload.ts`); a manual "Refresh" button
 * appears once the automatic retries run out.
 */
class ChunkErrorBoundaryImpl extends Component<
  { children: ReactNode; t: ReturnType<typeof useT> },
  ChunkState
> {
  override state: ChunkState = { hasError: false, error: null, reload: null };

  public static getDerivedStateFromError(error: Error): Partial<ChunkState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    const isChunk = isStaleAssetError(error);
    captureException(error, {
      boundary: "chunk_root",
      is_chunk_load_error: isChunk,
      error_name: error.name,
      error_message: error.message,
      component_stack: errorInfo.componentStack ?? null,
      route: typeof window !== "undefined" ? window.location.pathname : null,
    });

    if (isChunk) this.setState({ reload: scheduleStaleBuildReload() });
  }

  override render() {
    const { t } = this.props;
    if (this.state.hasError && isStaleAssetError(this.state.error)) {
      const reloading = this.state.reload?.status !== "exhausted";
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center space-y-4">
          <div className="bg-primary/10 p-3 rounded-full">
            <RefreshCw01
              className={cn(
                "h-6 w-6 text-primary",
                reloading && "animate-spin",
              )}
            />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {t("common.errorBoundary.newVersionAvailable")}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {reloading
                ? t("common.errorBoundary.reloadingAutomatically")
                : t("common.errorBoundary.newVersionDeployed")}
            </p>
          </div>
          <Button
            variant={reloading ? "outline" : "default"}
            onClick={reloadNow}
          >
            {reloading
              ? t("common.errorBoundary.refreshNow")
              : t("common.errorBoundary.refresh")}
          </Button>
        </div>
      );
    }

    if (this.state.hasError) {
      if (isArchivedOrgError(this.state.error)) {
        return <ArchivedOrgScreen />;
      }

      return (
        <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center space-y-4">
          <div className="bg-destructive/10 p-3 rounded-full">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {t("common.errorBoundary.somethingWentWrong")}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {this.state.error?.message ||
                t("common.errorBoundary.unexpectedError")}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              this.setState({ hasError: false, error: null, reload: null })
            }
          >
            {t("common.errorBoundary.tryAgain")}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

export function ChunkErrorBoundary(props: { children: ReactNode }) {
  const t = useT();
  return <ChunkErrorBoundaryImpl {...props} t={t} />;
}
