/**
 * Parse a `.env`-style blob into `{ KEY: value }`.
 *
 * Accepts:
 *   - `KEY=value` per line
 *   - optional `export ` prefix
 *   - `# ...` comment lines (skipped)
 *   - blank lines (skipped)
 *   - matching single/double quotes around the value (stripped)
 *
 * Throws on the first line that can't be parsed; the message names the
 * 1-based line number and reason so the UI can show it as a toast.
 */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq < 0) {
      throw new Error(`Line ${i + 1}: missing '='`);
    }

    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Line ${i + 1}: invalid key "${key}"`);
    }

    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}
