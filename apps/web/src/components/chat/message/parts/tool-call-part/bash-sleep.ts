const SLEEP_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Sum the durations of any `sleep` invocations in a shell command, in ms, or
 * null when there is none. Mirrors coreutils `sleep`: a default `s` suffix plus
 * `m`/`h`/`d`, and multiple args summed together (`sleep 1m 30` = 90s).
 */
export function parseSleepMs(command: string): number | null {
  const re = /(?:^|[\s;&|(])sleep((?:\s+[\d.]+[smhd]?)+)/g;
  let total = 0;
  let found = false;
  for (const match of command.matchAll(re)) {
    for (const arg of match[1]!.trim().split(/\s+/)) {
      const parsed = /^([\d.]+)([smhd]?)$/.exec(arg);
      if (!parsed) continue;
      const value = Number.parseFloat(parsed[1]!);
      if (!Number.isFinite(value)) continue;
      total += value * (SLEEP_UNIT_MS[parsed[2] || "s"] ?? 1000);
      found = true;
    }
  }
  return found ? total : null;
}
