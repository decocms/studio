export type DialogState =
  | { kind: "closed" }
  | { kind: "grid" }
  | { kind: "form"; providerId: string; presetId: string | null }
  | { kind: "oauth-pending"; providerId: string; stateToken: string }
  | { kind: "cli-pending"; providerId: string }
  | { kind: "cli-error"; providerId: string; error: string };

export type DialogAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "back" }
  | { type: "select-form"; providerId: string; presetId: string | null }
  | { type: "select-oauth"; providerId: string; stateToken: string }
  | { type: "select-cli"; providerId: string }
  | { type: "oauth-failed" }
  | { type: "cli-error"; error: string }
  | { type: "retry-cli" };

export const initialState: DialogState = { kind: "closed" };

export function reducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "open":
      return state.kind === "closed" ? { kind: "grid" } : state;
    case "close":
      return { kind: "closed" };
    case "back":
      switch (state.kind) {
        case "form":
        case "oauth-pending":
        case "cli-pending":
        case "cli-error":
          return { kind: "grid" };
        default:
          return state;
      }
    case "select-form":
      if (state.kind !== "grid") return state;
      return {
        kind: "form",
        providerId: action.providerId,
        presetId: action.presetId,
      };
    case "select-oauth":
      if (state.kind !== "grid") return state;
      return {
        kind: "oauth-pending",
        providerId: action.providerId,
        stateToken: action.stateToken,
      };
    case "select-cli":
      if (state.kind !== "grid") return state;
      return { kind: "cli-pending", providerId: action.providerId };
    case "oauth-failed":
      return state.kind === "oauth-pending" ? { kind: "grid" } : state;
    case "cli-error":
      if (state.kind !== "cli-pending") return state;
      return {
        kind: "cli-error",
        providerId: state.providerId,
        error: action.error,
      };
    case "retry-cli":
      if (state.kind !== "cli-error") return state;
      return { kind: "cli-pending", providerId: state.providerId };
  }
}
