import type { SendMessageParams } from "@/web/components/chat/store/types";
import type { ProjectLocator } from "@decocms/mesh-sdk";
import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

export const AUTOSEND_TTL_MS = 10_000;
export const AUTOSEND_QUERY_VALUE = "true";

export interface AutosendPayload {
  message: SendMessageParams;
  createdAt: number;
}

export type AutosendStatus = "pending" | "sending";

export interface StoredAutosendPayload extends AutosendPayload {
  status: AutosendStatus;
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
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== "number" ||
    typeof (parsed as { message?: unknown }).message !== "object" ||
    !isValidStatus((parsed as { status?: unknown }).status)
  ) {
    return null;
  }
  return parsed as StoredAutosendPayload;
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
): AutosendPayload | null {
  const key = autosendStorageKey(locator, taskId);
  const payload = readStoredAutosend(storage, locator, taskId);
  if (!payload) return null;
  if (payload.status !== "pending") return null;
  if (now - payload.createdAt >= AUTOSEND_TTL_MS) {
    storage.removeItem(key);
    return null;
  }
  storage.setItem(key, JSON.stringify({ ...payload, status: "sending" }));
  return { message: payload.message, createdAt: payload.createdAt };
}

export function clearStoredAutosend(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
): void {
  storage.removeItem(autosendStorageKey(locator, taskId));
}
