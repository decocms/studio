import { ptBR as ptBRLocale } from "date-fns/locale/pt-BR";
import { usePreferences } from "./use-preferences.ts";

/** The `date-fns` locale matching the user's language preference. */
export function useDateFnsLocale() {
  const [preferences] = usePreferences();
  return preferences.language === "pt-BR" ? ptBRLocale : undefined;
}
