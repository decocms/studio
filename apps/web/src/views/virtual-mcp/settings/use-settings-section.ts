import type { ProjectSettingsSectionKey } from "./sections";
/** General is the default tab, including for unrecognized section links. */

import { useSearch, useNavigate } from "@tanstack/react-router";
import { isProjectSettingsSectionKey } from "./sections";

export function useProjectSettingsSection() {
  const navigate = useNavigate();
  const { section } = useSearch({ strict: false });
  return {
    section: isProjectSettingsSectionKey(section) ? section : "general",
    openSection: (next: ProjectSettingsSectionKey | null) =>
      navigate({
        to: ".",
        search: (previous) => ({ ...previous, section: next ?? undefined }),
      }),
  };
}
