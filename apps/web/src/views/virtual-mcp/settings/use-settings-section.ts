/** General is the default tab, including for unrecognized section links. */

import { useSearch } from "@tanstack/react-router";
import {
  isProjectSettingsSectionKey,
  type ProjectSettingsSectionKey,
} from "./sections";

export function useProjectSettingsSection(): ProjectSettingsSectionKey {
  const { section } = useSearch({ strict: false });
  return isProjectSettingsSectionKey(section) ? section : "general";
}
