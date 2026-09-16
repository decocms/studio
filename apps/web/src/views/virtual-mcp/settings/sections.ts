/** Project settings tabs. Existing `?section=` links keep their destinations. */

import type { TranslationKey } from "@/i18n/use-t.ts";
import { Database01, Link01, Settings01 } from "@untitledui/icons";
import type { ComponentType, SVGProps } from "react";

export const PROJECT_SETTINGS_SECTION_KEYS = [
  "general",
  "connections",
  "site",
] as const;

export type ProjectSettingsSectionKey =
  (typeof PROJECT_SETTINGS_SECTION_KEYS)[number];

export interface ProjectSettingsSectionDef {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}

export const PROJECT_SETTINGS_SECTIONS: Record<
  ProjectSettingsSectionKey,
  ProjectSettingsSectionDef
> = {
  general: {
    icon: Settings01,
    titleKey: "virtualMcp.settings.general.title",
    descriptionKey: "virtualMcp.settings.general.description",
  },
  connections: {
    icon: Link01,
    titleKey: "virtualMcp.settings.connections.title",
    descriptionKey: "virtualMcp.settings.connections.description",
  },
  site: {
    icon: Database01,
    titleKey: "virtualMcp.settings.site.title",
    descriptionKey: "virtualMcp.settings.site.description",
  },
};

export function isProjectSettingsSectionKey(
  value: string | undefined | null,
): value is ProjectSettingsSectionKey {
  return (
    !!value &&
    (PROJECT_SETTINGS_SECTION_KEYS as readonly string[]).includes(value)
  );
}
