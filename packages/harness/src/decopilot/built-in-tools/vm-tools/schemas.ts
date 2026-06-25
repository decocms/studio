/**
 * Single source of truth for the six file-op tool schemas — drift between
 * runner implementations becomes a type error, not a silent behavior split.
 */

import { z } from "zod";

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      "File path. Relative paths resolve against the project root (e.g. " +
        "'src/index.ts'); absolute paths are accepted for files outside the " +
        "project (e.g. '/home/sandbox/deck.thumbnail.jpg').",
    ),
  offset: z
    .number()
    .optional()
    .describe("Starting line number for text files (1-based, default 1)"),
  limit: z
    .number()
    .optional()
    .describe("Max lines to return for text files (default 2000)"),
});

export const WriteInputSchema = z.object({
  path: z.string().describe("File path relative to project root"),
  content: z.string().describe("The full file content to write"),
});

export const EditInputSchema = z.object({
  path: z.string().describe("File path relative to project root"),
  old_string: z.string().describe("The exact text to find and replace"),
  new_string: z
    .string()
    .describe("The replacement text (must differ from old_string)"),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace all occurrences (default false)"),
});

export const GrepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search in (default: project root)"),
  glob: z
    .string()
    .optional()
    .describe("Glob pattern to filter files (e.g. '*.ts', '*.{js,jsx}')"),
  context: z.number().optional().describe("Lines of context around matches"),
  ignore_case: z.boolean().optional().describe("Case-insensitive search"),
  output_mode: z
    .enum(["content", "files", "count"])
    .optional()
    .describe("Output mode (default: 'files')"),
  limit: z.number().optional().describe("Max result lines (default 250)"),
});

export const GlobInputSchema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.test.tsx')",
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (default: project root)"),
});

export const BashInputSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (default 30000, max 120000)"),
});

export const SkillInputSchema = z.object({
  id: z
    .string()
    .describe(
      "Skill id from the <available-skills> catalog (e.g. 'core/slides' or " +
        "'home/<name>').",
    ),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type WriteInput = z.infer<typeof WriteInputSchema>;
export type EditInput = z.infer<typeof EditInputSchema>;
export type GrepInput = z.infer<typeof GrepInputSchema>;
export type GlobInput = z.infer<typeof GlobInputSchema>;
export type BashInput = z.infer<typeof BashInputSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;

export const READ_DESCRIPTION =
  "Read a file. For text files, returns content with line numbers (use offset " +
  "and limit for large files). For images (jpeg, png, gif, webp), the image " +
  "is injected into the next turn as a vision input — do NOT describe what " +
  "you 'expect' to see, just call read and look at the next message. Other " +
  "binary formats are not supported; use a format-specific skill " +
  "(e.g. pptx-extract for .pptx).";

export const WRITE_DESCRIPTION =
  "Write content to a file in the VM's project directory. " +
  "Creates parent directories if needed. Overwrites existing files entirely.\n\n" +
  // Every live-preview HTML artifact lives in the org home volume
  // (durable, Library-visible, deck editing).
  "Viewable HTML artifacts get a LIVE PREVIEW in the chat side panel " +
  "and persist in the org's shared folder when written under " +
  "`org/home/` (lowercase-kebab names):\n" +
  "- Presentation decks / slides → `org/home/decks/<name>.html` " +
  "— load the slides skill (`skill({ id: 'core/slides' })`) FIRST " +
  "and create the deck with its CLI.\n" +
  "- Standalone pages (landing pages, brand kits, one-pagers) → " +
  "`org/home/pages/<name>.html` — single self-contained " +
  "HTML file.\n" +
  "HTML written anywhere else will not render a preview.";

export const SKILL_DESCRIPTION =
  "Load a skill's full instructions (its SKILL.md) by id, for the skills " +
  "listed in <available-skills>. Read-only. Call this BEFORE applying a skill, " +
  "then follow its SKILL.md (run its scripts via bash). Do NOT call it for a " +
  "skill whose SKILL.md is already in the conversation.";

export const EDIT_DESCRIPTION =
  "Perform exact string replacement in a file in the VM. " +
  "old_string must be unique in the file unless replace_all is true.";

export const GREP_DESCRIPTION =
  "Search file contents in the VM using ripgrep. " +
  "Supports regex patterns, file type filtering via glob, and context lines.";

export const GLOB_DESCRIPTION =
  "Find files by name pattern in the VM's project directory. " +
  "Uses ripgrep for gitignore-aware matching. Returns relative file paths.";

export const BASH_DESCRIPTION =
  "Execute a shell command in the VM's project directory. " +
  "Working directory is the project root. Timeout default 30s, max 2min.\n\n" +
  "The organization filesystem is mounted at `org/`:\n" +
  "- `org/home/` — the org's shared home folder (editable, " +
  "shared across runs). Organize it " +
  "freely; check it before non-trivial work and record durable facts, " +
  "decisions, and learnings as small markdown files.\n" +
  "- `org/public/<set>/` — curated read-only skill sets, mounted here. Your " +
  "skills are listed in the <available-skills> catalog; load one with the " +
  "`skill` tool before applying it (don't `ls org/public/` to discover them).\n" +
  "- `org/upload/` — files the user attached to this conversation are " +
  "already here; read them directly.\n" +
  "- `org/output/` — write deliverables here; they are shared back to the " +
  "organization under this run's folder.\n\n" +
  "To make a presentation/slides/deck, ALWAYS use the `slides` skill " +
  "(HTML decks with a live editable preview) — load it with " +
  "`skill({ id: 'core/slides' })` first. " +
  "`pptx` is NOT for this: it only reads/inspects existing `.pptx` files, " +
  "and is the right tool only when the user explicitly needs a PowerPoint " +
  "`.pptx` file as input or output.";

// read/grep/glob/skill are non-mutating; write/edit/bash mutate.
export const TOOL_APPROVAL = {
  read: false,
  write: true,
  edit: true,
  grep: false,
  glob: false,
  bash: true,
  skill: false,
} as const;
