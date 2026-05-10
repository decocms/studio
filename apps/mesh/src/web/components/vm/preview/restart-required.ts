/**
 * Pure helper that decides whether to surface the "restart required" strip.
 *
 * The strip closes the loop between Settings (which writes
 * `metadata.runtime.selected`) and the running daemon (which captured
 * `vmEntry.startedWith.packageManager` at VM_START time). When those diverge
 * AND the VM is currently running, the user needs to restart for changes to
 * take effect.
 *
 * Legacy entries (created before the schema change) have `startedPackageManager
 * === undefined` — we cannot know what they started with, so we never show the
 * banner for them.
 */
export function isRestartRequired(args: {
  liveSelected: string | null;
  startedPackageManager: string | null | undefined;
  hasEntry: boolean;
  isRunning: boolean;
}): boolean {
  if (!args.hasEntry || !args.isRunning) return false;
  if (args.startedPackageManager === undefined) return false; // legacy entry → no banner
  return (args.liveSelected ?? null) !== (args.startedPackageManager ?? null);
}
