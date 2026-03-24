/**
 * Tracks which tasks the user has "read" (opened) since they were last updated.
 * Uses localStorage so it persists across page reloads.
 */

import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { useProjectContext } from "@decocms/mesh-sdk";

type ViewedMap = Record<string, string>;

export function useTaskReadState() {
  const { org, project } = useProjectContext();
  const locator = `${org.id}/${project.id}` as const;

  const [, setViewed] = useLocalStorage<ViewedMap>(
    LOCALSTORAGE_KEYS.taskLastViewed(locator),
    (existing) => existing ?? {},
  );

  const markTaskRead = (taskId: string) => {
    setViewed((prev) => ({
      ...prev,
      [taskId]: new Date().toISOString(),
    }));
  };

  return { markTaskRead };
}
