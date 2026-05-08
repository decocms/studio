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

export const CopyToSandboxInputSchema = z.object({
  url: z
    .string()
    .describe(
      "Org-scoped storage reference. Accepts a mesh-storage:// URI from " +
        "chat (e.g. mesh-storage://chat-uploads/abc.pdf) or a bare key " +
        "(e.g. chat-uploads/abc.pdf). Arbitrary http(s):// URLs are NOT " +
        "accepted — for public URLs use the bash tool with curl.",
    ),
  target: z
    .string()
    .describe(
      "Destination path on the sandbox FS (relative to project root). " +
        "Parent directories are created as needed.",
    ),
});

export const ShareWithUserInputSchema = z.object({
  source: z
    .string()
    .describe(
      "Path to a file on the sandbox FS to share back to the user. " +
        "Must be a single file (not a directory).",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Filename to surface in the chat UI (default: basename of source). " +
        "Cannot contain slashes.",
    ),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type WriteInput = z.infer<typeof WriteInputSchema>;
export type EditInput = z.infer<typeof EditInputSchema>;
export type GrepInput = z.infer<typeof GrepInputSchema>;
export type GlobInput = z.infer<typeof GlobInputSchema>;
export type BashInput = z.infer<typeof BashInputSchema>;
export type CopyToSandboxInput = z.infer<typeof CopyToSandboxInputSchema>;
export type ShareWithUserInput = z.infer<typeof ShareWithUserInputSchema>;

export const READ_DESCRIPTION =
  "Read a file. For text files, returns content with line numbers (use offset " +
  "and limit for large files). For images (jpeg, png, gif, webp), the image " +
  "is injected into the next turn as a vision input — do NOT describe what " +
  "you 'expect' to see, just call read and look at the next message. Other " +
  "binary formats are not supported; use a format-specific skill " +
  "(e.g. pptx-extract for .pptx).";

export const WRITE_DESCRIPTION =
  "Write content to a file in the VM's project directory. " +
  "Creates parent directories if needed. Overwrites existing files entirely.";

export const EDIT_DESCRIPTION =
  "Perform exact string replacement in a file in the VM. " +
  "old_string must be unique in the file unless replace_all is true.";

export const GREP_DESCRIPTION =
  "Search file contents in the VM using ripgrep. " +
  "Supports regex patterns, file type filtering via glob, and context lines.";

export const GLOB_DESCRIPTION =
  "Find files by name pattern in the VM's project directory. " +
  "Uses ripgrep for gitignore-aware matching. Returns relative file paths.";

export function buildBashDescription(): string {
  return (
    "Execute a shell command in the VM's project directory. " +
    "Working directory is the project root. Timeout default 30s, max 2min.\n\n" +
    "Pre-installed skills live at `/mnt/skills/public/<name>/SKILL.md`. " +
    "Run `ls /mnt/skills/public/` for the index and " +
    "`cat /mnt/skills/public/<name>/SKILL.md` before using one. " +
    "Skills cover common file operations: pptx (PowerPoint), docx (Word), " +
    "xlsx (Excel), pdf, file-reading (router).\n\n" +
    "To bring chat attachments / presigned URLs into the sandbox FS use " +
    "`copy_to_sandbox` (NOT bash + curl). To deliver a file you produced " +
    "back to the user as a download chip, use `share_with_user`."
  );
}

export const COPY_TO_SANDBOX_DESCRIPTION =
  "Copy a chat-attached or org-storage file into the sandbox filesystem " +
  "at `target`. Use this BEFORE running format-specific skills " +
  "(pptx-extract, pdf, docx, ...) on user-uploaded files. Accepts " +
  "mesh-storage:// URIs and bare org-storage keys only — for arbitrary " +
  "public URLs use bash + curl. Bytes stream directly from S3 to the " +
  "sandbox; they do not pass through the model.";

export const SHARE_WITH_USER_DESCRIPTION =
  "Upload a file from the sandbox FS back to the user's chat as a download " +
  "chip on this turn. Use this for artifacts the user should be able to " +
  "save (CSV reports, generated decks, zipped builds, etc). The file " +
  "lands under the current thread's outputs prefix; the UI surfaces it " +
  "automatically when the turn finishes.";

// read/grep/glob are non-mutating; write/edit/bash mutate.
//
// copy_to_sandbox + share_with_user are intentionally NOT approval-gated.
// Both write side effects technically mutate state — copy_to_sandbox
// drops bytes on the sandbox FS (already gated by `safePath`, no escape
// outside `/app`), and share_with_user uploads to a thread-scoped S3
// prefix the user already owns. Gating either would surface an approval
// prompt on the most natural path the model takes for chat artifacts
// (download → process → share), which is high-friction for a flow the
// user just initiated by attaching a file. Reserve approvals for shell
// + project-FS mutation where the blast radius is broader.
export const TOOL_APPROVAL = {
  read: false,
  write: true,
  edit: true,
  grep: false,
  glob: false,
  bash: true,
  copy_to_sandbox: false,
  share_with_user: false,
} as const;
