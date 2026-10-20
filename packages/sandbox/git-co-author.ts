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

/** A git author line's two halves. Git has no author without an email. */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * How a commit is attributed to the operator — the TypeScript twin of the
 * daemon's `gitx.CommitAttribution`, so a commit written through a provider
 * API attributes exactly like one the daemon runs `git commit` for.
 *
 *  - name AND email → they are the git author, and the now-redundant
 *    `Co-authored-by:` trailer is dropped. Only the author changes; the
 *    committer stays the caller's own identity.
 *  - otherwise → no valid author can be formed, so the trailer carries it.
 */
export function commitAttribution(
  message: string,
  operator: CoAuthorIdentity | null | undefined,
): { message: string; author: GitAuthor | null } {
  const normalized = normalizeCoAuthorIdentity(operator);
  if (normalized?.userEmail) {
    return {
      message: stripCoAuthorTrailers(message),
      author: { name: normalized.userName, email: normalized.userEmail },
    };
  }
  return { message: appendCoAuthorTrailer(message, operator), author: null };
}
