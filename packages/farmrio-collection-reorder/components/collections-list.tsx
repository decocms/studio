import type { FarmrioCollectionItem } from "@decocms/bindings";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { BarChart01, DotsVertical, Plus, SearchMd } from "@untitledui/icons";
import { useState } from "react";

interface CollectionsListProps {
  collections: FarmrioCollectionItem[];
  onSelectCollection: (collection: FarmrioCollectionItem) => void;
  onAddCollection: (input: {
    title: string;
    farmCollectionId: string;
    decoCollectionId?: string;
  }) => Promise<void>;
  onDeleteCollection: (collection: FarmrioCollectionItem) => Promise<void>;
  onToggleCollection: (
    collection: FarmrioCollectionItem,
    isEnabled: boolean,
  ) => Promise<void>;
}

export default function CollectionsList({
  collections,
  onSelectCollection,
  onAddCollection,
  onDeleteCollection,
  onToggleCollection,
}: CollectionsListProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [farmCollectionIdInput, setFarmCollectionIdInput] = useState("");
  const [decoCollectionIdInput, setDecoCollectionIdInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const filtered = collections.filter(
    (c) =>
      !search.trim() ||
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      c.farmCollectionId.includes(search),
  );

  const resetForm = () => {
    setTitle("");
    setFarmCollectionIdInput("");
    setDecoCollectionIdInput("");
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) resetForm();
  };

  const handleCreate = async () => {
    const trimmedTitle = title.trim();
    const trimmedFarmId = farmCollectionIdInput.trim();
    if (!trimmedTitle || !trimmedFarmId) return;
    setIsSubmitting(true);
    try {
      await onAddCollection({
        title: trimmedTitle,
        farmCollectionId: trimmedFarmId,
        decoCollectionId: decoCollectionIdInput.trim() || undefined,
      });
      handleOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (
    collection: FarmrioCollectionItem,
    value: boolean,
  ) => {
    setTogglingId(collection.id);
    try {
      await onToggleCollection(collection, value);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (collection: FarmrioCollectionItem) => {
    setDeletingId(collection.id);
    try {
      await onDeleteCollection(collection);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-border">
        <h1 className="text-xl font-semibold text-foreground">
          PLP Optimizations
        </h1>
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <SearchMd
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search for a PLP..."
              className="pl-9 w-56 h-9 text-sm"
            />
          </div>
          {/* New collection */}
          <Button
            size="sm"
            className="bg-black text-white hover:bg-black/80 font-medium border-none"
            onClick={() => setIsOpen(true)}
          >
            <Plus size={14} className="mr-1" />
            New collection
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {collections.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <BarChart01 size={48} className="text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              Nenhuma collection ainda
            </h3>
            <p className="text-muted-foreground max-w-sm">
              Adicione sua primeira collection para começar a visualizar os
              reports de ranking.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-6 py-3 w-full">
                  Name
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                  Farm ID
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                  Deco ID
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                  Status
                </th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((collection) => (
                <tr
                  key={collection.id}
                  className="border-b border-border hover:bg-muted/40 transition-colors group"
                >
                  <td
                    className="px-6 py-4 cursor-pointer"
                    onClick={() => onSelectCollection(collection)}
                  >
                    <span className="font-medium text-foreground hover:underline">
                      {collection.title}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                      {collection.farmCollectionId}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    {collection.decoCollectionId ? (
                      <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                        {collection.decoCollectionId}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <Switch
                      className="cursor-pointer"
                      checked={collection.isEnabled}
                      disabled={togglingId === collection.id}
                      onCheckedChange={(value) => {
                        void handleToggle(collection, value);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className="px-4 py-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="cursor-pointer opacity-0 group-hover:opacity-100 inline-flex items-center justify-center size-7 rounded hover:bg-muted transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DotsVertical
                            size={16}
                            className="text-muted-foreground"
                          />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          disabled={deletingId === collection.id}
                          onSelect={() => {
                            void handleDelete(collection);
                          }}
                        >
                          {deletingId === collection.id
                            ? "Removendo..."
                            : "Remover collection"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-12 text-center text-muted-foreground text-sm"
                  >
                    Nenhuma collection encontrada para &ldquo;{search}&rdquo;
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Collection Dialog */}
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>
              Configure o nome e os IDs da collection.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Nome da collection (ex: Vestidos)"
            />
            <Input
              value={farmCollectionIdInput}
              onChange={(event) => setFarmCollectionIdInput(event.target.value)}
              placeholder="Farm Collection ID (ex: 1031)"
            />
            <Input
              value={decoCollectionIdInput}
              onChange={(event) => setDecoCollectionIdInput(event.target.value)}
              placeholder="Deco Collection ID (opcional)"
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={
                isSubmitting || !title.trim() || !farmCollectionIdInput.trim()
              }
            >
              {isSubmitting ? "Salvando..." : "Criar collection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
