export interface CoAuthorIdentity {
  readonly userName: string;
  readonly userEmail?: string;
}

const CO_AUTHOR_LINE_RE = /^Co-authored-by:\s/m;

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
  if (!operator?.userName?.trim()) return message;
  const line = formatCoAuthorLine(operator);
  if (message.includes(line)) return message;
  if (
    CO_AUTHOR_LINE_RE.test(message) &&
    message.includes(operator.userName.trim())
  ) {
    return message;
  }
  const trimmed = message.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${line}` : line;
}
