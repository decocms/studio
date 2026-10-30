/**
 * Starting a blogpost: which campaign it belongs to, which site it is written
 * for, and, if the person has one, what they want it to explore. The newsroom
 * brings the hypothesis from there, toward the goal of an approved campaign.
 */

import { useState } from "react";
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
import {
  CAMPAIGN_KEY_PREFIX,
  scanCampaigns,
} from "@/components/sandbox/content/blog/blog-data";
import { CampaignList } from "@/components/sandbox/content/blog/campaign-list";
import type { BlogState } from "@/components/sandbox/content/blog/use-blog-state";
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
  sites,
  siteId,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The organization's blog state, for its campaigns. */
  blog: BlogState;
  /** The sites a post can be written for. */
  sites: VirtualMCPEntity[];
  /** The site already chosen by the page, in a project's Execute. */
  siteId: string | null;
  pending: boolean;
  onCreate: (blogpost: NewBlogpost) => void;
}) {
  const t = useT();
  const [campaignKey, setCampaignKey] = useState("");
  const [pickedSite, setPickedSite] = useState("");
  const [prompt, setPrompt] = useState("");

  const openCampaigns = scanCampaigns(blog.blocks).filter(
    (campaign) => campaign.status === "active",
  );
  const virtualMcpId =
    siteId ?? (sites.length === 1 ? (sites[0]?.id ?? "") : pickedSite);
  const ready =
    openCampaigns.some((campaign) => campaign.key === campaignKey) &&
    !!virtualMcpId &&
    !pending;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setCampaignKey("");
      setPickedSite("");
      setPrompt("");
    }
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
            <Label>{t("contentTrack.new.campaign")}</Label>
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
    </Dialog>
  );
}
