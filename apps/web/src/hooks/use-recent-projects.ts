/** The projects last opened in an org, newest first, so the rail can put them
 *  back one click away. Recorded where a project is opened, not on render. */

import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

const EMPTY: string[] = [];
/** Enough to come back to what you were doing; more turns the rail into a list. */
export const RECENT_PROJECTS_LIMIT = 4;

export function pushRecentProject(prev: readonly string[], id: string) {
  return [id, ...prev.filter((other) => other !== id)].slice(
    0,
    RECENT_PROJECTS_LIMIT,
  );
}

export function useRecentProjects(orgSlug: string) {
  const [stored, setStored] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.recentProjects(orgSlug),
    EMPTY,
  );
  /** A value from an older build must not crash the rail. */
  const recent = Array.isArray(stored) ? stored : EMPTY;
  return {
    recent,
    remember: (id: string) =>
      setStored((prev) =>
        pushRecentProject(Array.isArray(prev) ? prev : EMPTY, id),
      ),
    forget: (id: string) =>
      setStored((prev) =>
        (Array.isArray(prev) ? prev : EMPTY).filter((other) => other !== id),
      ),
  };
}
