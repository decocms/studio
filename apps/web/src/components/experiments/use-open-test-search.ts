import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * The URL's `?test=`: the Blocks v8 test a view shows, by name, in the
 * Experiments app and in Monitor's Experiments view alike. Opening one is a
 * step Back undoes; closing one replaces it.
 */
export function useOpenTestSearch(): {
  name: string | null;
  set: (name: string | null) => void;
} {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const name =
    "test" in search && typeof search.test === "string" && search.test
      ? search.test
      : null;
  return {
    name,
    set: (next) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          test: next ?? undefined,
        }),
        replace: next === null,
      }),
  };
}
