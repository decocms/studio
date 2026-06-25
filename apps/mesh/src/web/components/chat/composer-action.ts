/** The composer's primary-button action. */
export type ComposerAction = "send" | "stop" | "disabled";

/**
 * Decide the composer's primary-button action.
 *
 * A draft always sends — even while a run streams or a hosted run is in
 * progress — because a second message enqueues behind the running one on the
 * thread gate (concurrency=1 serializes them). With no draft, an active run
 * offers stop; otherwise the button is disabled. Pure + total.
 */
export function resolveComposerAction(state: {
  hasDraft: boolean;
  isStreaming: boolean;
  isRunInProgress: boolean;
}): ComposerAction {
  if (state.hasDraft) return "send";
  if (state.isStreaming || state.isRunInProgress) return "stop";
  return "disabled";
}
