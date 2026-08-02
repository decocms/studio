import { useState, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check, Lock01 } from "@untitledui/icons";
import { detectSecret, maskSecret, SECRET_REF_RE } from "@/utils/secret-detect";

/** A vaulted `{{secret:name}}` reference — resolved at use, never shown. */
function SecretRefChip({ name }: { name: string }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-1.5 py-0.5 align-baseline font-mono text-xs text-success"
      title="Stored in the vault — resolved at use, never shown"
    >
      <Lock01 className="size-3" />
      {name}
    </span>
  );
}

/** A raw token left in a message — masked, click-to-copy. */
function RedactedChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 align-baseline font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
      title="Hidden token — click to copy"
    >
      {copied ? <Check className="size-3" /> : <Lock01 className="size-3" />}
      {copied ? "copied" : maskSecret(value)}
    </button>
  );
}

/**
 * Renders message text with secret references as vault chips, and (when
 * `redactRaw` is set — user messages only) any raw detected tokens as masked
 * click-to-copy chips, so secrets never appear verbatim in the transcript.
 */
export function SensitiveText({
  text,
  redactRaw,
}: {
  text: string;
  redactRaw: boolean;
}) {
  const nodes: ReactNode[] = [];
  let key = 0;

  const pushPlain = (s: string) => {
    if (!s) return;
    if (!redactRaw) {
      nodes.push(<span key={key++}>{s}</span>);
      return;
    }
    let idx = 0;
    for (;;) {
      const d = detectSecret(s.slice(idx));
      if (!d) break;
      const start = idx + d.start;
      const end = idx + d.end;
      if (start > idx)
        nodes.push(<span key={key++}>{s.slice(idx, start)}</span>);
      nodes.push(<RedactedChip key={key++} value={d.value} />);
      idx = end;
    }
    if (idx < s.length) nodes.push(<span key={key++}>{s.slice(idx)}</span>);
  };

  const re = new RegExp(SECRET_REF_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    nodes.push(<SecretRefChip key={key++} name={m[1] ?? ""} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) pushPlain(text.slice(last));

  return <span className={cn("whitespace-pre-wrap break-words")}>{nodes}</span>;
}

/**
 * Whether `text` needs the sensitive renderer instead of plain Markdown: it
 * carries a vault reference, or (for user input) a raw detected token.
 */
export function hasSensitiveContent(text: string, redactRaw: boolean): boolean {
  if (text.includes("{{secret:")) return true;
  return redactRaw && detectSecret(text) !== null;
}
