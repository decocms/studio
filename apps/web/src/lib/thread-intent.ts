import type { ProjectLocator } from "@/sdk";
import {
  parseThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

/**
 * What the user asked a not-yet-created thread to BE, parked so the route
 * loader's create-on-404 fallback can reproduce it.
 *
 * The create paths navigate in `.catch()` by design, so a transient failure
 * hands the thread to `useEnsureTask` to create instead — and that call knows
 * only the id and the project. The runtime is stamped once and immutable, so
 * "Start coding session" that lost its create would come back as a CMS session
 * forever. The branch has the same problem, one level less permanently.
 */
export interface ThreadIntent {
  runtime?: ThreadRuntime;
  branch?: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function threadIntentStorageKey(
  locator: ProjectLocator | string,
  taskId: string,
): string {
  return LOCALSTORAGE_KEYS.chatThreadIntent(locator, taskId);
}

export function writeThreadIntent(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
  intent: ThreadIntent,
): void {
  if (!intent.runtime && !intent.branch) return;
  try {
    storage.setItem(
      threadIntentStorageKey(locator, taskId),
      JSON.stringify(intent),
    );
  } catch {
    /* storage disabled — the server default still applies */
  }
}

/** Drop a parked intent whose create succeeded — nothing will claim it. */
export function clearThreadIntent(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
): void {
  try {
    storage.removeItem(threadIntentStorageKey(locator, taskId));
  } catch {
    /* storage disabled */
  }
}

/** Read and clear. Single-use: the create it feeds is the last one for this id. */
export function claimThreadIntent(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskId: string,
): ThreadIntent {
  const key = threadIntentStorageKey(locator, taskId);
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
    storage.removeItem(key);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const candidate = parsed as Record<string, unknown>;
  const runtime = parseThreadRuntime(candidate.runtime);
  const branch =
    typeof candidate.branch === "string" && candidate.branch
      ? candidate.branch
      : undefined;
  return {
    ...(runtime ? { runtime } : {}),
    ...(branch ? { branch } : {}),
  };
}
