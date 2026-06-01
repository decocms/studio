// Not exported — callers pass an object literal; mirrors how cli-store keeps
// CliState internal, which keeps knip's unused-export check clean.
interface ResolveTuiInput {
  /** True when the user passed `--no-tui`. */
  noTui: boolean;
  /** `process.stdout.isTTY` (undefined is treated as non-TTY). */
  isTty: boolean | undefined;
}

/**
 * Whether to render the Ink TUI. Off when `--no-tui` is passed or stdout is
 * not a TTY (CI, pipes). Shared by `serve`, `dev`, and `link`.
 */
export function resolveTui(input: ResolveTuiInput): boolean {
  if (input.noTui) return false;
  return input.isTty === true;
}
