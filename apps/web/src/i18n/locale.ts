export type Locale = "en" | "pt-BR";

export const VALID_LOCALES: Locale[] = ["en", "pt-BR"];

export function detectLocale(): Locale {
  // navigator.language is optional-chained: Bun defines navigator without it.
  return typeof navigator !== "undefined" &&
    navigator.language?.toLowerCase().startsWith("pt")
    ? "pt-BR"
    : "en";
}
