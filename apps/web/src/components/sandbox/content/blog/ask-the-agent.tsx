/**
 * Asking the site's agent for something, in words.
 *
 * The buttons on this tab each run one fixed pass. This is the other half: the
 * work nobody wrote a button for, handed to the same agent that owns the
 * specialists, in a sentence. It starts a run and opens the thread it happens
 * in, which is also the only place the steps are visible.
 */

import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT } from "@/i18n/use-t.ts";
import { BlogRunSheet } from "./blog-run-sheet";
import { useBlogRun } from "./use-blog-run";

export function AskTheAgent({
  virtualMcpId,
  disabled,
}: {
  virtualMcpId: string;
  /** No AI provider on the organization — every run would spend nothing. */
  disabled?: boolean;
}) {
  const t = useT();
  const run = useBlogRun(virtualMcpId);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");

  const submit = () => {
    const text = prompt.trim();
    if (!text) return;
    run.start({ prompt: text });
    setPrompt("");
    setOpen(false);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" disabled={disabled}>
            {t("sandbox.blogRun.ask")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 space-y-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("sandbox.blogRun.askPlaceholder")}
            rows={5}
            autoFocus
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={!prompt.trim()}>
              {t("sandbox.blogRun.submit")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <BlogRunSheet
        run={run.watching}
        virtualMcpId={virtualMcpId}
        onClose={run.stopWatching}
      />
    </>
  );
}
