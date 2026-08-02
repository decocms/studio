"use client";

import type { ToolUIPart } from "ai";
import { useState } from "react";
import { Check, Copy01, Key01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { ToolCallShell, LatencyLabel } from "./common.tsx";
import { getEffectiveState, unwrapResult } from "./utils.tsx";

interface ApiKeyCreatePartProps {
  part: ToolUIPart;
  latency?: number;
}

interface ApiKeyCreateResult {
  id: string;
  name: string;
  key: string;
  permissions: Record<string, string[]>;
  expiresAt: string | null;
  createdAt: string;
}

/** The raw key is returned exactly once. Persist a per-tool-call flag so the
 *  modal auto-opens on first render but never again (history revisits keep the
 *  inline card with copy, without re-popping the modal). */
function alreadyRevealed(toolCallId: string): boolean {
  try {
    return sessionStorage.getItem(`api-key-shown:${toolCallId}`) === "1";
  } catch {
    return false;
  }
}

function markRevealed(toolCallId: string): void {
  try {
    sessionStorage.setItem(`api-key-shown:${toolCallId}`, "1");
  } catch {
    // sessionStorage unavailable (private mode / SSR) — the modal just won't
    // suppress on the next mount; harmless.
  }
}

export function ApiKeyCreatePart({ part, latency }: ApiKeyCreatePartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<ApiKeyCreateResult>(part.output);
  const { handleCopy, copied } = useCopy();

  // Initializer runs once per mount — first-ever render for a fresh key opens
  // the modal; a reload of an old thread finds the flag set and stays closed.
  const [open, setOpen] = useState(() =>
    result?.key ? !alreadyRevealed(part.toolCallId) : false,
  );

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<Key01 className="animate-pulse" />}
        title="Creating API key"
        state="loading"
        defaultOpen
      />
    );
  }

  if (state === "approval") {
    return (
      <ToolCallShell icon={<Key01 />} title="Create API key" state="idle" />
    );
  }

  if (state === "error") {
    return (
      <ToolCallShell
        icon={<Key01 />}
        title={
          part.state === "output-denied"
            ? "API key creation cancelled"
            : "Couldn't create API key"
        }
        state="error"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  if (!result?.key) {
    return (
      <ToolCallShell
        icon={<Key01 />}
        title="API key created"
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  const permissionCount = Object.keys(result.permissions ?? {}).length;
  const closeModal = () => {
    markRevealed(part.toolCallId);
    setOpen(false);
  };

  return (
    <>
      <ToolCallShell
        icon={<Key01 className="text-emerald-500" />}
        title={`API key created: ${result.name}`}
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
      <div className="mt-2 overflow-hidden rounded-xl border-[0.5px] border-border bg-card p-3">
        <div className="flex items-start gap-3">
          <div className="size-9 shrink-0 rounded-md bg-muted flex items-center justify-center">
            <Key01 className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">
              {result.name}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {permissionCount} permission{permissionCount === 1 ? "" : "s"}
              {result.expiresAt
                ? ` · expires ${new Date(result.expiresAt).toLocaleDateString()}`
                : " · never expires"}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setOpen(true)}
          >
            Show key
          </Button>
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) closeModal();
          else setOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key01 className="size-4" />
              API key created
            </DialogTitle>
            <DialogDescription>
              This key is shown only once — copy it and store it somewhere safe
              now. It can't be retrieved later.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 min-w-0">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">
                Name
              </span>
              <code className="text-xs font-mono bg-muted rounded-md px-2 py-1.5 truncate">
                {result.name}
              </code>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">
                Key (shown once)
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 text-xs font-mono bg-muted rounded-md px-2 py-1.5 truncate">
                  {result.key}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(result.key)}
                >
                  {copied ? <Check size={13} /> : <Copy01 size={13} />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={closeModal}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
