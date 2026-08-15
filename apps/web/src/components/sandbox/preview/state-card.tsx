import { Button } from "@decocms/ui/components/button.tsx";
import {
  AlertTriangle,
  PauseCircle,
  Play,
  RefreshCw01,
} from "@untitledui/icons";
import { SANDBOX_START_ERROR_CODES } from "@decocms/shared/sandbox-start-errors";
import { BootingVisual } from "./booting-visual";
import type { ClaimPhase } from "../hooks/sandbox-events-context";
import type { PhaseProgress } from "./derive-phase-progress";
import type { SandboxStartError } from "./preview-state";
import { useT } from "@/i18n/use-t.ts";

export type SandboxStateCardProps =
  | {
      kind: "starting";
      progress: PhaseProgress;
      claimPhase: ClaimPhase | null;
    }
  | { kind: "suspended"; onResume: () => void }
  | {
      kind: "errored";
      error: SandboxStartError;
      onRetry: () => void;
      /** Link to the org's Connections page, for the GitHub-auth case. */
      connectionsHref?: string;
    };

export function SandboxStateCard(props: SandboxStateCardProps) {
  const t = useT();

  if (props.kind === "starting") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <BootingVisual
          progress={props.progress}
          claimPhase={props.claimPhase}
        />
      </div>
    );
  }

  if (props.kind === "errored") {
    const needsGithubAuth =
      props.error.code === SANDBOX_START_ERROR_CODES.githubNotAuthenticated;
    const connectionMissing =
      props.error.code === SANDBOX_START_ERROR_CODES.githubConnectionMissing;
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <AlertTriangle className="size-12 text-destructive" />
          <h3 className="text-lg font-medium">
            {t("sandbox.stateCard.erroredHeadline")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {connectionMissing
              ? t("sandbox.stateCard.githubConnectionMissingMessage")
              : needsGithubAuth
                ? t("sandbox.stateCard.githubNotAuthenticatedMessage")
                : props.error.message}
          </p>
          <div className="mt-2 flex items-center gap-2">
            {(needsGithubAuth || connectionMissing) &&
              props.connectionsHref && (
                <Button asChild>
                  <a href={props.connectionsHref}>
                    {t(
                      connectionMissing
                        ? "sandbox.stateCard.linkRepoAgain"
                        : "sandbox.stateCard.reconnectGithub",
                    )}
                  </a>
                </Button>
              )}
            <Button variant="outline" onClick={props.onRetry}>
              <RefreshCw01 className="size-4" /> {t("sandbox.stateCard.retry")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <PauseCircle className="size-12 text-blue-500" />
        <h3 className="text-lg font-medium">
          {t("sandbox.stateCard.suspendedHeadline")}
        </h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("sandbox.stateCard.resumeToContinue")}
        </p>
        <Button onClick={props.onResume} className="mt-2">
          <Play className="size-4" /> {t("sandbox.stateCard.resume")}
        </Button>
      </div>
    </div>
  );
}
