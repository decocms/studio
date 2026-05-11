/**
 * Pure helper that decides whether to surface the "restart required" strip.
 *
 * The strip closes the loop between Settings (which writes
 * `metadata.runtime.{selected,port,path}`) and the running daemon (which
 * captured `vmEntry.startedWith.{packageManager,port,path}` at VM_START
 * time). When ANY of those fields diverge AND the VM is currently running,
 * the user needs to restart for changes to take effect.
 *
 * Legacy entries (created before the schema change) have `startedRuntime
 * === undefined` — we cannot know what they started with, so we never show
 * the banner for them.
 */
export function isRestartRequired(args: {
  liveRuntime: {
    selected: string | null;
    port: string | null;
    path: string | null;
  };
  startedRuntime:
    | {
        packageManager: string | null;
        port: string | null;
        path: string | null;
      }
    | undefined;
  hasEntry: boolean;
  isRunning: boolean;
}): boolean {
  if (!args.hasEntry || !args.isRunning) return false;
  if (args.startedRuntime === undefined) return false; // legacy entry → no banner
  const { liveRuntime, startedRuntime } = args;
  if (
    (liveRuntime.selected ?? null) !== (startedRuntime.packageManager ?? null)
  )
    return true;
  if ((liveRuntime.port ?? null) !== (startedRuntime.port ?? null)) return true;
  if ((liveRuntime.path ?? null) !== (startedRuntime.path ?? null)) return true;
  return false;
}
