import type { ConnectionEntity } from "@decocms/mesh-sdk";
import type { SlotPhase } from "./slot-resolution";

export type SlotCardState = {
  phase: SlotPhase | null;
  pollingConnectionId: string | null;
  selectedConnection: ConnectionEntity | null;
  authCheckId: string | null;
};

/** User confirmed the install form — start polling for the new connection. */
export function onInstalled(connectionId: string): Partial<SlotCardState> {
  return {
    pollingConnectionId: connectionId,
    phase: "polling",
  };
}

/** Poller observed the connection is active — mark slot as done. */
export function onPollerActive(
  connection: ConnectionEntity,
): Partial<SlotCardState> {
  return {
    pollingConnectionId: null,
    selectedConnection: connection,
    phase: "done",
  };
}

/**
 * Poller timed out or the connection errored before going active.
 * Queue an auth check to determine whether OAuth or token auth is needed.
 */
export function onPollerTimeout(
  connectionId: string,
  connection: ConnectionEntity | null,
): Partial<SlotCardState> {
  return {
    selectedConnection: connection,
    authCheckId: connectionId,
    pollingConnectionId: null,
  };
}

/** Auth check completed — transition to the appropriate auth phase. */
export function onAuthStatus(supportsOAuth: boolean): Partial<SlotCardState> {
  return {
    phase: supportsOAuth ? "auth-oauth" : "auth-token",
  };
}

/** User completed auth — restart polling to verify the connection activates. */
export function onAuthed(
  state: Pick<
    SlotCardState,
    "pollingConnectionId" | "selectedConnection" | "authCheckId"
  >,
): Partial<SlotCardState> {
  const id =
    state.pollingConnectionId ??
    state.selectedConnection?.id ??
    state.authCheckId ??
    null;
  if (!id) return {};
  return {
    authCheckId: null,
    pollingConnectionId: id,
    phase: "polling",
  };
}

/** User chose to change the connection — go back to picker or install. */
export function onReset(hasExisting: boolean): Partial<SlotCardState> {
  return {
    phase: hasExisting ? "picker" : "install",
    selectedConnection: null,
    pollingConnectionId: null,
    authCheckId: null,
  };
}

/** User picked an already-active existing connection. */
export function onPickActive(
  connection: ConnectionEntity,
): Partial<SlotCardState> {
  return {
    selectedConnection: connection,
    phase: "done",
  };
}

/** User picked an existing connection that isn't active yet — poll for it. */
export function onPickInactive(
  connection: ConnectionEntity,
): Partial<SlotCardState> {
  return {
    selectedConnection: connection,
    pollingConnectionId: connection.id,
    phase: "polling",
  };
}

/** User chose "Install fresh" from the picker. */
export function onInstallFresh(): Partial<SlotCardState> {
  return { phase: "install" };
}
