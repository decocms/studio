import { defineTool } from "@/core/define-tool";
import { REGISTRY_ITEM_LIST } from "./list";
import { REGISTRY_ITEM_GET } from "./get";
import { REGISTRY_ITEM_VERSIONS } from "./versions";
import { REGISTRY_ITEM_FILTERS } from "./filters";

export const COLLECTION_REGISTRY_APP_LIST = defineTool({
  ...REGISTRY_ITEM_LIST,
  name: "COLLECTION_REGISTRY_APP_LIST" as const,
});
export const COLLECTION_REGISTRY_APP_GET = defineTool({
  ...REGISTRY_ITEM_GET,
  name: "COLLECTION_REGISTRY_APP_GET" as const,
});
export const COLLECTION_REGISTRY_APP_VERSIONS = defineTool({
  ...REGISTRY_ITEM_VERSIONS,
  name: "COLLECTION_REGISTRY_APP_VERSIONS" as const,
});
export const COLLECTION_REGISTRY_APP_FILTERS = defineTool({
  ...REGISTRY_ITEM_FILTERS,
  name: "COLLECTION_REGISTRY_APP_FILTERS" as const,
});
