/**
 * Token/secret detection — used by the chat composer to offer "save this to
 * the vault" before a raw token lands in history. Patterns are ordered
 * specific → generic; the first match wins.
 */

interface SecretPattern {
  kind: string;
  /** Suggested snake_case vault name when this pattern matches. */
  name: string;
  /** Human label for the modal. */
  label: string;
  regex: RegExp;
  /** If set, the secret value is this capture group (else the whole match). */
  group?: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    kind: "anthropic",
    name: "anthropic_api_key",
    label: "Anthropic API key",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    kind: "openrouter",
    name: "openrouter_api_key",
    label: "OpenRouter API key",
    regex: /sk-or-v1-[A-Za-z0-9]{20,}/,
  },
  {
    kind: "openai",
    name: "openai_api_key",
    label: "OpenAI API key",
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  },
  {
    kind: "github",
    name: "github_token",
    label: "GitHub token",
    regex: /github_pat_[A-Za-z0-9_]{20,}/,
  },
  {
    kind: "github",
    name: "github_token",
    label: "GitHub token",
    regex: /gh[pousr]_[A-Za-z0-9]{30,}/,
  },
  {
    kind: "aws",
    name: "aws_access_key_id",
    label: "AWS access key",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    kind: "google",
    name: "google_api_key",
    label: "Google API key",
    regex: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    kind: "slack",
    name: "slack_token",
    label: "Slack token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    kind: "jwt",
    name: "jwt_token",
    label: "JWT",
    regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.+/=-]{8,}/,
  },
  // Labeled assignment: `api_key: "…"`, `TOKEN=…`, `Bearer …` — value is group 1.
  {
    kind: "labeled",
    name: "api_token",
    label: "API token",
    regex:
      /(?:api[_-]?key|token|secret|password|bearer)["']?\s*[:=]?\s*["']?([A-Za-z0-9_\-.]{16,})["']?/i,
    group: 1,
  },
  // Generic high-entropy: long mixed letters+digits string (last resort).
  {
    kind: "generic",
    name: "api_token",
    label: "Token",
    regex:
      /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}\b/,
  },
];

export interface DetectedSecret {
  value: string;
  start: number;
  end: number;
  kind: string;
  label: string;
  suggestedName: string;
}

/** Find the first (highest-priority) secret-like substring in `text`. */
export function detectSecret(text: string): DetectedSecret | null {
  for (const p of SECRET_PATTERNS) {
    const m = p.regex.exec(text);
    if (!m) continue;
    const value = p.group != null ? m[p.group] : m[0];
    if (!value) continue;
    const start = p.group != null ? text.indexOf(value, m.index) : m.index;
    return {
      value,
      start,
      end: start + value.length,
      kind: p.kind,
      label: p.label,
      suggestedName: heuristicSecretName(value),
    };
  }
  return null;
}

/** Best-effort snake_case name from a token's leading characters. */
export function heuristicSecretName(token: string): string {
  const t = token.trim();
  if (t.startsWith("sk-ant-")) return "anthropic_api_key";
  if (t.startsWith("sk-or-")) return "openrouter_api_key";
  if (t.startsWith("sk-")) return "openai_api_key";
  if (t.startsWith("github_pat_") || /^gh[pousr]_/.test(t)) {
    return "github_token";
  }
  if (t.startsWith("AKIA")) return "aws_access_key_id";
  if (t.startsWith("AIza")) return "google_api_key";
  if (t.startsWith("xox")) return "slack_token";
  if (t.startsWith("eyJ")) return "jwt_token";
  return "api_token";
}

// Structured reference the agent sees instead of the raw value. The vault
// resolves it by name at the point of use; the value never enters history.
export const SECRET_REF_RE = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g;

export function secretRef(name: string): string {
  return `{{secret:${name}}}`;
}

/** Mask a token for display: keep a short prefix, blur the rest. */
export function maskSecret(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}${"•".repeat(Math.min(token.length - 4, 16))}`;
}
