import { useId } from "react";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Check, Copy01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

export type ConnectClient = "claude-code" | "cursor" | "codex" | "raw";

export function CopySnippet({ label, code }: { label: string; code: string }) {
  const t = useT();
  const { handleCopy, copied } = useCopy();
  const labelId = useId();
  const codeId = useId();

  return (
    /** The whole block is the copy control — clicking the label, the code or
     *  the icon all copy. One button, so there is one accessible name and no
     *  nested interactive element; the icon is decoration inside it. That name
     *  is "Copy" plus the snippet itself, so assistive tech still reads the
     *  command it is about to copy. */
    <button
      type="button"
      onClick={() => handleCopy(code)}
      aria-labelledby={`${labelId} ${codeId}`}
      className="group relative grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg p-3 text-left transition-colors hover:bg-accent focus-ring"
    >
      <span id={labelId} className="sr-only">
        {t("settings.connectClients.copy")}
      </span>
      <span className="min-w-0 truncate font-mono text-2xs leading-none text-muted-foreground">
        {label}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center self-start rounded-md border border-border text-muted-foreground transition-colors",
          copied
            ? "text-success"
            : "group-hover:border-foreground/30 group-hover:text-foreground",
        )}
      >
        {copied ? <Check size={13} /> : <Copy01 size={13} />}
      </span>
      <pre className="overflow-x-auto pt-2 font-mono text-xs leading-relaxed">
        <code id={codeId}>{code}</code>
      </pre>
    </button>
  );
}
