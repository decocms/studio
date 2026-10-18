/** Slash commands in the topic composer: `/bounty Port the header` picks a
 *  kind, `/score shop.com` asks deco for a Deco Score. Pure, for its test. */

/** What people type, mapped to the kind (org tag) it means. */
const ALIASES: Record<string, string> = {
  proposal: "Proposal",
  question: "Question",
  ask: "Question",
  announce: "Announcement",
  announcement: "Announcement",
  role: "Role",
  job: "Role",
  vaga: "Role",
  hiring: "Role",
  bounty: "Bounty",
  gig: "Gig",
  freela: "Gig",
  profile: "Profile",
  cv: "Profile",
  help: "Help",
  bug: "Help",
  show: "Show & tell",
};

export interface SlashCommand {
  /** What to type after the slash. */
  command: string;
  /** The kind it picks, or null for `/score`. */
  kind: string | null;
}

/** The commands a channel offers: one per kind it has, then `/score`. */
export function slashCommands(kinds: readonly string[]): SlashCommand[] {
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const [command, kind] of Object.entries(ALIASES)) {
    if (!kinds.includes(kind) || seen.has(kind)) continue;
    seen.add(kind);
    commands.push({ command, kind });
  }
  return [...commands, { command: "score", kind: null }];
}

export type ParsedTitle =
  | { type: "topic"; kind: string | null; title: string }
  | { type: "score"; domain: string };

/** Read a leading command off the title. An unknown command is left in the
 *  title as typed, so nothing someone wrote is ever swallowed. */
export function parseTitle(
  input: string,
  kinds: readonly string[],
): ParsedTitle {
  const match = /^\/(\S+)\s*(.*)$/s.exec(input.trim());
  if (!match) return { type: "topic", kind: null, title: input.trim() };
  const command = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  if (command === "score") return { type: "score", domain: rest };
  const kind = ALIASES[command];
  if (kind && kinds.includes(kind)) return { type: "topic", kind, title: rest };
  return { type: "topic", kind: null, title: input.trim() };
}
