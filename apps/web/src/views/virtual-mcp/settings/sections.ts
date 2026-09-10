/**
 * Project settings, as a few places rather than one long page.
 *
 * Settings used to be a single scroll: identity, connections, instructions,
 * files, sub-projects, layout, CMS, sandbox and the delete button, stacked. It
 * read as a wall, and the things people actually come here for (the views, the
 * instructions) were the furthest down.
 *
 * So it is an index of SECTIONS, each with its own address — `?section=<key>`
 * on the settings panel. A section is a HANDFUL of related concerns, not one
 * field each: splitting per concern only moved the wall into the index.
 * The key is the URL's, so a section is linkable and Back returns to the index.
 */

import type { TranslationKey } from "@/i18n/use-t.ts";

export const PROJECT_SETTINGS_SECTION_KEYS = [
  "general",
  "connections",
  "site",
] as const;

export type ProjectSettingsSectionKey =
  (typeof PROJECT_SETTINGS_SECTION_KEYS)[number];

export interface ProjectSettingsSectionDef {
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}

/** Title and description, in ONE place: the index row and the section's own
 *  header read the same words, so a row can never promise a different page. */
export const PROJECT_SETTINGS_SECTIONS: Record<
  ProjectSettingsSectionKey,
  ProjectSettingsSectionDef
> = {
  general: {
    titleKey: "virtualMcp.settings.general.title",
    descriptionKey: "virtualMcp.settings.general.description",
  },
  connections: {
    titleKey: "virtualMcp.settings.connections.title",
    descriptionKey: "virtualMcp.settings.connections.description",
  },
  site: {
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
