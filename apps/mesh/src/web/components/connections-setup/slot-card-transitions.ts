import type { ConnectionEntity, McpAuthStatus } from "@decocms/mesh-sdk";
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

/**
 * Poller observed the connection is active at the transport level.
 * We don't go to "done" yet — we always check auth first, because some
 * connections (e.g. Gmail) respond 200 before OAuth is configured.
 * onAuthStatus("active") then decides: no-OAuth → done, OAuth → auth-oauth.
 */
export function onPollerActive(
  connection: ConnectionEntity,
): Partial<SlotCardState> {
  return {
    pollingConnectionId: null,
    selectedConnection: connection,
    authCheckId: connection.id,
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

/**
 * Determine which auth phase to enter after the auth check completes.
 *
 * source "active"  — poller confirmed the connection responds to initialize.
 *   OAuth needed?   → "auth-oauth"  (connection has oauth_config but no token yet,
 *                                    OR server returned 401 + WWW-Authenticate)
 *   No auth needed  → "done"        (working without auth, or OAuth already done)
 *
 * source "timeout" — connection never became active before the poll timeout.
 *   OAuth needed?   → "auth-oauth"
 *   No OAuth cue    → "auth-token"  (not working; probably needs an API token)
 *
 * NOTE: supportsOAuth is only reliable when the server returns 401 + WWW-Authenticate.
 * Many services (e.g. Gmail) accept initialize without auth, so we also check
 * connection.oauth_config + hasOAuthToken to catch the "active but needs OAuth" case.
 */
export function resolveAuthPhase(
  authStatus: McpAuthStatus,
  selectedConnection: ConnectionEntity | null,
  source: "active" | "timeout",
): "auth-oauth" | "auth-token" | "done" {
  const needsOAuth =
    // Connection was created with OAuth config and the token hasn't been obtained yet
    (!!selectedConnection?.oauth_config && !authStatus.hasOAuthToken) ||
    // Server returned 401 + WWW-Authenticate (the reliable OAuth detection path)
    (!authStatus.isAuthenticated && authStatus.supportsOAuth);

  if (needsOAuth) return "auth-oauth";
  if (source === "active" && authStatus.isAuthenticated) return "done";
  return "auth-token";
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
