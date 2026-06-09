import type { ChannelType } from "@/web/hooks/collections/use-channels";

/**
 * Setup wizard state machine (discriminated union + reducer), mirroring the
 * AI-providers connect-dialog. Linear lifecycle:
 *   grid → (creating-draft) → instructions → endpoint → credentials → testing → active
 * with `test-error` re-entry. Draft-first: the channel id (and webhook URL) is
 * created up front so the platform portal can be configured before testing.
 */

export type WizardState =
  | { kind: "closed" }
  | { kind: "grid" }
  | { kind: "creating-draft"; platform: ChannelType }
  | {
      kind: "instructions";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
    }
  | {
      kind: "endpoint";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
    }
  | {
      kind: "credentials";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
    }
  | {
      kind: "testing";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
    }
  | {
      kind: "test-error";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
      error: string;
    }
  | {
      kind: "active";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
      botDisplayName?: string;
    };

export type WizardAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "select-platform"; platform: ChannelType }
  | {
      type: "draft-created";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
    }
  | { type: "draft-failed" }
  | { type: "to-endpoint" }
  | { type: "to-credentials" }
  | { type: "back-to-instructions" }
  | { type: "back-to-endpoint" }
  | { type: "creds-saved" }
  | { type: "test-passed"; botDisplayName?: string }
  | { type: "test-failed"; error: string }
  | { type: "retry-test" }
  | {
      type: "resume";
      platform: ChannelType;
      channelId: string;
      webhookUrl: string;
      step: "instructions" | "endpoint" | "credentials" | "testing";
    };

export const initialState: WizardState = { kind: "closed" };

/** Index of the active step for the StepIndicator header. */
export function stepIndex(s: WizardState): number {
  switch (s.kind) {
    case "instructions":
      return 0;
    case "endpoint":
      return 1;
    case "credentials":
      return 2;
    case "testing":
    case "test-error":
    case "active":
      return 3;
    default:
      return 0;
  }
}

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "open":
      return { kind: "grid" };
    case "close":
      return { kind: "closed" };
    case "select-platform":
      return { kind: "creating-draft", platform: action.platform };
    case "draft-created":
      return {
        kind: "instructions",
        platform: action.platform,
        channelId: action.channelId,
        webhookUrl: action.webhookUrl,
      };
    case "draft-failed":
      return { kind: "grid" };
    case "to-endpoint":
      return state.kind === "instructions"
        ? { ...state, kind: "endpoint" }
        : state;
    case "to-credentials":
      return state.kind === "endpoint"
        ? { ...state, kind: "credentials" }
        : state;
    case "back-to-instructions":
      return "channelId" in state
        ? {
            kind: "instructions",
            platform: state.platform,
            channelId: state.channelId,
            webhookUrl: state.webhookUrl,
          }
        : state;
    case "back-to-endpoint":
      return "channelId" in state
        ? {
            kind: "endpoint",
            platform: state.platform,
            channelId: state.channelId,
            webhookUrl: state.webhookUrl,
          }
        : state;
    case "creds-saved":
      return state.kind === "credentials"
        ? { ...state, kind: "testing" }
        : state;
    case "test-passed":
      return "channelId" in state
        ? {
            kind: "active",
            platform: state.platform,
            channelId: state.channelId,
            webhookUrl: state.webhookUrl,
            botDisplayName: action.botDisplayName,
          }
        : state;
    case "test-failed":
      return "channelId" in state
        ? {
            kind: "test-error",
            platform: state.platform,
            channelId: state.channelId,
            webhookUrl: state.webhookUrl,
            error: action.error,
          }
        : state;
    case "retry-test":
      return state.kind === "test-error"
        ? {
            kind: "testing",
            platform: state.platform,
            channelId: state.channelId,
            webhookUrl: state.webhookUrl,
          }
        : state;
    case "resume":
      return {
        kind: action.step,
        platform: action.platform,
        channelId: action.channelId,
        webhookUrl: action.webhookUrl,
      };
    default:
      return state;
  }
}

export const WIZARD_STEPS = [
  { id: "create", label: "Create app" },
  { id: "endpoint", label: "Endpoint" },
  { id: "credentials", label: "Credentials" },
  { id: "test", label: "Test" },
];
