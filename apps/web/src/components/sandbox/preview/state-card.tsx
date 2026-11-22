import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
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
      <EmptyState
        className="h-full w-full bg-background"
        tone="destructive"
        icon={<AlertTriangle />}
        title={t("sandbox.stateCard.erroredHeadline")}
        description={
          connectionMissing
            ? t("sandbox.stateCard.githubConnectionMissingMessage")
            : needsGithubAuth
              ? t("sandbox.stateCard.githubNotAuthenticatedMessage")
              : props.error.message
        }
        buttonComponent={
          <>
            {(needsGithubAuth || connectionMissing) &&
              props.connectionsHref && (
                <Button size="sm" asChild>
                  <a href={props.connectionsHref}>
                    {t(
                      connectionMissing
                        ? "sandbox.stateCard.linkRepoAgain"
                        : "sandbox.stateCard.reconnectGithub",
                    )}
                  </a>
                </Button>
              )}
            <Button variant="outline" size="sm" onClick={props.onRetry}>
              <RefreshCw01 /> {t("sandbox.stateCard.retry")}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <EmptyState
      className="h-full w-full bg-background"
      icon={<PauseCircle />}
      title={t("sandbox.stateCard.suspendedHeadline")}
      description={t("sandbox.stateCard.resumeToContinue")}
      buttonProps={{
        onClick: props.onResume,
        children: (
          <>
            <Play /> {t("sandbox.stateCard.resume")}
          </>
        ),
      }}
    />
  );
}
