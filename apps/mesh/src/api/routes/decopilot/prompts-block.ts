export interface PromptsBlockEntry {
  name: string;
  description: string | null;
  arguments: Array<{ name: string; required?: boolean }>;
}

export function buildPromptsBlock(
  _prompts: PromptsBlockEntry[],
): string | null {
  throw new Error("not implemented");
}
