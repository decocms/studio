import {
  useLocation,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";

/** The history entry's mark: this view pushed it to open that test. */
const OPENED_TEST = "openedTest";

/**
 * The URL's `?test=`: the Blocks v8 test a view shows, by name, in the
 * Experiments app and in Monitor's Experiments view alike. Opening one pushes
 * an entry Back undoes; closing one this view opened goes back to the entry
 * it pushed over, so Back never lands on the same list twice. Closing one
 * opened by a link (no entry of ours to go back to) replaces it, as `clear`
 * does for a name the view doesn't have.
 */
export function useOpenTestSearch(): {
  name: string | null;
  set: (name: string | null) => void;
  /** Drops `?test=` in place, with no step for Back. */
  clear: () => void;
} {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const router = useRouter();
  const state = useLocation().state as unknown as
    | Record<string, unknown>
    | undefined;
  const openedHere = state?.[OPENED_TEST];
  const name =
    "test" in search && typeof search.test === "string" && search.test
      ? search.test
      : null;
  const clear = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        test: undefined,
      }),
      replace: true,
    });
  return {
    name,
    clear,
    set: (next) => {
      if (next === null) {
        if (name !== null && openedHere === name) router.history.back();
        else clear();
        return;
      }
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, test: next }),
        // A history state key of this view's own (HistoryState is open).
        state: ((prev: Record<string, unknown>) => ({
          ...prev,
          [OPENED_TEST]: next,
        })) as never,
      });
    },
  };
}
