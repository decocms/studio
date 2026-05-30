export type DialogState =
  | { kind: "closed" }
  | { kind: "grid" }
  | { kind: "form"; providerId: string; presetId: string | null }
  | { kind: "oauth-pending"; providerId: string; stateToken: string }
  | { kind: "provision-pending"; providerId: string }
  | { kind: "provision-error"; providerId: string; error: string };

export type DialogAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "back" }
  | { type: "select-form"; providerId: string; presetId: string | null }
  | { type: "select-oauth"; providerId: string; stateToken: string }
  | { type: "select-provision"; providerId: string }
  | { type: "oauth-failed" }
  | { type: "provision-error"; error: string }
  | { type: "retry-provision" };

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
        case "provision-pending":
        case "provision-error":
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
    case "oauth-failed":
      return state.kind === "oauth-pending" ? { kind: "grid" } : state;
    case "select-provision":
      if (state.kind !== "grid") return state;
      return { kind: "provision-pending", providerId: action.providerId };
    case "provision-error":
      if (state.kind !== "provision-pending") return state;
      return {
        kind: "provision-error",
        providerId: state.providerId,
        error: action.error,
      };
    case "retry-provision":
      if (state.kind !== "provision-error") return state;
      return { kind: "provision-pending", providerId: state.providerId };
  }
}
