import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { AlertTriangle, RefreshCw01 } from "@untitledui/icons";
import { captureException } from "@/lib/posthog-client";
import { ArchivedOrgScreen } from "@/components/archived-org-screen";
import { NoPermissionState } from "@/components/no-permission-state";
import { useT } from "@/i18n/use-t.ts";

const CHUNK_RELOAD_KEY = "__studio_chunk_reload_ts";

function isArchivedOrgError(error: Error | null): boolean {
  return error?.message === "Organization is archived";
}

function isAccessDeniedError(error: Error | null): boolean {
  return !!error?.message?.includes("Access denied");
}

/**
 * Detects errors caused by stale dynamic imports after a deployment.
 * When the app deploys new code, Vite's hashed asset filenames change.
 * Users with the old HTML cached will try to fetch chunks that no longer exist.
 */
function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message || "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    // Chrome network errors during import
    (msg.includes("Failed to fetch") && error.name === "TypeError")
  );
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

/**
 * Root-level error boundary that handles stale chunk errors after deployments.
 * Automatically reloads the page once; if the reload already happened recently,
 * shows a manual "Refresh" button instead (to prevent infinite reload loops).
 */
class ChunkErrorBoundaryImpl extends Component<
  { children: ReactNode; t: ReturnType<typeof useT> },
  State
> {
  override state: State = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    const isChunk = isChunkLoadError(error);
    captureException(error, {
      boundary: "chunk_root",
      is_chunk_load_error: isChunk,
      error_name: error.name,
      error_message: error.message,
      component_stack: errorInfo.componentStack ?? null,
      route: typeof window !== "undefined" ? window.location.pathname : null,
    });

    if (!isChunk) return;

    // Auto-reload once. Guard against infinite loops with a timestamp check.
    const lastReload = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    const now = Date.now();
    if (!lastReload || now - Number(lastReload) > 10_000) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
      window.location.reload();
    }
  }

  override render() {
    const { t } = this.props;
    if (this.state.hasError && isChunkLoadError(this.state.error)) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center space-y-4">
          <div className="bg-primary/10 p-3 rounded-full">
            <RefreshCw01 className="h-6 w-6 text-primary" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {t("common.errorBoundary.newVersionAvailable")}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {t("common.errorBoundary.newVersionDeployed")}
            </p>
          </div>
          <Button onClick={() => window.location.reload()}>
            {t("common.errorBoundary.refresh")}
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
            onClick={() => this.setState({ hasError: false, error: null })}
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
