import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

/**
 * The legacy admin redirects every path to `/?from=legacy-admin`. Home
 * redirects to the last org and login bounces through other routes, and
 * neither carries the query along, so the entry captures the marker into
 * sessionStorage before the router runs. It survives a login in the same tab;
 * the shell reads it once the user is signed in.
 */
const ARRIVAL_PARAM = "from";
const ARRIVAL_VALUE = "legacy-admin";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** True for the marker itself, or for a login `next` that still carries it. */
function carriesArrival(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.get(ARRIVAL_PARAM) === ARRIVAL_VALUE) return true;
  const next = params.get("next");
  if (!next?.startsWith("/")) return false;
  const query = next.indexOf("?");
  return (
    query !== -1 &&
    new URLSearchParams(next.slice(query)).get(ARRIVAL_PARAM) === ARRIVAL_VALUE
  );
}

export function captureLegacyAdminArrival(
  search: string,
  storage?: FlagStorage,
): void {
  if (!carriesArrival(search)) return;
  try {
    (storage ?? sessionStorage).setItem(
      LOCALSTORAGE_KEYS.legacyAdminArrival(),
      "1",
    );
  } catch {}
}

export function hasLegacyAdminArrival(storage?: FlagStorage): boolean {
  try {
    return (
      (storage ?? sessionStorage).getItem(
        LOCALSTORAGE_KEYS.legacyAdminArrival(),
      ) === "1"
    );
  } catch {
    return false;
  }
}

export function clearLegacyAdminArrival(storage?: FlagStorage): void {
  try {
    (storage ?? sessionStorage).removeItem(
      LOCALSTORAGE_KEYS.legacyAdminArrival(),
    );
  } catch {}
}
