/**
 * The open settings section, as a URL parameter.
 *
 * `?section=` belongs to the Settings route. Panel navigation carries only
 * shell-owned search, so switching views clears it and opening Settings from
 * the sidebar lands on the index.
 *
 * Drilling in is a real navigation (not `replace`), so Back returns to the
 * index instead of leaving the panel.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  isProjectSettingsSectionKey,
  type ProjectSettingsSectionKey,
} from "./sections";

export function useProjectSettingsSection(): {
  section: ProjectSettingsSectionKey | null;
  openSection: (section: ProjectSettingsSectionKey | null) => void;
} {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const raw = "section" in search ? search.section : undefined;
  const section = isProjectSettingsSectionKey(raw) ? raw : null;

  return {
    section,
    openSection: (next) =>
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          section: next ?? undefined,
        }),
      }),
  };
}
