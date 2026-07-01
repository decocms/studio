/**
 * Shared system-prompt fragment: this environment does NOT support background
 * tasks. The harness must run every command in the foreground and wait for it
 * to finish — do not use `run_in_background` (or `&`, `nohup`, `disown`, etc.)
 * to detach work, and do not rely on background shells / `BashOutput` polling.
 * Backgrounded processes are not tracked and will not be reachable.
 *
 * Shared across CLI harnesses (claude-code, codex) so the guidance stays in one
 * place.
 */
export const NO_BACKGROUND_TASKS_PROMPT = `<important>
Background tasks are NOT supported in this environment. Always run commands in the foreground and wait for them to complete. Do NOT use \`run_in_background\`, background shells, \`&\`, \`nohup\`, or \`disown\` to detach work — backgrounded processes are not tracked and will not be reachable.
</important>`;
