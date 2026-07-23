/**
 * A one-shot boolean flag persisted in localStorage as the string `"1"`.
 *
 * Consolidates the try/catch-guarded "has the user seen/dismissed this once?"
 * pattern that was copied across features (CMS tour, pt-BR announcement, …).
 * Pass a fully-resolved key (build it from `LOCALSTORAGE_KEYS`).
 */
export function makeSeenFlag(key: string): {
  has: () => boolean;
  mark: () => void;
} {
  return {
    has() {
      try {
        return localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    mark() {
      try {
        localStorage.setItem(key, "1");
      } catch {}
    },
  };
}
