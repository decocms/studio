/**
 * Naming and searching Jira boards in the picker.
 *
 * Split out from the settings view because both rules are subtle enough to
 * regress silently: what a human calls a board is not what Jira's API calls it,
 * and the search has to survive a list of dozens of near-identical names.
 */

export interface JiraBoardSummary {
  id: number;
  name: string;
  projectKey?: string;
  projectName?: string;
}

export interface JiraBoardLabels {
  /** What the trigger shows and what we persist. */
  primary: string;
  /** Qualifier line under it — may be empty. */
  secondary: string;
}

/**
 * Jira's `board.name` is not what people recognize: for team-managed projects it
 * auto-generates "<KEY> board" and never shows it anywhere in its own UI, where
 * the board header carries the PROJECT name instead. So the project leads, and
 * the board's own name qualifies it — which is what disambiguates the
 * company-managed case, where one project legitimately owns several boards
 * ("… - Demandas", "… - Épicos").
 */
export function boardLabels(board: JiraBoardSummary): JiraBoardLabels {
  // Project names arrive with whatever spacing someone typed into Jira.
  const project = board.projectName?.replace(/\s+/g, " ").trim();
  const name = board.name.trim();
  if (!project) return { primary: name, secondary: board.projectKey ?? "" };
  return {
    primary: project,
    secondary: [name, board.projectKey].filter(Boolean).join(" · "),
  };
}

/**
 * The option's search text. Ends with the board id because the Combobox
 * resolves a pick by LABEL, and one Jira site can hold several boards with the
 * same name in different projects — three "03. Tarefas" is a real shape, and
 * without the id they would collapse into one option that selects the wrong
 * board. Searching by id is a harmless side effect.
 */
export function boardSearchText(board: JiraBoardSummary): string {
  const { primary, secondary } = boardLabels(board);
  return [primary, secondary, `#${board.id}`].filter(Boolean).join(" ");
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Diacritic- and case-insensitive substring match, every term required.
 *
 * cmdk's fuzzy default scores subsequences, which is fine for a short menu and
 * useless here: these names are long and share most of their words, so a
 * five-letter query matched a third of the list. Accents matter too — nobody
 * types "Épicos".
 */
export function boardSearchFilter(value: string, search: string): number {
  const needle = fold(search).trim();
  if (!needle) return 1;
  const haystack = fold(value);
  return needle.split(/\s+/).every((term) => haystack.includes(term)) ? 1 : 0;
}
