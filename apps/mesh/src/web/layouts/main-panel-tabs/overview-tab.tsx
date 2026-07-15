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
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  HomeEditProvider,
  useHomeEdit,
} from "@/web/components/home/home-edit-context";
import { HomeGrid } from "@/web/components/home/home-grid";
import { AddTileDrawer } from "@/web/components/home/add-tile-drawer";

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
        Customize
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
        Add tile
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onCancel}
        className="h-8 gap-1.5"
      >
        <X size={14} />
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={!hasChanges}
        className="h-8 gap-1.5"
      >
        <Check size={14} />
        Save
      </Button>
    </div>
  );
}

function OverviewBoard() {
  const { org } = useProjectContext();
  const { isEditMode, enter, save, cancel, hasChanges } = useHomeEdit();
  const [addTileOpen, setAddTileOpen] = useState(false);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold text-foreground">{org.name}</h1>
          <div className="shrink-0">
            <CustomizeToolbar
              isEditMode={isEditMode}
              hasChanges={hasChanges}
              onEnter={enter}
              onSave={save}
              onCancel={cancel}
              onAddTile={() => setAddTileOpen(true)}
            />
          </div>
        </div>
        <HomeGrid isEditMode={isEditMode} />
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
