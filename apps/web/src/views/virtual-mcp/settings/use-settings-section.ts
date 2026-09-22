import { useCompactPageLayout } from "@/hooks/use-preferences";
/** General is the default tab, including for unrecognized section links. */

import { useSearch, useNavigate } from "@tanstack/react-router";
import {
  isProjectSettingsSectionKey,
  type ProjectSettingsSectionKey,
} from "./sections";

export function useProjectSettingsSection() {
  const compact = useCompactPageLayout();
  const navigate = useNavigate();
  const { section } = useSearch({ strict: false });
  return {
    section: isProjectSettingsSectionKey(section)
      ? section
      : compact
        ? "general"
        : null,
    openSection: (next: ProjectSettingsSectionKey | null) =>
      navigate({
        to: ".",
        search: (previous) => ({ ...previous, section: next ?? undefined }),
      }),
  };
}
