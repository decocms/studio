/** Project settings tabs. Existing `?section=` links keep their destinations. */

import type { TranslationKey } from "@/i18n/use-t.ts";

export const PROJECT_SETTINGS_SECTION_KEYS = [
  "general",
  "connections",
  "site",
  "views",
] as const;

export type ProjectSettingsSectionKey =
  (typeof PROJECT_SETTINGS_SECTION_KEYS)[number];

export interface ProjectSettingsSectionDef {
  titleKey: TranslationKey;
  headingKey: TranslationKey;
  descriptionKey: TranslationKey;
}

export const PROJECT_SETTINGS_SECTIONS: Record<
  ProjectSettingsSectionKey,
  ProjectSettingsSectionDef
> = {
  general: {
    titleKey: "virtualMcp.settings.general.title",
    headingKey: "virtualMcp.settings.general.heading",
    descriptionKey: "virtualMcp.settings.general.description",
  },
  connections: {
    titleKey: "virtualMcp.settings.connections.title",
    headingKey: "virtualMcp.settings.connections.heading",
    descriptionKey: "virtualMcp.settings.connections.description",
  },
  site: {
    titleKey: "virtualMcp.settings.site.title",
    headingKey: "virtualMcp.settings.site.heading",
    descriptionKey: "virtualMcp.settings.site.description",
  },
  views: {
    titleKey: "virtualMcp.settings.views.projectViews",
    headingKey: "virtualMcp.settings.views.projectViews",
    descriptionKey: "virtualMcp.settings.views.description",
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
