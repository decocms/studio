import type { BaseCollectionEntity } from "@decocms/bindings/collections";
import { CollectionCard } from "./collection-card.tsx";
import { CollectionTableWrapper } from "./collection-table-wrapper.tsx";
import { CollectionDisplayButton } from "./collection-display-button.tsx";
import type { CollectionsListProps } from "./types";
import type { TableColumn } from "./collection-table.tsx";
import { EmptyState } from "@deco/ui/components/empty-state.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  DotsVertical,
  Eye,
  Edit01,
  Copy01,
  Trash01,
  Inbox01,
} from "@untitledui/icons";
import type { JsonSchema } from "@/web/utils/constants";
import { IntegrationIcon } from "../integration-icon.tsx";
import { User } from "../user/user.tsx";

// Field names that should be rendered as icon columns
const ICON_FIELD_NAMES = ["icon", "avatar", "logo"];

// Fields that should always appear at the end of the column list
const TRAILING_FIELDS = ["created_at", "created_by", "id"];

// Helper to find icon field by name (case-insensitive)
function findIconFieldByName(
  properties: Record<string, JsonSchema>,
): string | undefined {
  return Object.keys(properties).find((key) =>
    ICON_FIELD_NAMES.includes(key.toLowerCase()),
  );
}

export function CollectionsList<T extends BaseCollectionEntity>({
  data,
  schema,
  viewMode,
  search,
  sortKey,
  sortDirection = "asc",
  onSort = () => {},
  actions = {},
  onItemClick = () => {},
  headerActions = null,
  emptyState = null,
  readOnly = false,
  columns = undefined,
  hideToolbar = false,
  sortableFields = undefined,
}: CollectionsListProps<T>) {
  // Generate sort options from columns or schema
  const sortOptions = columns
    ? columns
        .filter((col) => col.sortable !== false)
        .filter((col) => !sortableFields || sortableFields.includes(col.id))
        .map((col) => ({
          id: col.id,
          label: typeof col.header === "string" ? col.header : col.id,
        }))
    : Object.keys(schema.properties || {})
        .filter(
          (key) =>
            ![
              "id",
              "created_at",
              "updated_at",
              "created_by",
              "updated_by",
            ].includes(key) &&
            (!sortableFields || sortableFields.includes(key)),
        )
        .map((key) => ({
          id: key,
          label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
        }));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header with actions */}
      {!hideToolbar && (
        <div className="shrink-0 w-full border-b border-border h-12">
          <div className="flex items-center gap-3 h-12 px-4">
            <div className="flex items-center gap-2 flex-1">
              {headerActions}
            </div>

            {/* View Mode + Sort Controls */}
            <div className="flex items-center gap-2 shrink-0">
              <CollectionDisplayButton
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={onSort}
                sortOptions={sortOptions}
              />
            </div>
          </div>
        </div>
      )}

      {/* Content: Cards or Table */}
      {viewMode === "cards" ? (
        <div className="flex-1 overflow-auto p-5">
          {data.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              {emptyState || (
                <EmptyState
                  icon={<Inbox01 size={36} className="text-muted-foreground" />}
                  title="No items found"
                  description={
                    search ? "Try adjusting your search" : "No items to display"
                  }
                />
              )}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {data.map((item) => (
                <div
                  key={item.id}
                  onClick={() => onItemClick?.(item)}
                  className="cursor-pointer h-full"
                >
                  <CollectionCard
                    item={item}
                    schema={schema}
                    readOnly={readOnly}
                    actions={actions}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <CollectionTableWrapper
          columns={getTableColumns(columns, schema, sortableFields, actions)}
          data={data}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={onSort}
          onRowClick={onItemClick}
          emptyState={
            emptyState || (
              <EmptyState
                icon={<Inbox01 size={36} className="text-muted-foreground" />}
                title="No items found"
                description={
                  search ? "Try adjusting your search" : "No items to display"
                }
              />
            )
          }
        />
      )}
    </div>
  );
}

// Helper to generate actions column
function generateActionsColumn<T extends BaseCollectionEntity>(
  actions: Record<string, (item: T) => void | Promise<void>>,
): TableColumn<T> {
  return {
    id: "actions",
    header: "",
    render: (row) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={(e) => e.stopPropagation()}
          >
            <DotsVertical size={20} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {actions.open && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                actions.open?.(row);
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
                actions.edit?.(row);
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
                actions.duplicate?.(row);
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
                actions.delete?.(row);
              }}
            >
              <Trash01 size={16} />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
    cellClassName: "w-[60px]",
    sortable: false,
  };
}

// Helper to check if a JSONSchema field is a primitive type (string, number, boolean)
function isPrimitiveType(fieldSchema: JsonSchema): boolean {
  const type = fieldSchema.type;

  if (Array.isArray(type)) {
    return type.every((t) => isPrimitiveType({ type: t }));
  }

  return (
    type === "string" ||
    type === "number" ||
    type === "integer" ||
    type === "boolean" ||
    type === "null"
  );
}

// Helper to generate columns from schema
function generateColumnsFromSchema<T extends BaseCollectionEntity>(
  schema: JsonSchema,
  sortableFields?: string[],
): TableColumn<T>[] {
  const properties = schema.properties || {};

  // Filter out non-primitive types
  const primitiveKeys = Object.keys(properties).filter((key) => {
    const fieldSchema = properties[key];
    return fieldSchema && isPrimitiveType(fieldSchema);
  });

  // Find icon field by name (icon, avatar, logo)
  const iconFieldName = findIconFieldByName(properties);

  // Build ordered column list following priority:
  // 1. Icon field (by name: icon, avatar, logo)
  // 2. title
  // 3. description
  // 4. updated_at
  // 5. updated_by
  // 6. Other columns (alphabetically sorted)
  // 7. Trailing: created_at, created_by, id
  const orderedKeys: string[] = [];
  const usedKeys = new Set<string>();

  // 1. Icon field first (if exists and is primitive)
  if (iconFieldName && primitiveKeys.includes(iconFieldName)) {
    orderedKeys.push(iconFieldName);
    usedKeys.add(iconFieldName);
  }

  // 2-5. Priority fields in order
  const priorityFields = ["title", "description", "updated_at", "updated_by"];
  for (const field of priorityFields) {
    if (primitiveKeys.includes(field) && !usedKeys.has(field)) {
      orderedKeys.push(field);
      usedKeys.add(field);
    }
  }

  // 5. Other columns (alphabetically sorted), excluding trailing fields
  const otherKeys = primitiveKeys
    .filter((key) => !usedKeys.has(key) && !TRAILING_FIELDS.includes(key))
    .sort((a, b) => a.localeCompare(b));
  for (const key of otherKeys) {
    orderedKeys.push(key);
    usedKeys.add(key);
  }

  // 7. Trailing fields in order: created_at, created_by, id
  for (const field of TRAILING_FIELDS) {
    if (primitiveKeys.includes(field) && !usedKeys.has(field)) {
      orderedKeys.push(field);
      usedKeys.add(field);
    }
  }

  // Generate columns
  return orderedKeys.map((key) => {
    const fieldSchema = properties[key];
    const isSortable = sortableFields
      ? sortableFields.includes(key)
      : !["id"].includes(key);

    // Handle icon field (render with IntegrationIcon)
    if (key === iconFieldName) {
      return {
        id: key,
        header: "",
        render: (row) => {
          const val = row[key as keyof T];
          return (
            <IntegrationIcon
              icon={val as string | null | undefined}
              name={row.title}
              size="sm"
              className="shrink-0 shadow-sm"
            />
          );
        },
        sortable: false,
        cellClassName: "w-16 shrink-0",
        wrap: true,
      };
    }

    // Handle description field (CSS truncated to ~50 chars)
    if (key === "description") {
      return {
        id: key,
        header: "Description",
        render: (row) => {
          const val = row[key as keyof T];
          if (val === null || val === undefined) return "—";
          return (
            <span className="block truncate max-w-[50ch]">{String(val)}</span>
          );
        },
        sortable: isSortable,
        cellClassName: "max-w-[50ch]",
      };
    }

    // Handle user fields (created_by, updated_by)
    if (key === "created_by" || key === "updated_by") {
      return {
        id: key,
        header: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
        render: (row) => {
          const val = row[key as keyof T];
          if (!val) return "—";
          return <User id={String(val)} size="xs" />;
        },
        sortable: isSortable,
        cellClassName: "max-w-[250px]",
      };
    }

    // Handle date fields
    if (fieldSchema?.format === "date-time" || key.endsWith("_at")) {
      return {
        id: key,
        header: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
        render: (row) => {
          const val = row[key as keyof T];
          if (!val) return "—";
          return (
            <span className="block truncate max-w-full">
              {new Date(val as string).toLocaleDateString()}
            </span>
          );
        },
        sortable: isSortable,
        cellClassName: "max-w-[200px]",
      };
    }

    // Handle other primitive types
    return {
      id: key,
      header: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
      render: (row) => {
        const val = row[key as keyof T];
        if (val === null || val === undefined) return "—";
        return <span className="block truncate max-w-full">{String(val)}</span>;
      },
      sortable: isSortable,
      cellClassName: "max-w-[200px]",
    };
  });
}

// Helper to get table columns with actions column appended
function getTableColumns<T extends BaseCollectionEntity>(
  columns: TableColumn<T>[] | undefined,
  schema: JsonSchema,
  sortableFields: string[] | undefined,
  actions: Record<string, (item: T) => void | Promise<void>>,
): TableColumn<T>[] {
  const baseColumns =
    columns || generateColumnsFromSchema(schema, sortableFields);

  // Check if actions column already exists
  const hasActionsColumn = baseColumns.some((col) => col.id === "actions");

  if (hasActionsColumn) {
    return baseColumns;
  }

  // Append actions column only if there are any actions available
  const hasActions = Object.keys(actions).length > 0;
  if (hasActions) {
    return [...baseColumns, generateActionsColumn(actions)];
  }
  return baseColumns;
}
