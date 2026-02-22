/**
 * Server Plugins Registry
 *
 * This file registers all server-side plugins.
 * Server plugins provide tools, routes, migrations, and storage factories.
 *
 * IMPORTANT: Only import from plugin /server entry points here
 * to avoid bundling client code into the server.
 */

import type { ServerPlugin } from "@decocms/bindings/server-plugin";
import { serverPlugin as privateRegistryPlugin } from "mesh-plugin-private-registry/server";
import { serverPlugin as siteEditorPlugin } from "mesh-plugin-site-editor/server";
import { serverPlugin as userSandboxPlugin } from "mesh-plugin-user-sandbox/server";
import { serverPlugin as workflowsPlugin } from "mesh-plugin-workflows/server";

/**
 * Registered server plugins.
 * Add new plugins to this array.
 */
export const serverPlugins: ServerPlugin[] = [
  userSandboxPlugin,
  privateRegistryPlugin,
  workflowsPlugin,
  siteEditorPlugin,
];
