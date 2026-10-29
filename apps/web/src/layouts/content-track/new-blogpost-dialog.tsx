/**
 * Starting a blogpost: which campaign it belongs to, which site it is written
 * for, and, if the person has one, what they want it to explore. The newsroom
 * brings the hypothesis from there. A campaign can be started right here, by
 * hand or generated, and comes back chosen.
 */

import { useState } from "react";
import { Plus, Stars02 } from "@untitledui/icons";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import type { CatalogSource } from "@/components/sandbox/content/blog/blocks/catalog-source";
import {
  CAMPAIGN_KEY_PREFIX,
  scanCampaigns,
} from "@/components/sandbox/content/blog/blog-data";
import {
  CampaignEditorSheet,
  useCampaignCreate,
} from "@/components/sandbox/content/blog/campaign-create";
import { GenerateCampaignsDialog } from "@/components/sandbox/content/blog/generate-campaigns-dialog";
import { CampaignList } from "@/components/sandbox/content/blog/generate-post-dialog";
import type { BlogState } from "@/components/sandbox/content/blog/use-blog-state";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useT } from "@/i18n/use-t.ts";

export interface NewBlogpost {
  campaignId: string;
  virtualMcpId: string;
  prompt: string;
}

export function NewBlogpostDialog({
  open,
  onOpenChange,
  blog,
  catalog,
  sites,
  siteId,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The organization's blog state: its campaigns, and where a new one is written. */
  blog: BlogState;
  /** The store's catalog, for a new campaign's product pickers. */
  catalog: CatalogSource | null;
  /** The sites a post can be written for. */
  sites: VirtualMCPEntity[];
  /** The site already chosen by the page, in a project's Execute. */
  siteId: string | null;
  pending: boolean;
  onCreate: (blogpost: NewBlogpost) => void;
}) {
  const t = useT();
  const hasAi = useHostedAiProviderKeys().length > 0;
  const { addCampaign, createFromSeed } = useCampaignCreate(blog);
  const [campaignKey, setCampaignKey] = useState("");
  const [pickedSite, setPickedSite] = useState("");
  const [prompt, setPrompt] = useState("");
  /** The campaign started here, open in its editor over the dialog. */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const openCampaigns = scanCampaigns(blog.blocks).filter(
    (campaign) => campaign.status !== "finished",
  );
  const virtualMcpId =
    siteId ?? (sites.length === 1 ? (sites[0]?.id ?? "") : pickedSite);
  // The card reads its campaign from disk, so a campaign still being written waits.
  const ready =
    openCampaigns.some((campaign) => campaign.key === campaignKey) &&
    !!virtualMcpId &&
    !pending &&
    !blog.save.isPending;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setCampaignKey("");
      setPickedSite("");
      setPrompt("");
      setEditingKey(null);
      setGenerating(false);
    }
  };

  const startCampaign = () => {
    const key = addCampaign();
    setCampaignKey(key);
    setEditingKey(key);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("contentTrack.new.title")}</DialogTitle>
          <DialogDescription>
            {t("contentTrack.new.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("contentTrack.new.campaign")}</Label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!hasAi}
                  onClick={() => setGenerating(true)}
                >
                  <Stars02 size={14} />
                  {t("sandbox.campaignGen.open")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={startCampaign}
                >
                  <Plus size={14} />
                  {t("sandbox.campaigns.add")}
                </Button>
              </div>
            </div>
            {openCampaigns.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                {t("contentTrack.new.noCampaigns")}
              </p>
            ) : (
              <CampaignList
                campaigns={openCampaigns}
                chosen={campaignKey}
                onChoose={setCampaignKey}
              />
            )}
          </div>
          {!siteId && sites.length > 1 && (
            <div className="flex flex-col gap-2">
              <Label>{t("contentTrack.new.site")}</Label>
              <Select value={pickedSite} onValueChange={setPickedSite}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("contentTrack.new.sitePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!siteId && sites.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("contentTrack.new.noSites")}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-blogpost-prompt">
              {t("contentTrack.new.explore")}
            </Label>
            <Textarea
              id="new-blogpost-prompt"
              value={prompt}
              maxLength={2000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("contentTrack.new.explorePlaceholder")}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {t("contentTrack.new.cancel")}
          </Button>
          <Button
            variant="brand"
            disabled={!ready}
            onClick={() =>
              onCreate({
                campaignId: campaignKey.slice(CAMPAIGN_KEY_PREFIX.length),
                virtualMcpId,
                prompt: prompt.trim(),
              })
            }
          >
            {t("contentTrack.new.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
      <CampaignEditorSheet
        blockKey={editingKey}
        blog={blog}
        catalog={catalog}
        onClose={() => setEditingKey(null)}
        onRemove={(key) => {
          blog.remove.mutate({ blockKey: key });
          setEditingKey(null);
          setCampaignKey((chosen) => (chosen === key ? "" : chosen));
        }}
      />
      <GenerateCampaignsDialog
        open={generating}
        onOpenChange={setGenerating}
        decofile={blog.blocks}
        hasAi={hasAi}
        onCreate={async (seed, chosen) => {
          const [first] = await createFromSeed(seed, chosen);
          if (first) setCampaignKey(first);
        }}
      />
    </Dialog>
  );
}
