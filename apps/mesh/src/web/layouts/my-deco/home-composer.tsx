/**
 * HomeComposer — start new work from the org-less MY deco home.
 *
 * Pick an org, type a message, submit → it creates a fresh thread in that org
 * and sends the message. We reuse the app's exact new-thread handoff: write the
 * message to sessionStorage keyed by (locator, taskId), then navigate to
 * `/$org/$taskId?autosend=true`. The destination route's `useEnsureTask` creates
 * the thread and the autosend consumer fires the first message on mount — so we
 * need no org-scoped context or ThreadManager here.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { getWellKnownDecopilotVirtualMCP, Locator } from "@decocms/mesh-sdk";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/web/lib/autosend";
import type { TiptapDoc } from "@/web/components/chat/types";
import { OrgIcon } from "@/web/components/header/org-switcher";
import type { MyThreadOrg } from "@/web/hooks/use-my-threads";

function textToDoc(text: string): TiptapDoc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export function HomeComposer({ orgs }: { orgs: MyThreadOrg[] }) {
  const navigate = useNavigate();
  const [selectedOrgId, setSelectedOrgId] = useState(orgs[0]?.id ?? "");
  const [text, setText] = useState("");

  const selectedOrg =
    orgs.find((o) => o.id === selectedOrgId) ?? orgs[0] ?? null;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !selectedOrg) return;

    const taskId = crypto.randomUUID();
    const virtualmcpid = getWellKnownDecopilotVirtualMCP(selectedOrg.id).id;
    const locator = Locator.from({
      org: selectedOrg.id,
      project: selectedOrg.id,
    });

    writeStoredAutosend(sessionStorage, locator, taskId, {
      tiptapDoc: textToDoc(trimmed),
    });

    navigate({
      to: "/$org/$taskId",
      params: { org: selectedOrg.slug, taskId },
      search: { virtualmcpid, autosend: AUTOSEND_QUERY_VALUE },
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
      {/* Org target */}
      {orgs.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Start in</span>
          {orgs.map((org) => {
            const active = org.id === selectedOrg?.id;
            return (
              <button
                key={org.id}
                type="button"
                onClick={() => setSelectedOrgId(org.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-foreground text-background"
                    : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <OrgIcon org={org} size="xs" />
                <span className="truncate max-w-[10rem]">{org.name}</span>
              </button>
            );
          })}
        </div>
      ) : selectedOrg ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Start in</span>
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
            <OrgIcon org={selectedOrg} size="xs" />
            {selectedOrg.name}
          </span>
        </div>
      ) : null}

      {/* Composer */}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={
            selectedOrg
              ? `Message ${selectedOrg.name}…`
              : "Start a conversation…"
          }
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 min-h-[2.5rem] max-h-40"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || !selectedOrg}
          aria-label="Send"
          className={cn(
            "shrink-0 flex items-center justify-center size-8 rounded-lg transition-colors",
            text.trim() && selectedOrg
              ? "bg-foreground text-background hover:bg-foreground/90"
              : "bg-muted text-muted-foreground/50 cursor-not-allowed",
          )}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}
