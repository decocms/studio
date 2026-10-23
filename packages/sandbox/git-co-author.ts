export interface CoAuthorIdentity {
  readonly userName: string;
  readonly userEmail?: string;
}

const INVALID_CO_AUTHOR_CHARS = /[\r\n<>]/;
// Dot excluded from both classes: an ambiguous split backtracks polynomially.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;

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

/**
 * An operator plus whether they may author the commit at all. `authorsCommit`
 * is the organization's `commits_authored_by_editor` flag, resolved where the
 * request is served; it is required so that a bare {@link CoAuthorIdentity}
 * cannot pass for one and turn the feature on by accident. False keeps them a
 * co-author and leaves the commit to the account writing it.
 *
 * `operatorId` is their account id, which is how two saves by one person are
 * recognised as one editor — their display name and e-mail are what the
 * trailer shows, not what identifies them.
 */
export interface CommitOperator extends CoAuthorIdentity {
  readonly authorsCommit: boolean;
  readonly operatorId?: string;
}

/** A git author line's two halves. Git has no author without an email. */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/** One editor of a commit, after the duplicates of a batch are folded in. */
interface DistinctEditor {
  identity: CoAuthorIdentity;
  /** The `Co-authored-by:` line this editor would get. */
  line: string;
  /** False when ANY of their saves said they may not author. */
  authors: boolean;
}

/** Fold the operators of a commit into one entry per editor, in arrival order. */
function distinctEditors(
  operators: readonly (CommitOperator | null | undefined)[],
): DistinctEditor[] {
  const byEditor = new Map<string, DistinctEditor>();
  for (const operator of operators) {
    const identity = normalizeCoAuthorIdentity(operator);
    if (!identity || !operator) continue;
    const line = formatCoAuthorLine(identity);
    const key = operator.operatorId ?? line.toLowerCase();
    const seen = byEditor.get(key);
    // The fuller spelling wins: one save may carry an e-mail another lacks.
    const richer = seen && !seen.identity.userEmail && identity.userEmail;
    byEditor.set(key, {
      identity: !seen || richer ? identity : seen.identity,
      line: !seen || richer ? line : seen.line,
      // Conservative on disagreement: an unreadable flag reads as off.
      authors: (seen?.authors ?? true) && operator.authorsCommit === true,
    });
  }
  return [...byEditor.values()];
}

/**
 * How a commit is attributed to the people who made it — the TypeScript twin
 * of the daemon's `gitx.CommitAttribution` for the single-operator case, so a
 * commit written through a provider API attributes like one the daemon runs
 * `git commit` for. (The daemon has no flag: the sandbox always authors.)
 *
 *  - one editor, with a name AND e-mail, and the flag lets them → they are the
 *    git author, and the now-redundant `Co-authored-by:` trailer is dropped.
 *    Only the author changes; the committer stays the caller's own identity.
 *  - several editors → the commit is nobody's alone, so it keeps the writing
 *    account as author and every editor becomes a co-author.
 *  - no usable operator → the message is left exactly as it came.
 */
export function commitAttribution(
  message: string,
  operator:
    | CommitOperator
    | readonly (CommitOperator | null | undefined)[]
    | null
    | undefined,
): { message: string; author: GitAuthor | null } {
  const editors = distinctEditors(
    Array.isArray(operator) ? operator : [operator as CommitOperator],
  );
  const only = editors.length === 1 ? editors[0] : undefined;
  if (only?.authors && only.identity.userEmail) {
    return {
      message: stripCoAuthorTrailers(message),
      author: {
        name: only.identity.userName,
        email: only.identity.userEmail,
      },
    };
  }
  if (editors.length === 0) return { message, author: null };
  // Built in one pass: `appendCoAuthorTrailer` strips on every call, so
  // folding it over the editors would leave only the last one.
  const body = stripCoAuthorTrailers(message).trimEnd();
  const block = editors.map((editor) => editor.line).join("\n");
  return { message: body ? `${body}\n\n${block}` : block, author: null };
}
