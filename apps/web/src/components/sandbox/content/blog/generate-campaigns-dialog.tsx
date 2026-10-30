/**
 * The campaign generation wizard: a starting point, handed to the content
 * track's agent. It reads the store's systems in a chat of its own and writes
 * each campaign as a draft, which reaches the board as it lands.
 */

import { useState } from "react";
import { MAX_PROPOSED_CAMPAIGNS } from "@decocms/shared/blog-campaign";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Stars02 } from "@untitledui/icons";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { TermsInput } from "./blocks/rule-list";
import {
  CAMPAIGN_SEED_KEY_PREFIX,
  type CampaignSeedEntry,
  newCampaignSeedKey,
  scanCampaignSeeds,
} from "./blog-data";

export type CampaignsProposal = StudioToolOutput<"BLOG_CAMPAIGNS_PROPOSE">;

export function GenerateCampaignsDialog({
  open,
  onOpenChange,
  decofile,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decofile: Record<string, unknown>;
  /** The proposal's chat started; its drafts arrive as the agent writes them. */
  onStarted: (proposal: CampaignsProposal) => void;
}) {
  const t = useT();
  const { call } = useStudioTools();

  const [seedKey, setSeedKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(MAX_PROPOSED_CAMPAIGNS);
  const [starting, setStarting] = useState(false);

  const savedSeeds = scanCampaignSeeds(decofile);
  const canRun = prompt.trim().length > 0 && !starting;

  function reset() {
    setSeedKey(null);
    setName("");
    setKeywords([]);
    setPrompt("");
    setCount(MAX_PROPOSED_CAMPAIGNS);
    setStarting(false);
  }

  function close(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /** Load a saved seed into the form, so running it again is one click. */
  function loadSeed(seed: CampaignSeedEntry) {
    setSeedKey(seed.key);
    setName(seed.name);
    setKeywords(seed.keywords);
    setPrompt(seed.prompt);
  }

  async function run() {
    // Minted before the call and kept on failure, so a retry rewrites the same seed.
    const key = seedKey ?? newCampaignSeedKey();
    setSeedKey(key);
    setStarting(true);
    try {
      const proposal = await call("BLOG_CAMPAIGNS_PROPOSE", {
        seed: {
          id: key.slice(CAMPAIGN_SEED_KEY_PREFIX.length),
          name,
          keywords,
          prompt,
        },
        count,
      });
      onStarted(proposal);
      close(false);
    } catch (err) {
      toast.error(
        t("sandbox.campaignGen.failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("sandbox.campaignGen.title")}</DialogTitle>
          <DialogDescription>
            {t("sandbox.campaignGen.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-1">
          {savedSeeds.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t("sandbox.campaignGen.savedSeeds")}</Label>
              <ul className="divide-y overflow-hidden rounded-lg border">
                {savedSeeds.map((seed) => (
                  <li key={seed.key}>
                    <button
                      type="button"
                      onClick={() => loadSeed(seed)}
                      className={cn(
                        "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                        seedKey === seed.key && "bg-muted/60",
                      )}
                    >
                      <span className="truncate font-medium">
                        {seed.name || t("sandbox.campaignGen.untitledSeed")}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {seed.prompt}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="seed-name">
              {t("sandbox.campaignGen.seedNameLabel")}
            </Label>
            <Input
              id="seed-name"
              value={name}
              placeholder={t("sandbox.campaignGen.seedNamePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="seed-prompt">
              {t("sandbox.campaignGen.promptLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.campaignGen.promptHint")}
            </p>
            <Textarea
              id="seed-prompt"
              value={prompt}
              rows={4}
              placeholder={t("sandbox.campaignGen.promptPlaceholder")}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("sandbox.campaignGen.keywordsLabel")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.campaignGen.keywordsHint")}
            </p>
            <TermsInput
              terms={keywords}
              onChange={setKeywords}
              placeholder={t("sandbox.campaignGen.keywordsPlaceholder")}
              removeLabel={t("sandbox.campaignGen.removeKeyword")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="seed-count">
              {t("sandbox.campaignGen.countLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.campaignGen.countHint")}
            </p>
            <Input
              id="seed-count"
              type="number"
              min={1}
              max={MAX_PROPOSED_CAMPAIGNS}
              value={count}
              onChange={(e) =>
                setCount(
                  Math.min(
                    MAX_PROPOSED_CAMPAIGNS,
                    Math.max(1, Number(e.target.value) || 1),
                  ),
                )
              }
              className="w-24"
            />
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t("sandbox.campaignGen.cancel")}
          </Button>
          <Button type="button" disabled={!canRun} onClick={run}>
            {starting ? <Spinner size="xs" /> : <Stars02 size={14} />}
            {t("sandbox.campaignGen.generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
