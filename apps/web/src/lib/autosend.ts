import type { SendMessageParams } from "@/components/chat/store/types";
import type { ProjectLocator } from "@/sdk";
import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

export const AUTOSEND_TTL_MS = 10_000;
export const AUTOSEND_QUERY_VALUE = "true";
export const AUTOSEND_MAX_ATTEMPTS = 2;

export interface AutosendPayload {
  message: SendMessageParams;
  createdAt: number;
}

export interface ClaimedAutosendPayload extends AutosendPayload {
  /** One-based dispatch attempt, persisted before the caller starts I/O. */
  attempt: number;
}

export type AutosendStatus = "pending" | "sending";

export interface StoredAutosendPayload extends AutosendPayload {
  status: AutosendStatus;
  /** Number of dispatch attempts already claimed. */
  attempt: number;
  /** Starts one fresh, bounded retry window after an explicit native rejection. */
  retryAt?: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function autosendStorageKey(
  locator: ProjectLocator | string,
  taskId: string,
): string {
  return LOCALSTORAGE_KEYS.chatAutosend(locator, taskId);
}

function isValidStatus(status: unknown): status is AutosendStatus {
  return status === "pending" || status === "sending";
}

function parseStoredAutosend(
  value: string | null,
): StoredAutosendPayload | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  let legacyAttempt = 0;
  if (candidate.status === "sending") {
    legacyAttempt = candidate.retryAt === undefined ? 1 : AUTOSEND_MAX_ATTEMPTS;
  } else if (candidate.retryAt !== undefined) {
    legacyAttempt = 1;
  }
  const attempt =
    candidate.attempt === undefined ? legacyAttempt : candidate.attempt;
  if (
    typeof candidate.createdAt !== "number" ||
    typeof candidate.message !== "object" ||
    !isValidStatus(candidate.status) ||
    (candidate.retryAt !== undefined &&
      typeof candidate.retryAt !== "number") ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    attempt > AUTOSEND_MAX_ATTEMPTS
  ) {
    return null;
  }
  return { ...(parsed as StoredAutosendPayload), attempt };
}

export function writeStoredAutosend(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
  message: SendMessageParams,
  createdAt = Date.now(),
): StoredAutosendPayload {
  const payload: StoredAutosendPayload = {
    message,
    createdAt,
    status: "pending",
    attempt: 0,
  };
  storage.setItem(autosendStorageKey(locator, taskId), JSON.stringify(payload));
  return payload;
}

export function readStoredAutosend(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
): StoredAutosendPayload | null {
  const key = autosendStorageKey(locator, taskId);
  const payload = parseStoredAutosend(storage.getItem(key));
  if (!payload) {
    storage.removeItem(key);
    return null;
  }
  return payload;
}

export function claimStoredAutosend(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
  now = Date.now(),
): ClaimedAutosendPayload | null {
  const key = autosendStorageKey(locator, taskId);
  const payload = readStoredAutosend(storage, locator, taskId);
  if (!payload) return null;
  if (payload.status !== "pending") return null;
  if (payload.attempt >= AUTOSEND_MAX_ATTEMPTS) {
    storage.removeItem(key);
    return null;
  }
  const freshnessAnchor = payload.retryAt ?? payload.createdAt;
  if (now - freshnessAnchor >= AUTOSEND_TTL_MS) {
    storage.removeItem(key);
    return null;
  }
  const claimed: StoredAutosendPayload = {
    ...payload,
    status: "sending",
    attempt: payload.attempt + 1,
  };
  storage.setItem(key, JSON.stringify(claimed));
  return {
    message: claimed.message,
    createdAt: claimed.createdAt,
    attempt: claimed.attempt,
  };
}

export function clearStoredAutosend(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
): void {
  storage.removeItem(autosendStorageKey(locator, taskId));
}

/**
 * Return a claimed payload to pending after a native terminal launch/submit
 * was explicitly rejected. The createdAt comparison prevents an older failed
 * message from overwriting a newer one, while the attempt comparison prevents
 * a late rejection from mutating a retry already claimed after a remount.
 * The second rejected attempt exhausts the handoff and removes it.
 */
export function restoreStoredAutosend(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
  createdAt: number,
  attempt: number,
  now = Date.now(),
): void {
  const key = autosendStorageKey(locator, taskId);
  const payload = readStoredAutosend(storage, locator, taskId);
  if (
    !payload ||
    payload.status !== "sending" ||
    payload.createdAt !== createdAt ||
    payload.attempt !== attempt
  ) {
    return;
  }
  if (payload.attempt >= AUTOSEND_MAX_ATTEMPTS) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(
    key,
    JSON.stringify({ ...payload, status: "pending", retryAt: now }),
  );
}
