/**
 * Workflows Plugin - Client Entry Point
 *
 * Exports the ClientPlugin implementation.
 */

import type { Binder } from "@decocms/bindings";
import type { ClientPlugin } from "@decocms/bindings/plugins";
import { lazy } from "react";
import { PLUGIN_ID, PLUGIN_DESCRIPTION } from "../shared";

// Lazy load the header/empty state components that use UI dependencies
const PluginHeader = lazy(() => import("./components/plugin-header"));
const PluginEmptyState = lazy(() => import("./components/plugin-empty-state"));

/**
 * Workflows Client Plugin Definition
 */
export const clientPlugin: ClientPlugin<Binder> = {
  id: PLUGIN_ID,
  description: PLUGIN_DESCRIPTION,
  renderHeader: (props) => <PluginHeader {...props} />,
  renderEmptyState: () => <PluginEmptyState />,
};
