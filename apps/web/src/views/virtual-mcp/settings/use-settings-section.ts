/**
 * The open settings section, as a URL parameter.
 *
 * `?section=` is the settings panel's payload, the same way `?main=content` is
 * the Site Editor's (see `panel-route.ts`) — WHICH view is the segment, and the
 * place inside it is search. It is registered in `PANEL_PAYLOAD_KEYS`, so
 * switching to any other view clears it; opening Settings from the sidebar
 * therefore always lands on the index.
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
  const raw = (useSearch({ strict: false }) as { section?: string }).section;
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
