/**
 * Client for the editor side of app preview sessions
 * (`/api/:org/app-preview/:vmcp/sessions`). The pairing code in these
 * responses stays in component memory: never logged, persisted, or keyed on.
 */

import type { OverlayPatch } from "./overlay-sync";

export interface AppPreviewScope {
  org: string;
  virtualMcpId: string;
}

export interface AppPreviewPairing {
  id: string;
  branch: string;
  pairingCode: string;
  pairingExpiresAt: string;
  expiresAt: string;
  link: string | null;
}

export interface AppPreviewSessionState {
  id: string;
  branch: string;
  rev: number;
  expiresAt: string;
  revokedAt: string | null;
  devices: { id: string; createdAt: string; lastSeenAt: string }[];
}

export class AppPreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The session no longer exists for this user (ended, expired, or signed out). */
export function isSessionGone(error: unknown): boolean {
  return (
    error instanceof AppPreviewError &&
    (error.status === 404 || error.status === 401)
  );
}

function sessionsUrl(scope: AppPreviewScope, path = ""): string {
  return `/api/${scope.org}/app-preview/${encodeURIComponent(scope.virtualMcpId)}/sessions${path}`;
}

async function call<T>(
  scope: AppPreviewScope,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(sessionsUrl(scope, path), {
    method,
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AppPreviewError(res.status, payload.error ?? `${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const createSession = (scope: AppPreviewScope, branch: string) =>
  call<AppPreviewPairing>(scope, "POST", "", { branch });

export const newPairing = (scope: AppPreviewScope, id: string) =>
  call<AppPreviewPairing>(scope, "POST", `/${encodeURIComponent(id)}/pairing`);

export const getSession = (scope: AppPreviewScope, id: string) =>
  call<AppPreviewSessionState>(scope, "GET", `/${encodeURIComponent(id)}`);

export const patchOverlay = (
  scope: AppPreviewScope,
  id: string,
  patch: OverlayPatch,
) =>
  call<{ rev: number }>(
    scope,
    "PATCH",
    `/${encodeURIComponent(id)}/overlay`,
    patch,
  );

/** Best-effort revoke; `keepalive` lets it outlive an unmounting page. */
export function endSession(scope: AppPreviewScope, id: string): void {
  void fetch(sessionsUrl(scope, `/${encodeURIComponent(id)}`), {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {});
}
