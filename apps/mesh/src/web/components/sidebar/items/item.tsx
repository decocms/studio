import { SidebarItem } from "@/storage/types";
import { X, File06 } from "@untitledui/icons";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { useNavigate } from "@tanstack/react-router";
import {
  useOrganizationSettings,
  useOrganizationSettingsActions,
} from "@/web/hooks/collections/use-organization-settings";
import { useProjectContext } from "@decocms/mesh-sdk";

interface SidebarItemListItemProps {
  item: SidebarItem;
}

export function SidebarItemListItem({ item }: SidebarItemListItemProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const settings = useOrganizationSettings(org.id);
  const actions = useOrganizationSettingsActions(org.id);

  const handleDelete = async () => {
    const currentItems = settings?.sidebar_items || [];
    const updatedItems = currentItems.filter(
      (sidebarItem) => sidebarItem.url !== item.url,
    );

    await actions.update.mutateAsync({
      sidebar_items: updatedItems,
    });
  };

  const isIconUrl = /^https?:\/\/.+/.test(item.icon);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="w-full pr-2 group/item relative cursor-pointer text-foreground/90 hover:text-foreground"
        onClick={() => {
          navigate({ to: item.url });
        }}
        tooltip={item.title}
      >
        <div className="flex items-center justify-center shrink-0">
          {isIconUrl ? (
            <img
              src={item.icon}
              alt={item.title}
              className="h-4 w-4 rounded object-cover"
            />
          ) : (
            <File06
              size={16}
              className="text-muted-foreground group-hover/item:text-foreground transition-colors"
            />
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col items-start">
          <span className="truncate text-sm w-full capitalize">
            {item.title.toLocaleLowerCase()}
          </span>
        </div>
        <X
          size={16}
          className="text-muted-foreground opacity-0 group-hover/item:opacity-50 hover:opacity-100 cursor-pointer"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleDelete();
          }}
        />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
