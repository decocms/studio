import { Button } from "@deco/ui/components/button.tsx";
import { PauseCircle, Play } from "@untitledui/icons";
import { BootingVisual } from "./booting-visual";
import type { ClaimPhase } from "../hooks/sandbox-events-context";
import type { PhaseProgress } from "./derive-phase-progress";
import { headlineFor } from "./state-card-helpers";

export type SandboxStateCardProps =
  | {
      kind: "starting";
      progress: PhaseProgress;
      claimPhase: ClaimPhase | null;
    }
  | { kind: "suspended"; onResume: () => void };

export function SandboxStateCard(props: SandboxStateCardProps) {
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

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <PauseCircle className="size-12 text-blue-500" />
        <h3 className="text-lg font-medium">{headlineFor("suspended")}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          Resume to continue.
        </p>
        <Button onClick={props.onResume} className="mt-2">
          <Play className="size-4" /> Resume
        </Button>
      </div>
    </div>
  );
}
