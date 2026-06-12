/**
 * CPU profiling status (Bun `--cpu-prof` launch flag).
 *
 * CPU profiling in Bun is a launch flag read at process start — it cannot be
 * toggled from JS once running. Enable it with an env var Bun reads natively:
 *
 *   BUN_OPTIONS="--cpu-prof --cpu-prof-md --cpu-prof-dir=/tmp" bun run ...
 *
 * Bun prepends BUN_OPTIONS to argv, so this works for `dev:server`, the
 * bundled `start`, and the prod `bun run deco` entry alike. The profile is
 * written on process exit (`.cpuprofile` for Chrome DevTools; `--cpu-prof-md`
 * adds a grep/LLM-friendly markdown sibling).
 *
 * This module only *reports* the active config at boot so it's visible in
 * logs, mirroring how heap/event-loop monitors announce themselves.
 */
const CPU_PROF_FLAG = "--cpu-prof";

function activeArgs(): string[] {
  const fromOpts = (process.env.BUN_OPTIONS ?? "").split(/\s+/).filter(Boolean);
  return [...process.argv.slice(1), ...fromOpts];
}

function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === name) return args[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

export function logCpuProfilingStatus(): void {
  const args = activeArgs();

  if (args.includes(CPU_PROF_FLAG)) {
    console.log(
      JSON.stringify({
        msg: "cpu-profiling-active",
        dir: flagValue(args, "--cpu-prof-dir") ?? process.cwd(),
        name: flagValue(args, "--cpu-prof-name"),
        markdown: args.includes("--cpu-prof-md"),
        intervalUs: Number(flagValue(args, "--cpu-prof-interval") ?? 1000),
        note: "profile is written on process exit",
      }),
    );
    return;
  }

  // Bridge the ergonomic gap: someone set the named knob but the launch flag
  // (the only thing that actually enables profiling) is missing. Bun reads
  // --cpu-prof at startup, so we can't turn it on here — point them at the env.
  if (process.env.CPU_PROFILE) {
    console.warn(
      JSON.stringify({
        msg: "cpu-profiling-requested-but-inactive",
        hint: 'CPU profiling is a Bun launch flag. Set BUN_OPTIONS="--cpu-prof --cpu-prof-md --cpu-prof-dir=/tmp" before starting the process.',
      }),
    );
  }
}
