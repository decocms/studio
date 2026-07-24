/**
 * Overview tab — the Super Agent's default main view.
 *
 * There is no bespoke "home" screen anymore: the org landing is just the Super
 * Agent, and the Super Agent opens on this view (its
 * `metadata.ui.layout.defaultMainView = { type: "overview" }`). It's a plain
 * main-panel view like Settings or Automations — any agent could point at it.
 *
 * It hosts the full home tile board: the user decides what lives here. Click
 * Customize to enter edit mode (drag / resize / remove), Add tile to pin an
 * agent's UI or a built-in tile (e.g. recent conversations). Nothing is
 * prescribed — it's whatever the org puts on it.
 */
import { useState } from "react";
import { Check, LayoutAlt04, Plus, X } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  HomeEditProvider,
  useHomeEdit,
} from "@/components/home/home-edit-context";
import { CommerceReportBanner } from "@/components/home/commerce-report-banner";
import { HomeGrid } from "@/components/home/home-grid";
import { AddTileDrawer } from "@/components/home/add-tile-drawer";
import { HomeTasks } from "@/components/home/home-tasks";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

function CustomizeToolbar({
  isEditMode,
  hasChanges,
  onEnter,
  onSave,
  onCancel,
  onAddTile,
}: {
  isEditMode: boolean;
  hasChanges: boolean;
  onEnter: () => void;
  onSave: () => void;
  onCancel: () => void;
  onAddTile: () => void;
}) {
  const t = useT();
  if (!isEditMode) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onEnter}
        className="h-8 gap-1.5 text-muted-foreground"
      >
        <LayoutAlt04 size={14} />
        {t("home.customizeToolbar.label")}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onAddTile}
        className="h-8 gap-1.5"
      >
        <Plus size={14} />
        {t("home.customizeToolbar.addTile")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onCancel}
        className="h-8 gap-1.5"
      >
        <X size={14} />
        {t("home.customizeToolbar.cancel")}
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={!hasChanges}
        className="h-8 gap-1.5"
      >
        <Check size={14} />
        {t("home.customizeToolbar.save")}
      </Button>
    </div>
  );
}

function OverviewBoard() {
  const { isEditMode, enter, save, cancel, hasChanges } = useHomeEdit();
  const [addTileOpen, setAddTileOpen] = useState(false);
  const reportsOnly = useReportsOnly();

  return (
    <div className="h-full overflow-y-auto">
      <div className="@container mx-auto flex max-w-5xl flex-col gap-10 px-6 py-8">
        {/* Fixed top: the agent "resume" (summary + Super Agent icon) and the
            tasks that need attention. Not tiles. The commerce diagnostic
            banner slots between the resume and the task list; it self-hides
            for orgs without the Commerce Discovery connection. */}
        <HomeTasks afterSummary={<CommerceReportBanner />} />
        {/* The metric cards live on the customizable tile board below. */}
        <div className="flex flex-col gap-4">
          {/* Commerce (reports-only) home is curated: no Customize, so the
              default board (metric cards) stays fixed. */}
          {!reportsOnly && (
            <div className="flex justify-end">
              <CustomizeToolbar
                isEditMode={isEditMode}
                hasChanges={hasChanges}
                onEnter={enter}
                onSave={save}
                onCancel={cancel}
                onAddTile={() => setAddTileOpen(true)}
              />
            </div>
          )}
          <HomeGrid isEditMode={isEditMode} />
        </div>
      </div>
      <AddTileDrawer open={addTileOpen} onOpenChange={setAddTileOpen} />
    </div>
  );
}

export function OverviewTab() {
  // The board renders regardless of runtime setup — the tabs are always
  // navigable. The provider-setup prompt lives solely in the chat side panel
  // (side-panel-chat.tsx), so browsing the app is never a dead-end.
  return (
    <HomeEditProvider>
      <OverviewBoard />
    </HomeEditProvider>
  );
}
