/** Lifecycle phases emitted while an AgentSandbox claim becomes ready. */
export type ClaimFailureReason =
  | "image-pull-backoff"
  | "crash-loop-backoff"
  | "scheduling-timeout"
  | "claim-never-created"
  | "reconciler-error"
  | "unknown";

export type ClaimPhase =
  | { kind: "claiming"; since: number }
  | {
      kind: "waiting-for-capacity";
      since: number;
      message?: string;
      /** Karpenter-emitted nodeclaim name when a node is being provisioned. */
      nodeClaim?: string;
    }
  | { kind: "pulling-image"; since: number }
  | { kind: "starting-container"; since: number }
  | { kind: "warming-daemon"; since: number }
  | { kind: "ready" }
  | { kind: "failed"; reason: ClaimFailureReason; message: string };
