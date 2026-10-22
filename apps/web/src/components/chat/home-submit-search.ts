import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";

/**
 * Where a home composer's send lands. Homes declare their own main view, so
 * their chat starts collapsed and a new thread has no messages to open it:
 * without `sidepanel` the reply would run behind "Show chat". Task mode is a
 * hand-off, so it shows the work and only the work.
 */
export function homeSubmitSearch(
  taskIntake: boolean,
): Record<string, string | boolean> {
  return {
    autosend: AUTOSEND_QUERY_VALUE,
    sidepanel: true,
    ...(taskIntake ? { mainpanel: false } : {}),
  };
}
