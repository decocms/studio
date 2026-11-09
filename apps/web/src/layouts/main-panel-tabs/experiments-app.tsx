/**
 * A Blocks (v8) project's Experiments app: its A/B tests, edited in the draft
 * (`ExperimentsBlockTab`). The open test is the URL's `?test=`, so a link can
 * open one and Back closes it.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { ExperimentsBlockTab } from "./experiments-block-tab";

/** The URL's `?test=`: the test the app shows, if any. */
function useOpenTestSearch(): {
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
    // Opening one is a step Back undoes; closing one replaces it.
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

export function ExperimentsApp({ virtualMcpId }: { virtualMcpId: string }) {
  const open = useOpenTestSearch();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExperimentsBlockTab virtualMcpId={virtualMcpId} open={open} />
    </div>
  );
}
