import type { ChannelType } from "@/web/hooks/collections/use-channels";

/**
 * Setup wizard state machine (discriminated union + reducer). The channel draft
 * is created before the wizard opens, so every state carries a concrete
 * channelId + webhookUrl and the flow is purely linear:
 *   instructions → endpoint → credentials → testing → active
 * with `test-error` re-entry. Mirrors the AI-providers connect-dialog reducer.
 */

interface Base {
  platform: ChannelType;
  channelId: string;
  webhookUrl: string;
}

export type WizardState =
  | ({ kind: "instructions" } & Base)
  | ({ kind: "endpoint" } & Base)
  | ({ kind: "credentials" } & Base)
  | ({ kind: "testing" } & Base)
  | ({ kind: "test-error"; error: string } & Base)
  | ({ kind: "active"; botDisplayName?: string } & Base);

export type WizardAction =
  | { type: "to-endpoint" }
  | { type: "to-credentials" }
  | { type: "back-to-instructions" }
  | { type: "back-to-endpoint" }
  | { type: "creds-saved" }
  | { type: "test-passed"; botDisplayName?: string }
  | { type: "test-failed"; error: string }
  | { type: "retry-test" };

/** Index of the active step for the StepIndicator header. */
export function stepIndex(s: WizardState): number {
  switch (s.kind) {
    case "instructions":
      return 0;
    case "endpoint":
      return 1;
    case "credentials":
      return 2;
    default:
      return 3;
  }
}

export function reducer(state: WizardState, action: WizardAction): WizardState {
  const base: Base = {
    platform: state.platform,
    channelId: state.channelId,
    webhookUrl: state.webhookUrl,
  };
  switch (action.type) {
    case "to-endpoint":
      return state.kind === "instructions"
        ? { ...base, kind: "endpoint" }
        : state;
    case "to-credentials":
      return state.kind === "endpoint"
        ? { ...base, kind: "credentials" }
        : state;
    case "back-to-instructions":
      return { ...base, kind: "instructions" };
    case "back-to-endpoint":
      return { ...base, kind: "endpoint" };
    case "creds-saved":
      return state.kind === "credentials"
        ? { ...base, kind: "testing" }
        : state;
    case "test-passed":
      return { ...base, kind: "active", botDisplayName: action.botDisplayName };
    case "test-failed":
      return { ...base, kind: "test-error", error: action.error };
    case "retry-test":
      return state.kind === "test-error" ? { ...base, kind: "testing" } : state;
    default:
      return state;
  }
}

export const WIZARD_STEPS = [
  { id: "create", label: "Create" },
  { id: "endpoint", label: "Endpoint" },
  { id: "credentials", label: "Credentials" },
  { id: "test", label: "Test" },
];
