export interface CoAuthorIdentity {
  readonly userName: string;
  readonly userEmail?: string;
}

const INVALID_CO_AUTHOR_CHARS = /[\r\n<>]/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeCoAuthorIdentity(
  input:
    | {
        userName?: string | null;
        userEmail?: string | null;
      }
    | null
    | undefined,
): CoAuthorIdentity | null {
  const userName = input?.userName?.trim();
  if (!userName || INVALID_CO_AUTHOR_CHARS.test(userName)) return null;

  const rawEmail = input?.userEmail?.trim();
  if (!rawEmail || INVALID_CO_AUTHOR_CHARS.test(rawEmail)) {
    return { userName };
  }
  if (!EMAIL_RE.test(rawEmail)) return { userName };
  return { userName, userEmail: rawEmail };
}

/** Remove client-supplied co-author trailers before appending a trusted one. */
export function stripCoAuthorTrailers(message: string): string {
  return message
    .split("\n")
    .filter((line) => !/^Co-authored-by:\s/i.test(line))
    .join("\n")
    .trimEnd();
}

function formatCoAuthorLine(identity: CoAuthorIdentity): string {
  const name = identity.userName.trim();
  const email = identity.userEmail?.trim();
  if (email) return `Co-authored-by: ${name} <${email}>`;
  return `Co-authored-by: ${name}`;
}

/** Append a GitHub co-author trailer when the operator is known. Idempotent. */
export function appendCoAuthorTrailer(
  message: string,
  operator: CoAuthorIdentity | null | undefined,
): string {
  const normalized = normalizeCoAuthorIdentity(operator);
  if (!normalized) return message;

  const withoutTrailers = stripCoAuthorTrailers(message);
  const line = formatCoAuthorLine(normalized);
  if (withoutTrailers.includes(line)) return withoutTrailers;

  const trimmed = withoutTrailers.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${line}` : line;
}

/** Append co-author to PR description text; skip when body is empty. */
export function appendCoAuthorToPullRequestBody(
  body: string | undefined,
  operator: CoAuthorIdentity | null | undefined,
): string | undefined {
  const trimmed = body?.trim();
  if (!trimmed) return trimmed || undefined;
  return appendCoAuthorTrailer(trimmed, operator);
}
