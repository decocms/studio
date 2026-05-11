export type ParsePortResult =
  | { ok: true; value: string | null }
  | { ok: false };

export function parsePortInput(raw: string): ParsePortResult {
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  if (!/^\d+$/.test(v)) return { ok: false };
  const n = Number(v);
  if (n < 1 || n > 65535) return { ok: false };
  // Return the canonical decimal form so leading zeros don't survive into
  // `metadata.runtime.port`. Without this, `"03000"` round-trips verbatim
  // and `isRestartRequired`'s strict !== against `startedWith.port = "3000"`
  // fires a permanent "restart to apply" banner that no restart can clear.
  return { ok: true, value: String(n) };
}
