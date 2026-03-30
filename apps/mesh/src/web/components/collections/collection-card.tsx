import type { JsonSchema } from "@/web/utils/constants";
import { Card } from "@deco/ui/components/card.tsx";
import type { BaseCollectionEntity } from "@decocms/bindings/collections";
import { IntegrationIcon } from "../integration-icon.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { DotsVertical, Eye, Edit01, Copy01, Trash01 } from "@untitledui/icons";

interface CollectionCardProps<T extends BaseCollectionEntity> {
  item: T;
  schema: JsonSchema;
  readOnly?: boolean;
  actions?: Record<string, (item: T) => void | Promise<void>>;
}

function findImageField(schema: JsonSchema, item: unknown): string | undefined {
  const properties = schema.properties || {};

  // 1. Look for string fields with format === "url" or "uri"
  for (const key in properties) {
    const fieldSchema = properties[key];
    if (
      fieldSchema &&
      fieldSchema.type === "string" &&
      (fieldSchema.format === "url" || fieldSchema.format === "uri") &&
      item &&
      typeof item === "object" &&
      key in item &&
      (item as Record<string, unknown>)[key]
    ) {
      return (item as Record<string, string>)[key];
    }
  }

  // 2. Heuristic: Check for common image field names
  const imageFields = [
    "image",
    "img",
    "avatar",
    "icon",
    "logo",
    "thumbnail",
    "cover",
  ];
  for (const field of imageFields) {
    if (
      item &&
      typeof item === "object" &&
      field in item &&
      typeof (item as Record<string, unknown>)[field] === "string"
    ) {
      return (item as Record<string, string>)[field];
    }
  }

  return undefined;
}

export function CollectionCard<T extends BaseCollectionEntity>({
  item,
  schema,
  actions,
}: CollectionCardProps<T>) {
  const iconUrl = findImageField(schema, item);
  const description =
    item &&
    typeof item === "object" &&
    "description" in item &&
    typeof (item as Record<string, unknown>).description === "string"
      ? (item as Record<string, string>).description
      : undefined;

  const hasActions = actions && Object.keys(actions).length > 0;

  return (
    <Card className="cursor-pointer transition-colors hover:bg-accent/50 h-full flex flex-col group relative">
      <div className="flex flex-col gap-4 p-6 flex-1">
        <IntegrationIcon
          icon={iconUrl}
          name={item.title}
          size="md"
          className="shrink-0 shadow-sm"
        />
        <div className="flex flex-col gap-0 flex-1">
          <h3 className="text-base font-medium text-foreground truncate">
            {item.title}
          </h3>
          <p className="text-base text-muted-foreground line-clamp-2">
            {description || "No description"}
          </p>
        </div>
      </div>
      {hasActions && (
        <div
          className="absolute top-6 right-6 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(e) => e.stopPropagation()}
              >
                <DotsVertical size={20} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              {actions.open && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.open?.(item);
                  }}
                >
                  <Eye size={16} />
                  Open
                </DropdownMenuItem>
              )}
              {actions.edit && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.edit?.(item);
                  }}
                >
                  <Edit01 size={16} />
                  Edit
                </DropdownMenuItem>
              )}
              {actions.duplicate && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.duplicate?.(item);
                  }}
                >
                  <Copy01 size={16} />
                  Duplicate
                </DropdownMenuItem>
              )}
              {actions.delete && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.delete?.(item);
                  }}
                >
                  <Trash01 size={16} />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </Card>
  );
}
