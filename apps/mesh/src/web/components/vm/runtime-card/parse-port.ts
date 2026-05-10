export type ParsePortResult =
  | { ok: true; value: string | null }
  | { ok: false };

export function parsePortInput(raw: string): ParsePortResult {
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  if (!/^\d+$/.test(v)) return { ok: false };
  const n = Number(v);
  if (n < 1 || n > 65535) return { ok: false };
  return { ok: true, value: v };
}
