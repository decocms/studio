import type { AnyClientPlugin } from "@decocms/bindings/plugins";
import { collectionReorderRankingPlugin } from "farmrio-collection-reorder";
import { objectStoragePlugin } from "mesh-plugin-object-storage";
import { previewPlugin } from "mesh-plugin-preview";
import { clientPlugin as privateRegistryPlugin } from "mesh-plugin-private-registry/client";
import { reportsPlugin } from "mesh-plugin-reports";
import { clientPlugin as userSandboxPlugin } from "mesh-plugin-user-sandbox/client";
import { clientPlugin as workflowsPlugin } from "mesh-plugin-workflows/client";

// Registered plugins
export const sourcePlugins: AnyClientPlugin[] = [
  objectStoragePlugin,
  previewPlugin,
  reportsPlugin,
  collectionReorderRankingPlugin,
  userSandboxPlugin,
  privateRegistryPlugin,
  workflowsPlugin,
];
