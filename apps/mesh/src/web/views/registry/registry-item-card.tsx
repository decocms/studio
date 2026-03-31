import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  CheckVerified02,
  DotsVertical,
  Globe01,
  Trash01,
} from "@untitledui/icons";
import type { RegistryItem } from "@/web/lib/registry/types";

function extractProvider(item: RegistryItem): string {
  const [provider] = item.id.split("/");
  return provider ?? "provider";
}

function extractTags(item: RegistryItem): string[] {
  return item._meta?.["mcp.mesh"]?.tags ?? [];
}

function extractCategories(item: RegistryItem): string[] {
  return item._meta?.["mcp.mesh"]?.categories ?? [];
}

function extractIcon(item: RegistryItem): string | null {
  return item.server?.icons?.[0]?.src ?? null;
}

interface RegistryItemCardProps {
  item: RegistryItem;
  onEdit: (item: RegistryItem) => void;
  onDelete: (item: RegistryItem) => void;
  onToggleVerified: (item: RegistryItem) => void;
  onToggleOfficial: (item: RegistryItem) => void;
}

export function RegistryItemCard({
  item,
  onEdit,
  onDelete,
  onToggleVerified,
  onToggleOfficial,
}: RegistryItemCardProps) {
  const icon = extractIcon(item);
  const isVerified = item._meta?.["mcp.mesh"]?.verified === true;
  const isOfficial = item._meta?.["mcp.mesh"]?.official === true;
  const badges = [...extractTags(item), ...extractCategories(item)];
  const visibleBadges = badges.slice(0, 3);
  const hiddenBadgesCount = Math.max(0, badges.length - visibleBadges.length);

  return (
    <Card className="p-4 gap-4 transition-colors hover:bg-muted/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-10 rounded-lg border border-border bg-muted/20 overflow-hidden shrink-0 flex items-center justify-center">
            {icon ? (
              <img
                src={icon}
                alt={item.title}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <span className="text-xs font-semibold text-muted-foreground">
                {item.title.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{item.title}</p>
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground truncate">
                {extractProvider(item)}
              </p>
              {item.is_public ? (
                <Badge variant="default" className="gap-1">
                  <Globe01 size={10} />
                  Public
                </Badge>
              ) : (
                <Badge variant="secondary">Private</Badge>
              )}
              {isOfficial && (
                <Badge variant="outline" className="gap-1 text-primary">
                  <CheckVerified02 size={10} />
                  Official
                </Badge>
              )}
              {!isOfficial && isVerified && (
                <Badge variant="outline" className="gap-1 text-success">
                  <CheckVerified02 size={10} />
                  Verified
                </Badge>
              )}
            </div>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <DotsVertical size={18} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(item)}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onToggleVerified(item)}>
              {isVerified ? "Unmark as Verified" : "Mark as Verified"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onToggleOfficial(item)}>
              {isOfficial ? "Unmark as Official" : "Mark as Official"}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDelete(item)}
            >
              <Trash01 size={14} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2 min-h-10">
        {item._meta?.["mcp.mesh"]?.short_description ||
          item.description ||
          item.server.description ||
          "No description provided."}
      </p>

      <div className="flex flex-wrap gap-1">
        {visibleBadges.map((badge) => (
          <Badge key={`${item.id}-badge-${badge}`} variant="secondary">
            {badge}
          </Badge>
        ))}
        {hiddenBadgesCount > 0 && (
          <Badge variant="outline">+{hiddenBadgesCount}</Badge>
        )}
      </div>
    </Card>
  );
}
