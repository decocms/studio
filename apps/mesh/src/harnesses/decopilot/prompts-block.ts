/**
 * Builds the <available-prompts> + <prompts-usage> system-prompt block.
 *
 * Returns null when the catalog is empty so the block — and the
 * read_prompt guidance that depends on it — drops out of the prompt
 * entirely.
 */

export interface PromptsBlockEntry {
  name: string;
  description: string | null;
  arguments: Array<{ name: string; required?: boolean }>;
}

const USAGE = `<prompts-usage>
Each prompt is a reusable skill. Load one with read_prompt({ name, arguments }).

WARNING: If a prompt's content already appears anywhere in the conversation
history (e.g. applied via /promptName in the UI), you MUST NOT call read_prompt
for it — the content is already loaded. Follow its instructions directly.
Only call read_prompt for prompts whose content is NOT yet in the conversation.
</prompts-usage>`;

function csvField(s: string | null | undefined): string {
  if (s == null || s === "") return "";
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes(";")
  ) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function buildPromptsBlock(prompts: PromptsBlockEntry[]): string | null {
  if (prompts.length === 0) return null;

  const rows = prompts.map((p) => {
    const args =
      p.arguments.length > 0
        ? p.arguments
            .map((a) => (a.required ? `${a.name} (required)` : a.name))
            .join("; ")
        : "";
    return `${csvField(p.name)},${csvField(p.description ?? "")},${csvField(args)}`;
  });

  return (
    `\n\n<available-prompts>\nname,description,args\n${rows.join("\n")}\n</available-prompts>` +
    `\n\n${USAGE}`
  );
}
